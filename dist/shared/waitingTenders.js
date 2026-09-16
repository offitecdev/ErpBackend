"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadWaitingTenders = void 0;
const prisma_client_1 = __importDefault(require("../infrastructure/database/prisma.client"));
const loadWaitingTenders = async (projectId, tenantId) => {
    const tenders = await prisma_client_1.default.tender.findMany({
        where: {
            tenantId,
            revertedProjectId: projectId,
            cancelledAt: null,
            salesOrder: { is: null },
        },
        select: {
            id: true,
            tenderNumber: true,
            version: true,
            revertedOrderNumber: true,
            revertedAt: true,
            revertedById: true,
        },
        orderBy: { revertedAt: 'desc' },
    });
    if (!tenders.length)
        return [];
    const employeeIds = [...new Set(tenders.map((row) => row.revertedById).filter(Boolean))];
    const [employees, parked] = await Promise.all([
        employeeIds.length
            ? prisma_client_1.default.employee.findMany({
                where: { id: { in: employeeIds } },
                select: { id: true, firstName: true, lastName: true },
            })
            : Promise.resolve([]),
        prisma_client_1.default.appointment.groupBy({
            by: ['detachedFromTenderId'],
            where: {
                tenantId,
                projectId,
                detachedFromTenderId: { in: tenders.map((row) => row.id) },
                startTime: { gte: new Date() },
                NOT: { status: 'CANCELLED' },
            },
            _count: { _all: true },
        }),
    ]);
    const nameOf = new Map(employees.map((row) => [row.id, `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim()]));
    const parkedOf = new Map(parked.map((row) => [row.detachedFromTenderId, Number(row._count?._all ?? 0)]));
    return tenders.map((row) => ({
        id: row.id,
        tenderNumber: row.tenderNumber,
        version: Number(row.version ?? 1),
        revertedOrderNumber: row.revertedOrderNumber ?? null,
        revertedAt: row.revertedAt ?? null,
        revertedBy: row.revertedById ? nameOf.get(row.revertedById) || null : null,
        parkedAppointmentCount: parkedOf.get(row.id) ?? 0,
    }));
};
exports.loadWaitingTenders = loadWaitingTenders;
//# sourceMappingURL=waitingTenders.js.map