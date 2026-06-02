"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenderActivityLogRepository = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
class TenderActivityLogRepository {
    async create(log) {
        return await prisma_client_1.default.tenderActivityLog.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId: log.tenantId,
                tenderId: log.tenderId,
                positionId: log.positionId ?? null,
                mappingId: log.mappingId ?? null,
                articleId: log.articleId ?? null,
                employeeId: log.employeeId,
                actionType: log.actionType,
                fieldName: log.fieldName ?? null,
                oldValue: log.oldValue ?? null,
                newValue: log.newValue ?? null,
                description: log.description ?? null,
            }
        });
    }
    async createMany(logs) {
        if (logs.length === 0)
            return;
        await prisma_client_1.default.tenderActivityLog.createMany({
            data: logs.map((log) => ({
                id: (0, nanoid_1.nanoid)(12),
                tenantId: log.tenantId,
                tenderId: log.tenderId,
                positionId: log.positionId ?? null,
                mappingId: log.mappingId ?? null,
                articleId: log.articleId ?? null,
                employeeId: log.employeeId,
                actionType: log.actionType,
                fieldName: log.fieldName ?? null,
                oldValue: log.oldValue ?? null,
                newValue: log.newValue ?? null,
                description: log.description ?? null,
            }))
        });
    }
    async findByTender(tenderId) {
        const data = await prisma_client_1.default.tenderActivityLog.findMany({
            where: { tenderId },
            orderBy: { createdAt: "desc" },
            take: 300,
        });
        const employeeIds = Array.from(new Set(data.map((d) => String(d.employeeId))));
        const employees = employeeIds.length > 0
            ? await prisma_client_1.default.employee.findMany({
                where: { id: { in: employeeIds } },
                select: { id: true, firstName: true, lastName: true, email: true }
            })
            : [];
        const empMap = new Map(employees.map((e) => [e.id, e]));
        return data.map((d) => {
            const emp = empMap.get(d.employeeId);
            return {
                ...d,
                employeeName: emp ? `${emp.firstName} ${emp.lastName}` : null,
                employeeEmail: emp?.email ?? null,
            };
        });
    }
}
exports.TenderActivityLogRepository = TenderActivityLogRepository;
//# sourceMappingURL=TenderActivityLogRepository.js.map