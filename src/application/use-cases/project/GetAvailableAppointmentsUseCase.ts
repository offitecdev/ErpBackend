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