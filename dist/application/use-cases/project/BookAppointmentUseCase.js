"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BookAppointmentUseCase = void 0;
class BookAppointmentUseCase {
    appointmentRepository;
    projectRepository;
    constructor(appointmentRepository, projectRepository) {
        this.appointmentRepository = appointmentRepository;
        this.projectRepository = projectRepository;
    }
    async execute(bookingToken, appointmentId) {
        const project = await this.projectRepository.findByToken(bookingToken);
        if (!project)
            throw new Error("Geçersiz link.");
        if (project.status !== 'AWAITING_APPROVAL')
            throw new Error("Bu proje zaten aktif.");
        const appointment = await this.appointmentRepository.bookAppointment(appointmentId, project.id, project.customerId);
        await this.projectRepository.updateProject(project.id, {
            status: 'ACTIVE',
            startDate: appointment.startTime
        });
        return { message: "Randevunuz başarıyla oluşturuldu.", appointment };
    }
}
exports.BookAppointmentUseCase = BookAppointmentUseCase;
//# sourceMappingURL=BookAppointmentUseCase.js.map