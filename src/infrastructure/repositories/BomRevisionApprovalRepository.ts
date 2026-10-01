import { nanoid } from 'nanoid';

import prisma from '../database/prisma.client';
import type {
    BomRevisionApprovalAction,
    BomRevisionApprovalEntry,
    IBomRevisionApprovals,
} from '../../domain/repositories/IBomRevisionApprovals';

/**
 * Die Freigaben der Revisionen im Verlauf der Belege (DocumentEvent,
 * `entityType = BOM_REVISION`, `entityId` = die Revision im Entwurf) — keine
 * eigene Tabelle: eingereicht, zurückgewiesen, freigegeben, mit Person, Zeit
 * und Notiz (30.09.2026).
 */
const ENTITY = 'BOM_REVISION';
const ACTIONS: BomRevisionApprovalAction[] = ['SUBMITTED', 'REJECTED', 'APPROVED'];

export class PrismaBomRevisionApprovals implements IBomRevisionApprovals {
    async record(tenantId: string, entry: Parameters<IBomRevisionApprovals['record']>[1]): Promise<void> {
        await prisma.documentEvent.create({
            data: {
                id: nanoid(14),
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

    async latest(tenantId: string, revisionIds: string[]): Promise<Map<string, BomRevisionApprovalEntry>> {
        const result = new Map<string, BomRevisionApprovalEntry>();
        const ids = [...new Set(revisionIds.filter(Boolean))];
        if (!ids.length) return result;
        const rows = await prisma.documentEvent.findMany({
            where: { tenantId, entityType: ENTITY, entityId: { in: ids }, action: { in: ACTIONS } },
            orderBy: { createdAt: 'desc' },
            select: { entityId: true, action: true, createdAt: true, actorId: true, actorName: true, reason: true },
            take: 200,
        });
        for (const row of rows) {
            if (result.has(row.entityId)) continue;
            result.set(row.entityId, {
                revisionId: row.entityId,
                action: row.action as BomRevisionApprovalAction,
                at: row.createdAt,
                actorId: row.actorId ?? null,
                actorName: row.actorName ?? null,
                note: row.reason ?? null,
            });
        }
        return result;
    }

    async submitter(tenantId: string, revisionId: string): Promise<{ actorId: string | null; actorName: string | null } | null> {
        const row = await prisma.documentEvent.findFirst({
            where: { tenantId, entityType: ENTITY, entityId: revisionId, action: 'SUBMITTED' },
            orderBy: { createdAt: 'desc' },
            select: { actorId: true, actorName: true },
        });
        return row ? { actorId: row.actorId ?? null, actorName: row.actorName ?? null } : null;
    }
}
