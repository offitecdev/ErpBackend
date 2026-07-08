import { IAppointmentRepository } from "../../../domain/repositories/IAppointmentRepository";
import { IProjectRepository } from "../../../domain/repositories/IProjectRepository";

export class GetAvailableAppointmentsUseCase {
    constructor(
        private appointmentRepository: IAppointmentRepository,
        private projectRepository: IProjectRepository
    ) {}

    async execute(bookingToken: string, startDateStr: string, endDateStr: string) {
        const project = await this.projectRepository.findByToken(bookingToken);
        if (!project) throw new Error("Geçersiz veya süresi dolmuş randevu linki.");

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
                mode: 'book' as const,
                projectName: project.projectName,
                availableSlots,
                scheduledAppointments: [],
            };
        }

        // The installations are already scheduled (project active/completed): show them
        // read-only, with details and technician names, instead of erroring.
        const scheduledAppointments = await this.appointmentRepository.getScheduledAppointmentsByProject(project.id);
        return {
            mode: 'scheduled' as const,
            projectName: project.projectName,
            availableSlots: [],
            scheduledAppointments,
        };
    }
}
