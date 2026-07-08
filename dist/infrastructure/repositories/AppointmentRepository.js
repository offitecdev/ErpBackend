"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppointmentRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
class AppointmentRepository {
    async getAvailableAppointments(tenantId, startDate, endDate) {
        return await prisma_client_1.default.appointment.findMany({
            where: {
                tenantId,
                status: 'AVAILABLE',
                startTime: { gte: startDate },
                endTime: { lte: endDate }
            },
            orderBy: { startTime: 'asc' }
        });
    }
    async bookAppointment(appointmentId, projectId, customerId) {
        return await prisma_client_1.default.$transaction(async (tx) => {
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
    async createAvailableSlots(slots) {
        await prisma_client_1.default.appointment.createMany({
            data: slots
        });
    }
    async getAppointmentsByProject(projectId) {
        return await prisma_client_1.default.appointment.findMany({
            where: { projectId: projectId }
        });
    }
    // The project's actual scheduled installations (everything except cancelled),
    // with the assigned/collaborating technicians resolved so the public booking
    // link can present them to the customer read-only.
    async getScheduledAppointmentsByProject(projectId) {
        return await prisma_client_1.default.appointment.findMany({
            where: { projectId, status: { not: 'CANCELLED' } },
            orderBy: { startTime: 'asc' },
            include: {
                assignedTechnician: { select: { id: true, firstName: true, lastName: true } },
                technicianAssignments: {
                    include: { technician: { select: { id: true, firstName: true, lastName: true } } },
                },
            },
        });
    }
}
exports.AppointmentRepository = AppointmentRepository;
//# sourceMappingURL=AppointmentRepository.js.map