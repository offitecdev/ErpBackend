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
        // Only a genuinely cancelled project makes the link dead.
        if (project.status === 'CANCELLED') {
            throw new Error("Bu projeye ait randevu linki artık geçerli değil.");
        }
        // Still waiting for the customer to pick a slot: keep the original booking flow.
        if (project.status === 'AWAITING_APPROVAL') {
            const start = new Date(startDateStr);
            const end = new Date(endDateStr);
            const availableSlots = await this.appointmentRepository.getAvailableAppointments(project.tenantId, start, end);
            return {
                mode: 'book',
                projectName: project.projectName,
                availableSlots,
                scheduledAppointments: [],
            };
        }
        // The installations are already scheduled (project active/completed): show them
        // read-only, with details and technician names, instead of erroring.
        const scheduledAppointments = await this.appointmentRepository.getScheduledAppointmentsByProject(project.id);
        return {
            mode: 'scheduled',
            projectName: project.projectName,
            availableSlots: [],
            scheduledAppointments,
        };
    }
}
exports.GetAvailableAppointmentsUseCase = GetAvailableAppointmentsUseCase;
//# sourceMappingURL=GetAvailableAppointmentsUseCase.js.map