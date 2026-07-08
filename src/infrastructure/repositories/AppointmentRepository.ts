import prisma from "../database/prisma.client";

export class AppointmentRepository {
    
    async getAvailableAppointments(tenantId: string, startDate: Date, endDate: Date) {
        return await prisma.appointment.findMany({
            where: {
                tenantId,
                status: 'AVAILABLE',
                startTime: { gte: startDate },
                endTime: { lte: endDate }
            },
            orderBy: { startTime: 'asc' }
        });
    }

    async bookAppointment(appointmentId: string, projectId: string, customerId: string) {
        return await prisma.$transaction(async (tx) => {
            const appointment = await tx.appointment.findUnique({
                where: { id: appointmentId }
            });

            if (!appointment || appointment.status !== 'AVAILABLE') {
                throw new Error("Maalesef bu saat dilimi başka bir müşteri tarafından rezerve edilmiş. Lütfen başka bir saat seçin.");
            }

            const booked = await tx.appointment.update({
                where: { id: appointmentId },
                data: {
                    status: 'BOOKED',
                    projectId: projectId,
                    customerId: customerId
                }
            });

            return booked;
        });
    }

    async createAvailableSlots(slots: any[]) {
        await prisma.appointment.createMany({
            data: slots
        });
    }

    async getAppointmentsByProject(projectId: string) {
        return await prisma.appointment.findMany({
            where: { projectId: projectId }
        }) as any;
    }

    // The project's actual scheduled installations (everything except cancelled),
    // with the assigned/collaborating technicians resolved so the public booking
    // link can present them to the customer read-only.
    async getScheduledAppointmentsByProject(projectId: string) {
        return await prisma.appointment.findMany({
            where: { projectId, status: { not: 'CANCELLED' } },
            orderBy: { startTime: 'asc' },
            include: {
                assignedTechnician: { select: { id: true, firstName: true, lastName: true } },
                technicianAssignments: {
                    include: { technician: { select: { id: true, firstName: true, lastName: true } } },
                },
            },
        }) as any;
    }
}