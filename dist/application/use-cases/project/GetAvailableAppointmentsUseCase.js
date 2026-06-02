"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GetAvailableAppointmentsUseCase = void 0;
class GetAvailableAppointmentsUseCase {
    appointmentRepository;
    projectRepository;
    constructor(appointmentRepository, projectRepository) {
        this.appointmentRepository = appointmentRepository;
        this.projectRepository = projectRepository;
    }
    async execute(bookingToken, startDateStr, endDateStr) {
        const project = await this.projectRepository.findByToken(bookingToken);
        if (!project)
            throw new Error("Geçersiz veya süresi dolmuş randevu linki.");
        if (project.status !== 'AWAITING_APPROVAL') {
            throw new Error("Bu proje için zaten randevu alınmış veya proje iptal edilmiş.");
        }
        const start = new Date(startDateStr);
        const end = new Date(endDateStr);
        const availableSlots = await this.appointmentRepository.getAvailableAppointments(project.tenantId, start, end);
        return {
            projectName: project.projectName,
            availableSlots
        };
    }
}
exports.GetAvailableAppointmentsUseCase = GetAvailableAppointmentsUseCase;
//# sourceMappingURL=GetAvailableAppointmentsUseCase.js.map