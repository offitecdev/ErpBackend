import type { DocumentEntityType } from './events';

/**
 * ── BELEGVERLAUF LESEN (16.09.2026, Schritt 4 / D1) ──────────────────────────
 *
 * Der Verlauf EINES Belegs sind seine eigenen Einträge PLUS die Einträge, die
 * auf ihn verweisen: das Projekt zeigt, was mit seinen Aufträgen geschah, die
 * Offerte, was mit dem Auftrag aus ihr geschah. Neueste zuerst.
 */

type Db = any;

const LINK_COLUMN: Partial<Record<DocumentEntityType, 'projectId' | 'tenderId' | 'salesOrderId'>> = {
    PROJECT: 'projectId',
    TENDER: 'tenderId',
    SALES_ORDER: 'salesOrderId',
};

export const DOCUMENT_ENTITY_TYPES: readonly DocumentEntityType[] = ['TENDER', 'SALES_ORDER', 'ADDON_ORDER', 'PROJECT', 'INVOICE'];

const whereFor = (tenantId: string, entityType: DocumentEntityType, entityId: string) => {
    const link = LINK_COLUMN[entityType];
    return {
        tenantId,
        OR: [
            { entityType, entityId },
            ...(link ? [{ [link]: entityId }] : []),
        ],
    };
};

export interface DocumentHistoryEntry {
    id: string;
    entityType: DocumentEntityType;
    entityId: string;
    documentNumber: string | null;
    action: string;
    reason: string | null;
    override: boolean;
    overriddenBlockers: string[];
    snapshot: Record<string, unknown> | null;
    actorName: string | null;
    createdAt: Date;
    /** Der Eintrag gehört zu einem ANDEREN Beleg und erscheint hier über den Verweis. */
    related: boolean;
}

export const loadDocumentHistory = async (
    db: Db,
    opts: { tenantId: string; entityType: DocumentEntityType; entityId: string; limit?: number },
): Promise<DocumentHistoryEntry[]> => {
    const rows: any[] = await db.documentEvent.findMany({
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

/** Wie viele Einträge, davon wie viele Eingriffe — für das Zeichen am Knopf. */
export const loadDocumentHistorySummary = async (
    db: Db,
    opts: { tenantId: string; entityType: DocumentEntityType; entityId: string },
): Promise<{ count: number; overrides: number }> => {
    const where = whereFor(opts.tenantId, opts.entityType, opts.entityId);
    const [count, overrides] = await Promise.all([
        db.documentEvent.count({ where }),
        db.documentEvent.count({ where: { ...where, override: true } }),
    ]);
    return { count, overrides };
};
