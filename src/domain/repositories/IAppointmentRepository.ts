import { Appointment } from "../entities/Project";

export interface IAppointmentRepository {
    createAvailableSlots(slots: Partial<Appointment>[]): Promise<void>;
    getAvailableAppointments(tenantId: string, startDate: Date, endDate: Date): Promise<Appointment[]>;
    bookAppointment(appointmentId: string, projectId: string, customerId: string): Promise<Appointment>;
    getAppointmentsByProject(projectId: string): Promise<Appointment[]>;
}