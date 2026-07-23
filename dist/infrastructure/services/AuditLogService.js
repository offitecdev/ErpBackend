"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLog = exports.AuditLogService = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
/**
 * Append-only audit trail for sensitive operations: who did what, when, from
 * which IP, on which data. Writes are fire-and-forget — an audit failure is
 * logged but never breaks the business operation itself.
 */
class AuditLogService {
    log(entry) {
        prisma_client_1.default.auditLog.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                action: entry.action,
                tenantId: entry.tenantId ?? null,
                employeeId: entry.employeeId ?? null,
                entityType: entry.entityType ?? null,
                entityId: entry.entityId ?? null,
                ipAddress: entry.ipAddress ?? null,
                userAgent: entry.userAgent ?? null,
                metadata: (entry.metadata ?? undefined),
            },
        }).catch((error) => {
            console.error('[AuditLog] write failed:', entry.action, error?.message || error);
        });
    }
    /** Extract client context (IP + user agent) from the request. */
    context(req) {
        return {
            ipAddress: req.ip || req.socket?.remoteAddress || null,
            userAgent: (req.headers['user-agent'] || '').slice(0, 512) || null,
        };
    }
}
exports.AuditLogService = AuditLogService;
exports.auditLog = new AuditLogService();
//# sourceMappingURL=AuditLogService.js.map