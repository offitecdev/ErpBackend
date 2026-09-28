"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaProcurementJournal = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const procurementFlow_1 = require("../../domain/services/procurementFlow");
/**
 * ── DER VERLAUF DER TALEPLER (28.09.2026) ────────────────────────────────────
 * Steht im Belegverlauf (`DocumentEvent`, seit 16.09.2026 unveränderlich) als
 * `entityType = 'PROCUREMENT'`, `entityId` = Talep — keine eigene Tabelle.
 */
const ENTITY = 'PROCUREMENT';
const ACTIONS = new Set(procurementFlow_1.PROCUREMENT_EVENT_ACTIONS);
const eventOf = (row) => {
    if (!ACTIONS.has(row.action))
        return null;
    const data = row.snapshot && typeof row.snapshot === 'object' && !Array.isArray(row.snapshot)
        ? row.snapshot
        : {};
    return { action: row.action, at: row.createdAt, actorName: row.actorName ?? null, data };
};
const SELECT = { entityId: true, action: true, actorName: true, snapshot: true, createdAt: true };
class PrismaProcurementJournal {
    async record(tenantId, entry) {
        await prisma_client_1.default.documentEvent.create({
            data: {
                id: (0, nanoid_1.nanoid)(14),
                tenantId,
                entityType: ENTITY,
                entityId: entry.requestId,
                documentNumber: entry.requestNumber.slice(0, 191),
                action: entry.action,
                snapshot: (entry.data ?? {}),
                actorId: entry.actorId,
                actorName: entry.actorName?.slice(0, 191) ?? null,
            },
        });
    }
    async forRequest(tenantId, requestId) {
        const rows = await prisma_client_1.default.documentEvent.findMany({
            where: { tenantId, entityType: ENTITY, entityId: requestId },
            orderBy: { createdAt: 'desc' },
            take: 300,
            select: SELECT,
        });
        return rows.flatMap((row) => eventOf(row) ?? []);
    }
    async latest(tenantId, requestIds) {
        const ids = [...new Set(requestIds.filter(Boolean))];
        const result = new Map();
        if (!ids.length)
            return result;
        const rows = await prisma_client_1.default.documentEvent.findMany({
            where: { tenantId, entityType: ENTITY, entityId: { in: ids } },
            orderBy: { createdAt: 'desc' },
            select: SELECT,
        });
        for (const row of rows) {
            if (result.has(row.entityId))
                continue;
            const event = eventOf(row);
            if (event)
                result.set(row.entityId, event);
        }
        return result;
    }
}
exports.PrismaProcurementJournal = PrismaProcurementJournal;
//# sourceMappingURL=ProcurementJournalRepository.js.map