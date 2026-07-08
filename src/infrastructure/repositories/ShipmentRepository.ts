
import prisma from "../database/prisma.client";
import { IShipmentRepository, IShipmentFilter } from "../../domain/repositories/IShipmentRepository";
import { Shipment, ShipmentStatus } from "../../domain/entities/Logistics";
import { nanoid } from "nanoid";

export class ShipmentRepository implements IShipmentRepository {
    
    private mapToEntity(data: any): Shipment {
        return new Shipment(
            data.id, data.tenantId, data.customerId, data.status as ShipmentStatus,
            data.foNumber, data.cmrNumber, data.awNumber, data.projectId,
            data.carrierCompany, data.productDescription, data.quantity, data.unit,
            data.grossWeight, data.netWeight, data.dimensions, data.extraNotes,
            data.shipmentDate, data.eta, data.invoiceUrl,
            Boolean(data.autoMarkDelayed), data.requireInvoiceForPaid !== false,
            data.createdAt, data.updatedAt
        );
    }

    async create(data: Partial<Shipment>): Promise<Shipment> {
        const created = await prisma.shipment.create({
            data: {
                id: data.id || nanoid(10),
                tenantId: data.tenantId!,
                customerId: data.customerId!,
                projectId: data.projectId || null,
                status: data.status || 'UNPAID',
                foNumber: data.foNumber || null,
                cmrNumber: data.cmrNumber || null,
                awNumber: data.awNumber || null,
                carrierCompany: data.carrierCompany || null,
                productDescription: data.productDescription || null,
                quantity: data.quantity || null,
                unit: data.unit || null,
                grossWeight: data.grossWeight || null,
                netWeight: data.netWeight || null,
                dimensions: data.dimensions || null,
                extraNotes: data.extraNotes || null,
                shipmentDate: data.shipmentDate || null,
                eta: data.eta || null,
                invoiceUrl: data.invoiceUrl || null,
                autoMarkDelayed: data.autoMarkDelayed ?? false,
                requireInvoiceForPaid: data.requireInvoiceForPaid ?? true,
            }
        });
        return this.mapToEntity(created);
    }

    async update(id: string, data: Partial<Shipment>): Promise<Shipment> {
        const updated = await prisma.shipment.update({
            where: { id },
            data: data as any
        });
        return this.mapToEntity(updated);
    }

    async markManyDelayed(ids: string[]): Promise<number> {
        if (ids.length === 0) return 0;
        const result = await prisma.shipment.updateMany({
            where: { id: { in: ids } },
            data: { status: 'DELAYED' },
        });
        return result.count;
    }

    async findById(id: string): Promise<Shipment | null> {
        const data = await prisma.shipment.findUnique({
            where: { id },
            include: {
                customer: { select: { companyName: true, mainEmail: true } },
                project: { select: { projectName: true } }
            }
        });
        return data ? this.mapToEntity(data) : null;
    }

    async findAll(filter: IShipmentFilter): Promise<any[]> {
        const where: any = { tenantId: filter.tenantId };

        if (filter.customerId) where.customerId = filter.customerId;
        if (filter.projectId) where.projectId = filter.projectId;
        if (filter.status) where.status = filter.status;
        
        if (filter.search) {
            where.OR = [
                { foNumber: { contains: filter.search } },
                { cmrNumber: { contains: filter.search } },
                { awNumber: { contains: filter.search } },
                { carrierCompany: { contains: filter.search } },
                { productDescription: { contains: filter.search } },
            ];
        }

        if (filter.isEtaPassed) {
            where.eta = { lt: new Date() };
            where.status = { notIn: ['PAID', 'CANCELLED'] };
        }

        const list = await prisma.shipment.findMany({
            where,
            include: {
                customer: { select: { companyName: true } },
                project: { select: { projectName: true } }
            },
            orderBy: { createdAt: 'desc' }
        });

        return list;
    }

    async delete(id: string): Promise<void> {
        await prisma.shipment.delete({ where: { id } });
    }

    async findByDocumentNumber(tenantId: string, docType: 'foNumber' | 'cmrNumber' | 'awNumber', number: string, excludeId?: string): Promise<Shipment | null> {
        const where: any = { tenantId, [docType]: number };
        if (excludeId) {
            where.id = { not: excludeId };
        }
        const data = await prisma.shipment.findFirst({ where });
        return data ? this.mapToEntity(data) : null;
    }
}
