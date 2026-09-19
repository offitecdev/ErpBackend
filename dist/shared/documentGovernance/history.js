"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadDocumentHistorySummary = exports.loadDocumentHistory = exports.DOCUMENT_ENTITY_TYPES = void 0;
const LINK_COLUMN = {
    PROJECT: 'projectId',
    TENDER: 'tenderId',
    SALES_ORDER: 'salesOrderId',
};
exports.DOCUMENT_ENTITY_TYPES = ['TENDER', 'SALES_ORDER', 'ADDON_ORDER', 'PROJECT', 'INVOICE'];
const whereFor = (tenantId, entityType, entityId) => {
    const link = LINK_COLUMN[entityType];
    return {
        tenantId,
        OR: [
            { entityType, entityId },
            ...(link ? [{ [link]: entityId }] : []),
        ],
    };
};
const loadDocumentHistory = async (db, opts) => {
    const rows = await db.documentEvent.findMany({
        where: whereFor(opts.tenantId, opts.entityType, opts.entityId),
        orderBy: { createdAt: 'desc' },
        take: Math.min(Math.max(opts.limit ?? 200, 1), 500),
    });
    return rows.map((row) => ({
        id: row.id,
        entityType: row.entityType,
        entityId: row.entityId,
        documentNumber: row.documentNumber ?? null,
        action: row.action,
        reason: row.reason ?? null,
        override: Boolean(row.override),
        overriddenBlockers: Array.isArray(row.overriddenBlockers) ? row.overriddenBlockers : [],
        snapshot: row.snapshot && typeof row.snapshot === 'object' ? row.snapshot : null,
        actorName: row.actorName ?? null,
        createdAt: row.createdAt,
        related: !(row.entityType === opts.entityType && row.entityId === opts.entityId),
    }));
};
exports.loadDocumentHistory = loadDocumentHistory;
/** Wie viele Einträge, davon wie viele Eingriffe — für das Zeichen am Knopf. */
const loadDocumentHistorySummary = async (db, opts) => {
    const where = whereFor(opts.tenantId, opts.entityType, opts.entityId);
    const [count, overrides] = await Promise.all([
        db.documentEvent.count({ where }),
        db.documentEvent.count({ where: { ...where, override: true } }),
    ]);
    return { count, overrides };
};
exports.loadDocumentHistorySummary = loadDocumentHistorySummary;
//# sourceMappingURL=history.js.map