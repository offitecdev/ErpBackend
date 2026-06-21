"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenderActivityLogRepository = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const DB_TEXT_SAFE_BYTES = 60000;
const clampText = (value) => {
    if (value == null)
        return null;
    const text = String(value);
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength <= DB_TEXT_SAFE_BYTES)
        return text;
    const suffix = `\n...[log truncated: ${byteLength} bytes]`;
    const maxBodyBytes = Math.max(0, DB_TEXT_SAFE_BYTES - Buffer.byteLength(suffix, "utf8") - 4);
    return Buffer.from(text, "utf8").subarray(0, maxBodyBytes).toString("utf8") + suffix;
};
class TenderActivityLogRepository {
    normalize(log) {
        return {
            id: (0, nanoid_1.nanoid)(12),
            tenantId: log.tenantId,
            tenderId: log.tenderId,
            positionId: log.positionId ?? null,
            mappingId: log.mappingId ?? null,
            articleId: log.articleId ?? null,
            employeeId: log.employeeId,
            actionType: log.actionType,
            fieldName: log.fieldName ?? null,
            oldValue: clampText(log.oldValue),
            newValue: clampText(log.newValue),
            description: clampText(log.description),
        };
    }
    async create(log) {
        return await prisma_client_1.default.tenderActivityLog.create({
            data: this.normalize(log)
        });
    }
    async createMany(logs) {
        if (logs.length === 0)
            return;
        await prisma_client_1.default.tenderActivityLog.createMany({
            data: logs.map((log) => this.normalize(log))
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