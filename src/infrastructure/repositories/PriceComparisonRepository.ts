import { nanoid } from 'nanoid';
import type { Prisma } from '@prisma/client';

import prisma from '../database/prisma.client';
import type { IPriceComparisonStore, StoredPriceComparison } from '../../domain/repositories/IPriceComparisonStore';
import type { ComparisonResult } from '../../domain/services/priceComparison';

/**
 * ── GESPEICHERTE FİYAT KARŞILAŞTIRMALARI (29.09.2026) ───────────────────────
 * «Karşılaştırmalar kayıt edilecek.» Sie stehen wie der Verlauf der Talepler
 * im Belegverlauf (`DocumentEvent`, unveränderlich): `entityType =
 * 'PROCUREMENT_CMP'`, `entityId` = Talep, die ganze Tabelle im `snapshot`.
 * Keine eigene Tabelle — also auch keine Migration.
 */
const ENTITY = 'PROCUREMENT_CMP';
const ACTION = 'PRICE_COMPARED';

type Row = {
    id: string;
    entityId: string;
    documentNumber: string | null;
    actorName: string | null;
    snapshot: Prisma.JsonValue | null;
    createdAt: Date;
};

const SELECT = { id: true, entityId: true, documentNumber: true, actorName: true, snapshot: true, createdAt: true } as const;

const comparisonOf = (row: Row): StoredPriceComparison | null => {
    const data = row.snapshot && typeof row.snapshot === 'object' && !Array.isArray(row.snapshot)
        ? (row.snapshot as Record<string, unknown>)
        : null;
    const result = data?.result as ComparisonResult | undefined;
    if (!result || !Array.isArray(result.suppliers) || !Array.isArray(result.lines)) return null;
    return {
        id: row.id,
        requestId: row.entityId,
        requestNumber: row.documentNumber ?? '',
        createdAt: row.createdAt,
        actorName: row.actorName ?? null,
        model: typeof data?.model === 'string' ? data.model : '',
        result,
    };
};

export class PrismaPriceComparisonStore implements IPriceComparisonStore {
    async save(tenantId: string, entry: Parameters<IPriceComparisonStore['save']>[1]): Promise<StoredPriceComparison> {
        const row = await prisma.documentEvent.create({
            data: {
                id: nanoid(14),
                tenantId,
                entityType: ENTITY,
                entityId: entry.requestId,
                documentNumber: entry.requestNumber.slice(0, 191),
                action: ACTION,
                snapshot: { model: entry.model, result: entry.result } as unknown as Prisma.InputJsonValue,
                actorId: entry.actorId,
                actorName: entry.actorName?.slice(0, 191) ?? null,
            },
            select: SELECT,
        });
        return comparisonOf(row)!;
    }

    async forRequest(tenantId: string, requestId: string): Promise<StoredPriceComparison[]> {
        const rows = await prisma.documentEvent.findMany({
            where: { tenantId, entityType: ENTITY, entityId: requestId, action: ACTION },
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: SELECT,
        });
        return rows.flatMap((row) => comparisonOf(row) ?? []);
    }

    async get(tenantId: string, id: string): Promise<StoredPriceComparison | null> {
        const row = await prisma.documentEvent.findFirst({
            where: { id, tenantId, entityType: ENTITY, action: ACTION },
            select: SELECT,
        });
        return row ? comparisonOf(row) : null;
    }
}
