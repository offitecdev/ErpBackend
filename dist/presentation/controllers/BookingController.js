"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BookingController = void 0;
class BookingController {
    getAvailableAppointmentsUseCase;
    bookAppointmentUseCase;
    appointmentRepository;
    constructor(getAvailableAppointmentsUseCase, bookAppointmentUseCase, appointmentRepository) {
        this.getAvailableAppointmentsUseCase = getAvailableAppointmentsUseCase;
        this.bookAppointmentUseCase = bookAppointmentUseCase;
        this.appointmentRepository = appointmentRepository;
    }
    // Müşteri takvim ekranını açtığında boş saatleri getirir
    async getAvailableSlots(req, res) {
        try {
            const { token, startDate, endDate } = req.query;
            if (!token || !startDate || !endDate) {
                return res.status(400).json({ error: "Token, startDate ve endDate zorunludur." });
            }
            const result = await this.getAvailableAppointmentsUseCase.execute(token, startDate, endDate);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // Müşteri bir saate tıkladığında o saati kapatır ve projeyi aktif eder
    async bookSlot(req, res) {
        try {
            const { token, appointmentId } = req.body;
            if (!token || !appointmentId) {
                return res.status(400).json({ error: "Token ve Randevu ID zorunludur." });
            }
            const result = await this.bookAppointmentUseCase.execute(token, appointmentId);
            res.status(200).json(result);
        }
        catch (error) {
            // Çakışma (başka müşteri aldıysa) hatası buraya düşer
            res.status(409).json({ error: error.message });
        }
    }
    // Yöneticinin sisteme boş saat (slot) eklemesi (Bu auth gerektirir)
    async createAdminSlots(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const slots = req.body.slots; // [{ startTime, endTime }, ...]
            const slotsToInsert = slots.map((s) => ({
                id: require('nanoid').nanoid(10),
                tenantId: tenantId,
                startTime: new Date(s.startTime),
                endTime: new Date(s.endTime),
                status: 'AVAILABLE'
            }));
            await this.appointmentRepository.createAvailableSlots(slotsToInsert);
            res.status(201).json({ message: "Müsait saatler eklendi." });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.BookingController = BookingController;
//# sourceMappingURL=BookingController.js.map