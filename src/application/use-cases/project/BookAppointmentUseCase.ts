import { IAppointmentRepository } from "../../../domain/repositories/IAppointmentRepository";
import { IProjectRepository } from "../../../domain/repositories/IProjectRepository";

export class BookAppointmentUseCase {
    
    constructor(
        private appointmentRepository: IAppointmentRepository,
        private projectRepository: IProjectRepository
    ) {}

    async execute(bookingToken: string, appointmentId: string) {
        const project = await this.projectRepository.findByToken(bookingToken);
        if (!project) throw new Error("Geçersiz link.");
        if (project.status !== 'AWAITING_APPROVAL') throw new Error("Bu proje zaten aktif.");

        const appointment = await this.appointmentRepository.bookAppointment(
            appointmentId, 
            project.id, 
            project.customerId
        );

        await this.projectRepository.updateProject(project.id, {
            status: 'ACTIVE',
            startDate: appointment.startTime 
        });

        return { message: "Randevunuz başarıyla oluşturuldu.", appointment };
    }
}