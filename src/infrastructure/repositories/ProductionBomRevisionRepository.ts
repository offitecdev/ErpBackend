import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';

import prisma from '../database/prisma.client';
import type {
    Bom,
    BomChangeKind,
    BomLineChange,
    BomOrderAction,
    BomOrderActionLine,
    BomPurchaseRevision,
    BomRevision,
    BomRevisionLine,
} from '../../domain/entities/ProductionBom';
import type { IBomRevisionRepository } from '../../domain/repositories/IProductionBomRepository';
import { round3, unitFrom } from '../../domain/services/productionBom';

/**
 * ── DIE REVISIONEN EINER BOM · DATENBANKSEITE (27.09.2026) ─────────────────
 *
 * `uretim_bom_revizyonlari` (Rev.0 = Abzug der ersten Freigabe, die Revision
 * im Entwurf = Arbeitskopie) und `uretim_bom_siparis_revizyonlari` (eine
 * Bestellung, bevor eine Revision sie beim Lieferanten änderte). Die Zeilen,
 * der Unterschied und die Handlungen an den Bestellungen stehen als JSON —
 * sie werden nur gelesen, nie gesucht.
 */

const newId = (): string => nanoid(12);
const num = (value: unknown): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};
const str = (value: unknown): string | null => {
    const clean = String(value ?? '').trim();
    return clean ? clean : null;
};
const objects = (value: Prisma.JsonValue | null | undefined): Array<Record<string, unknown>> =>
    (Array.isArray(value) ? value as unknown[] : [])
        .filter((entry) => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)) as Array<Record<string, unknown>>;

const CHANGE_KINDS = new Set<BomChangeKind>(['ADDED', 'REMOVED', 'INCREASED', 'DECREASED', 'EDITED']);

export const revisionLinesOf = (value: Prisma.JsonValue | null | undefined): BomRevisionLine[] =>
    objects(value).flatMap((entry): BomRevisionLine[] => {
        const id = str(entry.id);
        const productId = str(entry.productId);
        if (!id || !productId) return [];
        return [{
            id,
            productId,
            erpCode: str(entry.erpCode),
            name: String(entry.name ?? ''),
            brand: str(entry.brand),
            modelNumber: str(entry.modelNumber),
            unit: unitFrom(entry.unit),
            quantity: round3(num(entry.quantity)),
            note: str(entry.note),
        }];
    });

const changesOf = (value: Prisma.JsonValue | null | undefined): BomLineChange[] =>
    objects(value).flatMap((entry): BomLineChange[] => {
        const kind = String(entry.kind ?? '') as BomChangeKind;
        const lineId = str(entry.lineId);
        if (!CHANGE_KINDS.has(kind) || !lineId) return [];
        return [{
            kind,
            lineId,
            productId: String(entry.productId ?? ''),
            erpCode: str(entry.erpCode),
            name: String(entry.name ?? ''),
            unitBefore: entry.unitBefore ? unitFrom(entry.unitBefore) : null,
            unitAfter: entry.unitAfter ? unitFrom(entry.unitAfter) : null,
            before: round3(num(entry.before)),
            after: round3(num(entry.after)),
            noteBefore: str(entry.noteBefore),
            noteAfter: str(entry.noteAfter),
        }];
    });

export const actionLinesOf = (value: Prisma.JsonValue | null | undefined): BomOrderActionLine[] =>
    objects(value).map((entry) => ({
        index: Math.trunc(num(entry.index)),
        bomLineId: String(entry.bomLineId ?? ''),
        code: str(entry.code),
        name: String(entry.name ?? ''),
        unitBefore: str(entry.unitBefore),
        unitAfter: str(entry.unitAfter),
        before: round3(num(entry.before)),
        after: round3(num(entry.after)),
        received: round3(num(entry.received)),
    }));

const actionsOf = (value: Prisma.JsonValue | null | undefined): BomOrderAction[] =>
    objects(value).flatMap((entry): BomOrderAction[] => {
        const purchaseOrderId = str(entry.purchaseOrderId);
        if (!purchaseOrderId) return [];
        const action = String(entry.action ?? '') as BomOrderAction['action'];
        return [{
            purchaseOrderId,
            referenceNumber: String(entry.referenceNumber ?? ''),
            supplierName: String(entry.supplierName ?? ''),
            status: String(entry.status ?? ''),
            atSupplier: entry.atSupplier === true,
            action: ['UPDATE', 'REVISE', 'DELETE', 'CANCEL', 'KEEP'].includes(action) ? action : 'KEEP',
            canKeep: entry.canKeep === true,
            orderRevision: entry.orderRevision === null || entry.orderRevision === undefined ? null : num(entry.orderRevision),
            statusAfter: String(entry.statusAfter ?? entry.status ?? ''),
            lines: actionLinesOf(entry.lines as Prisma.JsonValue),
        }];
    });

