import { nanoid } from 'nanoid';
import type { Prisma } from '@prisma/client';

import prisma from '../database/prisma.client';
import type { IProcurementJournal } from '../../domain/repositories/IProcurementJournal';
import { PROCUREMENT_EVENT_ACTIONS, type ProcurementEvent, type ProcurementEventAction } from '../../domain/services/procurementFlow';

/**
 * ── DER VERLAUF DER TALEPLER (28.09.2026) ────────────────────────────────────
 * Steht im Belegverlauf (`DocumentEvent`, seit 16.09.2026 unveränderlich) als
 * `entityType = 'PROCUREMENT'`, `entityId` = Talep — keine eigene Tabelle.
 */
const ENTITY = 'PROCUREMENT';
const ACTIONS = new Set<string>(PROCUREMENT_EVENT_ACTIONS);

type Row = { entityId: string; action: string; actorName: string | null; snapshot: Prisma.JsonValue | null; createdAt: Date };

const eventOf = (row: Row): ProcurementEvent | null => {
    if (!ACTIONS.has(row.action)) return null;
    const data = row.snapshot && typeof row.snapshot === 'object' && !Array.isArray(row.snapshot)
        ? (row.snapshot as Record<string, unknown>)
        : {};
    return { action: row.action as ProcurementEventAction, at: row.createdAt, actorName: row.actorName ?? null, data };
};

const SELECT = { entityId: true, action: true, actorName: true, snapshot: true, createdAt: true } as const;

export class PrismaProcurementJournal implements IProcurementJournal {
    async record(tenantId: string, entry: Parameters<IProcurementJournal['record']>[1]): Promise<void> {
        await prisma.documentEvent.create({
            data: {
                id: nanoid(14),
                tenantId,
                entityType: ENTITY,
                entityId: entry.requestId,
                documentNumber: entry.requestNumber.slice(0, 191),
                action: entry.action,
                snapshot: (entry.data ?? {}) as Prisma.InputJsonValue,
                actorId: entry.actorId,
                actorName: entry.actorName?.slice(0, 191) ?? null,
            },
        });
    }

    async forRequest(tenantId: string, requestId: string): Promise<ProcurementEvent[]> {
        const rows = await prisma.documentEvent.findMany({
            where: { tenantId, entityType: ENTITY, entityId: requestId },
            orderBy: { createdAt: 'desc' },
            take: 300,
            select: SELECT,
        });
        return rows.flatMap((row) => eventOf(row) ?? []);
    }

    async latest(tenantId: string, requestIds: string[]): Promise<Map<string, ProcurementEvent>> {
        const ids = [...new Set(requestIds.filter(Boolean))];
        const result = new Map<string, ProcurementEvent>();
        if (!ids.length) return result;
        const rows = await prisma.documentEvent.findMany({
            where: { tenantId, entityType: ENTITY, entityId: { in: ids } },
            orderBy: { createdAt: 'desc' },
            select: SELECT,
        });
        for (const row of rows) {
            if (result.has(row.entityId)) continue;
            const event = eventOf(row);
            if (event) result.set(row.entityId, event);
        }
        return result;
    }
}
