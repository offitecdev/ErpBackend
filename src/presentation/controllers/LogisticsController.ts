
import { Request, Response } from 'express';
import { CreateShipmentUseCase } from '../../application/use-cases/logistics/CreateShipmentUseCase';
import { UpdateShipmentUseCase } from '../../application/use-cases/logistics/UpdateShipmentUseCase';
import { CheckDelayedShipmentsUseCase } from '../../application/use-cases/logistics/CheckDelayedShipmentsUseCase';
import { IShipmentRepository } from '../../domain/repositories/IShipmentRepository';

export class LogisticsController {
    constructor(
        private createShipmentUseCase: CreateShipmentUseCase,
        private updateShipmentUseCase: UpdateShipmentUseCase,
        private checkDelayedShipmentsUseCase: CheckDelayedShipmentsUseCase,
        private shipmentRepository: IShipmentRepository
    ) {}

    async create(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const data = { ...req.body, tenantId };

            if (data.shipmentDate) data.shipmentDate = new Date(data.shipmentDate);
            if (data.eta) data.eta = new Date(data.eta);

            const result = await this.createShipmentUseCase.execute(data);
            res.status(201).json({ message: "Sevkiyat kaydı başarıyla oluşturuldu.", data: result });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async update(req: Request, res: Response) {
        try {
            const id = req.params.id as string;
            const tenantId = (req as any).user!.tenantId;
            const data = { ...req.body };

            if (data.shipmentDate) data.shipmentDate = new Date(data.shipmentDate);
            if (data.eta) data.eta = new Date(data.eta);

            const result = await this.updateShipmentUseCase.execute(id, data, tenantId);
            res.status(200).json({ message: "Sevkiyat kaydı güncellendi.", data: result });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async list(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const filter: any = { tenantId };

            if (req.query.customerId) filter.customerId = req.query.customerId;
            if (req.query.projectId) filter.projectId = req.query.projectId;
            if (req.query.status) filter.status = req.query.status;
            if (req.query.search) filter.search = req.query.search;

            const shipments = await this.shipmentRepository.findAll(filter);

            const now = new Date().getTime();
            const enrichedShipments = shipments.map(s => {
                const etaTime = s.eta ? new Date(s.eta).getTime() : null;
                const isEtaPassed = etaTime ? etaTime < now : false;
                const needsWarning = isEtaPassed && (s.status === 'UNPAID' || s.status === 'DELAYED');

                return {
                    ...s,
                    etaWarning: needsWarning
                };
            });

            res.status(200).json(enrichedShipments);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getById(req: Request, res: Response) {
        try {
            const id = req.params.id as string;
            const tenantId = (req as any).user!.tenantId;

            const shipment = await this.shipmentRepository.findById(id);
            if (!shipment || shipment.tenantId !== tenantId) {
                return res.status(404).json({ error: "Sevkiyat kaydı bulunamadı." });
            }

            res.status(200).json(shipment);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async delete(req: Request, res: Response) {
        try {
            const id = req.params.id as string;
            const tenantId = (req as any).user!.tenantId;

            const shipment = await this.shipmentRepository.findById(id);
            if (!shipment || shipment.tenantId !== tenantId) {
                return res.status(404).json({ error: "Sevkiyat kaydı bulunamadı." });
            }

            await this.shipmentRepository.delete(id);
            res.status(200).json({ message: "Sevkiyat kaydı silindi." });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async autoCheckDelayed(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const updatedCount = await this.checkDelayedShipmentsUseCase.execute(tenantId);
            
            res.status(200).json({ 
                message: "ETA kontrolü yapıldı.", 
                updatedCount: updatedCount,
                detail: `${updatedCount} adet teslimat 'Gecikti' statüsüne alındı.`
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}