type RevisionRow = Prisma.ProductionBomRevisionGetPayload<Record<string, never>>;

const toRevision = (row: RevisionRow): BomRevision => ({
    id: row.id,
    tenantId: row.tenantId,
    bomId: row.bomId,
    revision: row.revision,
    status: row.status === 'DRAFT' ? 'DRAFT' : 'APPROVED',
    reason: row.reason,
    lines: revisionLinesOf(row.lines),
    changes: changesOf(row.changes),
    orderActions: actionsOf(row.orderActions),
    createdById: row.createdById,
    createdAt: row.createdAt,
    approvedById: row.approvedById,
    approvedAt: row.approvedAt,
    updatedAt: row.updatedAt,
});

/** Die Zeilen einer Revision als JSON (Reihenfolge = Reihenfolge der BOM). */
export const revisionLinesJson = (lines: BomRevisionLine[]): Prisma.InputJsonValue => lines.map((line) => ({
    id: line.id,
    productId: line.productId,
    erpCode: line.erpCode,
    name: line.name.slice(0, 255),
    brand: line.brand,
    modelNumber: line.modelNumber,
    unit: line.unit,
    quantity: round3(line.quantity),
    note: line.note,
})) as unknown as Prisma.InputJsonValue;

const PURCHASE_REVISION_LIGHT = {
    id: true,
    tenantId: true,
    purchaseOrderId: true,
    bomId: true,
    number: true,
    bomRevision: true,
    changes: true,
    previousStatus: true,
    quoteFileRef: true,
    quoteFileName: true,
    quoteFileType: true,
    quoteFileSize: true,
    quoteUploadedAt: true,
    createdById: true,
    createdAt: true,
} as const;

const toPurchaseRevisionLight = (row: Prisma.ProductionBomPurchaseRevisionGetPayload<{ select: typeof PURCHASE_REVISION_LIGHT }>): Omit<BomPurchaseRevision, 'previousOrder'> => ({
    id: row.id,
    tenantId: row.tenantId,
    purchaseOrderId: row.purchaseOrderId,
    bomId: row.bomId,
    number: row.number,
    bomRevision: row.bomRevision,
    changes: actionLinesOf(row.changes),
    previousStatus: row.previousStatus,
    quoteFileRef: row.quoteFileRef,
    quoteFileName: row.quoteFileName,
    quoteFileType: row.quoteFileType,
    quoteFileSize: row.quoteFileSize,
    quoteUploadedAt: row.quoteUploadedAt,
    createdById: row.createdById,
    createdAt: row.createdAt,
});

const isUniqueViolation = (error: unknown): boolean => (error as { code?: string })?.code === 'P2002';

export class PrismaBomRevisionRepository implements IBomRevisionRepository {
    async listForBoms(tenantId: string, bomIds: string[], options: { draftOnly?: boolean; omitLines?: boolean } = {}): Promise<BomRevision[]> {
        const unique = [...new Set(bomIds.filter(Boolean))];
        if (!unique.length) return [];
        const rows = await prisma.productionBomRevision.findMany({
            where: { tenantId, bomId: { in: unique }, ...(options.draftOnly ? { status: 'DRAFT' } : {}) },
            ...(options.omitLines ? { omit: { lines: true as const } } : {}),
            orderBy: [{ bomId: 'asc' }, { revision: 'asc' }],
        });
        return rows.map((row) => toRevision({ ...row, lines: 'lines' in row ? row.lines : null }));
    }

    async listApproved(tenantId: string, limit: number): Promise<BomRevision[]> {
        const rows = await prisma.productionBomRevision.findMany({
            where: { tenantId, status: 'APPROVED', revision: { gt: 0 } },
            orderBy: [{ approvedAt: 'desc' }, { createdAt: 'desc' }],
            take: Math.max(1, Math.min(500, limit)),
        });
        return rows.map(toRevision);
    }

    async get(tenantId: string, bomId: string, revision: number): Promise<BomRevision | null> {
        const row = await prisma.productionBomRevision.findFirst({ where: { tenantId, bomId, revision } });
        return row ? toRevision(row) : null;
    }

    async draftOf(tenantId: string, bomId: string): Promise<BomRevision | null> {
        const row = await prisma.productionBomRevision.findFirst({ where: { tenantId, bomId, status: 'DRAFT' } });
        return row ? toRevision(row) : null;
    }

