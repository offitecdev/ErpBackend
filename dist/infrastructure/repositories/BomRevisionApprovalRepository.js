"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaBomRevisionApprovals = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
/**
 * Die Freigaben der Revisionen im Verlauf der Belege (DocumentEvent,
 * `entityType = BOM_REVISION`, `entityId` = die Revision im Entwurf) — keine
 * eigene Tabelle: eingereicht, zurückgewiesen, freigegeben, mit Person, Zeit
 * und Notiz (30.09.2026).
 */
const ENTITY = 'BOM_REVISION';
const ACTIONS = ['SUBMITTED', 'REJECTED', 'APPROVED'];
class PrismaBomRevisionApprovals {
    async record(tenantId, entry) {
        await prisma_client_1.default.documentEvent.create({
            data: {
                id: (0, nanoid_1.nanoid)(14),
                tenantId,
                entityType: ENTITY,
                entityId: entry.revisionId,
                documentNumber: `${entry.bomNumber} · Rev.${entry.revision}`.slice(0, 191),
                action: entry.action,
                reason: entry.note,
                snapshot: { bomId: entry.bomId, bomNumber: entry.bomNumber, revision: entry.revision },
                actorId: entry.actorId,
                actorName: entry.actorName?.slice(0, 191) ?? null,
            },
        });
    }
    async latest(tenantId, revisionIds) {
        const result = new Map();
        const ids = [...new Set(revisionIds.filter(Boolean))];
        if (!ids.length)
            return result;
        const rows = await prisma_client_1.default.documentEvent.findMany({
            where: { tenantId, entityType: ENTITY, entityId: { in: ids }, action: { in: ACTIONS } },
            orderBy: { createdAt: 'desc' },
            select: { entityId: true, action: true, createdAt: true, actorId: true, actorName: true, reason: true },
            take: 200,
        });
        for (const row of rows) {
            if (result.has(row.entityId))
                continue;
            result.set(row.entityId, {
                revisionId: row.entityId,
                action: row.action,
                at: row.createdAt,
                actorId: row.actorId ?? null,
                actorName: row.actorName ?? null,
                note: row.reason ?? null,
            });
        }
        return result;
    }
    async submitter(tenantId, revisionId) {
        const row = await prisma_client_1.default.documentEvent.findFirst({
            where: { tenantId, entityType: ENTITY, entityId: revisionId, action: 'SUBMITTED' },
            orderBy: { createdAt: 'desc' },
            select: { actorId: true, actorName: true },
        });
        return row ? { actorId: row.actorId ?? null, actorName: row.actorName ?? null } : null;
    }
}
exports.PrismaBomRevisionApprovals = PrismaBomRevisionApprovals;
//# sourceMappingURL=BomRevisionApprovalRepository.js.map