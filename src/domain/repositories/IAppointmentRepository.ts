import { Appointment } from "../entities/Project";

export interface IAppointmentRepository {
    createAvailableSlots(slots: Partial<Appointment>[]): Promise<void>;
    getAvailableAppointments(tenantId: string, startDate: Date, endDate: Date): Promise<Appointment[]>;
    bookAppointment(appointmentId: string, projectId: string, customerId: string): Promise<Appointment>;
    getAppointmentsByProject(projectId: string): Promise<Appointment[]>;
    /** A project's non-cancelled appointments (scheduled installations) with technician info, for the public link. */
    getScheduledAppointmentsByProject(projectId: string): Promise<any[]>;
}