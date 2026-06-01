import { Request, Response } from 'express';
import { GetAvailableAppointmentsUseCase } from '../../application/use-cases/project/GetAvailableAppointmentsUseCase';
import { BookAppointmentUseCase } from '../../application/use-cases/project/BookAppointmentUseCase';
import { AppointmentRepository } from '../../infrastructure/repositories/AppointmentRepository';

export class BookingController {
    constructor(
        private getAvailableAppointmentsUseCase: GetAvailableAppointmentsUseCase,
        private bookAppointmentUseCase: BookAppointmentUseCase,
        private appointmentRepository: AppointmentRepository
    ) {}

    // Müşteri takvim ekranını açtığında boş saatleri getirir
    async getAvailableSlots(req: Request, res: Response) {
        try {
            const { token, startDate, endDate } = req.query;
            if (!token || !startDate || !endDate) {
                return res.status(400).json({ error: "Token, startDate ve endDate zorunludur." });
            }

            const result = await this.getAvailableAppointmentsUseCase.execute(
                token as string,
                startDate as string,
                endDate as string
            );
            res.status(200).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // Müşteri bir saate tıkladığında o saati kapatır ve projeyi aktif eder
    async bookSlot(req: Request, res: Response) {
        try {
            const { token, appointmentId } = req.body;
            if (!token || !appointmentId) {
                return res.status(400).json({ error: "Token ve Randevu ID zorunludur." });
            }

            const result = await this.bookAppointmentUseCase.execute(token, appointmentId);
            res.status(200).json(result);
        } catch (error: any) {
            // Çakışma (başka müşteri aldıysa) hatası buraya düşer
            res.status(409).json({ error: error.message });
        }
    }

    // Yöneticinin sisteme boş saat (slot) eklemesi (Bu auth gerektirir)
    async createAdminSlots(req: Request, res: Response) {
        try {
            const tenantId = (req as any).user!.tenantId;
            const slots = req.body.slots; // [{ startTime, endTime }, ...]
            
            const slotsToInsert = slots.map((s: any) => ({
                id: require('nanoid').nanoid(10),
                tenantId: tenantId,
                startTime: new Date(s.startTime),
                endTime: new Date(s.endTime),
                status: 'AVAILABLE'
            }));

            await this.appointmentRepository.createAvailableSlots(slotsToInsert);
            res.status(201).json({ message: "Müsait saatler eklendi." });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}