    async ensureBaseline(tenantId: string, bom: Bom): Promise<void> {
        if (bom.status === 'DRAFT') return;
        const existing = await prisma.productionBomRevision.findFirst({
            where: { tenantId, bomId: bom.id, revision: bom.revision },
            select: { id: true },
        });
        if (existing) return;
        try {
            await prisma.productionBomRevision.create({
                data: {
                    id: newId(),
                    tenantId,
                    bomId: bom.id,
                    revision: bom.revision,
                    status: 'APPROVED',
                    reason: null,
                    // Die Zeilen einer freigegebenen BOM ändern sich nie ohne Revision —
                    // der Abzug ist darum auch nachträglich genau die Freigabe.
                    lines: revisionLinesJson(bom.lines.map((line) => ({
                        id: line.id,
                        productId: line.productId,
                        erpCode: line.erpCode,
                        name: line.name,
                        brand: line.brand,
                        modelNumber: line.modelNumber,
                        unit: line.unit,
                        quantity: line.quantity,
                        note: line.note,
                    }))),
                    createdById: bom.approvedById,
                    createdAt: bom.approvedAt ?? new Date(),
                    approvedById: bom.approvedById,
                    approvedAt: bom.approvedAt ?? new Date(),
                },
            });
        } catch (error) {
            // Ein gleichzeitiger Aufruf hat sie schon angelegt.
            if (!isUniqueViolation(error)) throw error;
        }
    }

    async createDraft(
        tenantId: string,
        input: { bomId: string; revision: number; reason: string; lines: BomRevisionLine[] },
        userId: string,
    ): Promise<BomRevision | null> {
        if (await prisma.productionBomRevision.findFirst({ where: { tenantId, bomId: input.bomId, status: 'DRAFT' }, select: { id: true } })) {
            return null;
        }
        try {
            const row = await prisma.productionBomRevision.create({
                data: {
                    id: newId(),
                    tenantId,
                    bomId: input.bomId,
                    revision: input.revision,
                    status: 'DRAFT',
                    reason: input.reason,
                    lines: revisionLinesJson(input.lines),
                    createdById: userId,
                },
            });
            return toRevision(row);
        } catch (error) {
            // Dieselbe Nummer zweimal: ein zweiter Klick war schneller.
            if (isUniqueViolation(error)) return null;
            throw error;
        }
    }

    async saveDraftLines(tenantId: string, bomId: string, lines: BomRevisionLine[], _userId: string): Promise<BomRevision | null> {
        const result = await prisma.productionBomRevision.updateMany({
            where: { tenantId, bomId, status: 'DRAFT' },
            data: { lines: revisionLinesJson(lines) },
        });
        return result.count ? this.draftOf(tenantId, bomId) : null;
    }

    async deleteDraft(tenantId: string, bomId: string): Promise<boolean> {
        const result = await prisma.productionBomRevision.deleteMany({ where: { tenantId, bomId, status: 'DRAFT' } });
        return result.count > 0;
    }

    async purchaseRevisions(tenantId: string, purchaseOrderIds: string[]): Promise<Array<Omit<BomPurchaseRevision, 'previousOrder'>>> {
        const unique = [...new Set(purchaseOrderIds.filter(Boolean))];
        if (!unique.length) return [];
        const rows = await prisma.productionBomPurchaseRevision.findMany({
            where: { tenantId, purchaseOrderId: { in: unique } },
            select: PURCHASE_REVISION_LIGHT,
            orderBy: [{ purchaseOrderId: 'asc' }, { number: 'asc' }],
        });
        return rows.map(toPurchaseRevisionLight);
    }

    async purchaseRevisionsForBoms(tenantId: string, bomIds: string[]): Promise<Array<Omit<BomPurchaseRevision, 'previousOrder'>>> {
        const unique = [...new Set(bomIds.filter(Boolean))];
        if (!unique.length) return [];
        const rows = await prisma.productionBomPurchaseRevision.findMany({
            where: { tenantId, bomId: { in: unique } },
            select: PURCHASE_REVISION_LIGHT,
            orderBy: [{ purchaseOrderId: 'asc' }, { number: 'asc' }],
        });
        return rows.map(toPurchaseRevisionLight);
    }

    async removePurchaseRevisions(tenantId: string, purchaseOrderId: string): Promise<Array<{ quoteFileRef: string | null }>> {
        const rows = await prisma.productionBomPurchaseRevision.findMany({
            where: { tenantId, purchaseOrderId },
            select: { quoteFileRef: true },
        });
        if (rows.length) await prisma.productionBomPurchaseRevision.deleteMany({ where: { tenantId, purchaseOrderId } });
        return rows;
    }

    async purchaseRevision(tenantId: string, purchaseOrderId: string, number: number): Promise<BomPurchaseRevision | null> {
        const row = await prisma.productionBomPurchaseRevision.findFirst({ where: { tenantId, purchaseOrderId, number } });
        if (!row) return null;
        const previous = row.previousOrder;
        return {
            ...toPurchaseRevisionLight(row),
            previousOrder: previous && typeof previous === 'object' && !Array.isArray(previous) ? previous as Record<string, unknown> : {},
        };
    }
}
