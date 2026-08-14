"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenderActivityLogRepository = void 0;
const nanoid_1 = require("nanoid");
const client_1 = require("@prisma/client");
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
        return prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT
                activity.*,
                CASE
                    WHEN employee.id IS NULL THEN NULL
                    ELSE CONCAT(employee.firstName, ' ', employee.lastName)
                END AS employeeName,
                employee.email AS employeeEmail
            FROM TenderActivityLog AS activity
            LEFT JOIN Employee AS employee ON employee.id = activity.employeeId
            WHERE activity.tenderId = ${tenderId}
            ORDER BY activity.createdAt DESC
            LIMIT 300
        `);
    }
}
exports.TenderActivityLogRepository = TenderActivityLogRepository;
//# sourceMappingURL=TenderActivityLogRepository.js.map