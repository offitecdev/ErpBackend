"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaBomRevisionRepository = exports.revisionLinesJson = exports.actionLinesOf = exports.revisionLinesOf = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const productionBom_1 = require("../../domain/services/productionBom");
/**
 * ── DIE REVISIONEN EINER BOM · DATENBANKSEITE (27.09.2026) ─────────────────
 *
 * `uretim_bom_revizyonlari` (Rev.0 = Abzug der ersten Freigabe, die Revision
 * im Entwurf = Arbeitskopie) und `uretim_bom_siparis_revizyonlari` (eine
 * Bestellung, bevor eine Revision sie beim Lieferanten änderte). Die Zeilen,
 * der Unterschied und die Handlungen an den Bestellungen stehen als JSON —
 * sie werden nur gelesen, nie gesucht.
 */
const newId = () => (0, nanoid_1.nanoid)(12);
const num = (value) => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};
const str = (value) => {
    const clean = String(value ?? '').trim();
    return clean ? clean : null;
};
const objects = (value) => (Array.isArray(value) ? value : [])
    .filter((entry) => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry));
const CHANGE_KINDS = new Set(['ADDED', 'REMOVED', 'INCREASED', 'DECREASED', 'EDITED']);
const revisionLinesOf = (value) => objects(value).flatMap((entry) => {
    const id = str(entry.id);
    const productId = str(entry.productId);
    if (!id || !productId)
        return [];
    return [{
            id,
            productId,
            erpCode: str(entry.erpCode),
            name: String(entry.name ?? ''),
            brand: str(entry.brand),
            modelNumber: str(entry.modelNumber),
            unit: (0, productionBom_1.unitFrom)(entry.unit),
            quantity: (0, productionBom_1.round3)(num(entry.quantity)),
            note: str(entry.note),
        }];
});
exports.revisionLinesOf = revisionLinesOf;
const changesOf = (value) => objects(value).flatMap((entry) => {
    const kind = String(entry.kind ?? '');
    const lineId = str(entry.lineId);
    if (!CHANGE_KINDS.has(kind) || !lineId)
        return [];
    return [{
            kind,
            lineId,
            productId: String(entry.productId ?? ''),
            erpCode: str(entry.erpCode),
            name: String(entry.name ?? ''),
            unitBefore: entry.unitBefore ? (0, productionBom_1.unitFrom)(entry.unitBefore) : null,
            unitAfter: entry.unitAfter ? (0, productionBom_1.unitFrom)(entry.unitAfter) : null,
            before: (0, productionBom_1.round3)(num(entry.before)),
            after: (0, productionBom_1.round3)(num(entry.after)),
            noteBefore: str(entry.noteBefore),
            noteAfter: str(entry.noteAfter),
        }];
});
const actionLinesOf = (value) => objects(value).map((entry) => ({
    index: Math.trunc(num(entry.index)),
    bomLineId: String(entry.bomLineId ?? ''),
    code: str(entry.code),
    name: String(entry.name ?? ''),
    unitBefore: str(entry.unitBefore),
    unitAfter: str(entry.unitAfter),
    before: (0, productionBom_1.round3)(num(entry.before)),
    after: (0, productionBom_1.round3)(num(entry.after)),
    received: (0, productionBom_1.round3)(num(entry.received)),
}));
exports.actionLinesOf = actionLinesOf;
const actionsOf = (value) => objects(value).flatMap((entry) => {
    const purchaseOrderId = str(entry.purchaseOrderId);
    if (!purchaseOrderId)
        return [];
    const action = String(entry.action ?? '');
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
            lines: (0, exports.actionLinesOf)(entry.lines),
        }];
});
const toRevision = (row) => ({
    id: row.id,
    tenantId: row.tenantId,
    bomId: row.bomId,
    revision: row.revision,
    status: row.status === 'DRAFT' ? 'DRAFT' : 'APPROVED',
    reason: row.reason,
    lines: (0, exports.revisionLinesOf)(row.lines),
    changes: changesOf(row.changes),
    orderActions: actionsOf(row.orderActions),
    createdById: row.createdById,
    createdAt: row.createdAt,
    approvedById: row.approvedById,
    approvedAt: row.approvedAt,
    updatedAt: row.updatedAt,
});
/** Die Zeilen einer Revision als JSON (Reihenfolge = Reihenfolge der BOM). */
const revisionLinesJson = (lines) => lines.map((line) => ({
    id: line.id,
    productId: line.productId,
    erpCode: line.erpCode,
    name: line.name.slice(0, 255),
    brand: line.brand,
    modelNumber: line.modelNumber,
    unit: line.unit,
    quantity: (0, productionBom_1.round3)(line.quantity),
    note: line.note,
}));
exports.revisionLinesJson = revisionLinesJson;
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
};
const toPurchaseRevisionLight = (row) => ({
    id: row.id,
    tenantId: row.tenantId,
    purchaseOrderId: row.purchaseOrderId,
    bomId: row.bomId,
    number: row.number,
    bomRevision: row.bomRevision,
    changes: (0, exports.actionLinesOf)(row.changes),
    previousStatus: row.previousStatus,
    quoteFileRef: row.quoteFileRef,
    quoteFileName: row.quoteFileName,
    quoteFileType: row.quoteFileType,
    quoteFileSize: row.quoteFileSize,
    quoteUploadedAt: row.quoteUploadedAt,
    createdById: row.createdById,
    createdAt: row.createdAt,
});
const isUniqueViolation = (error) => error?.code === 'P2002';
class PrismaBomRevisionRepository {
    async listForBoms(tenantId, bomIds) {
        const unique = [...new Set(bomIds.filter(Boolean))];
        if (!unique.length)
            return [];
        const rows = await prisma_client_1.default.productionBomRevision.findMany({
            where: { tenantId, bomId: { in: unique } },
            orderBy: [{ bomId: 'asc' }, { revision: 'asc' }],
        });
        return rows.map(toRevision);
    }
    async listApproved(tenantId, limit) {
        const rows = await prisma_client_1.default.productionBomRevision.findMany({
            where: { tenantId, status: 'APPROVED', revision: { gt: 0 } },
            orderBy: [{ approvedAt: 'desc' }, { createdAt: 'desc' }],
            take: Math.max(1, Math.min(500, limit)),
        });
        return rows.map(toRevision);
    }
    async get(tenantId, bomId, revision) {
        const row = await prisma_client_1.default.productionBomRevision.findFirst({ where: { tenantId, bomId, revision } });
        return row ? toRevision(row) : null;
    }
    async draftOf(tenantId, bomId) {
        const row = await prisma_client_1.default.productionBomRevision.findFirst({ where: { tenantId, bomId, status: 'DRAFT' } });
        return row ? toRevision(row) : null;
    }
    async ensureBaseline(tenantId, bom) {
        if (bom.status === 'DRAFT')
            return;
        const existing = await prisma_client_1.default.productionBomRevision.findFirst({
            where: { tenantId, bomId: bom.id, revision: bom.revision },
            select: { id: true },
        });
        if (existing)
            return;
        try {
            await prisma_client_1.default.productionBomRevision.create({
                data: {
                    id: newId(),
                    tenantId,
                    bomId: bom.id,
                    revision: bom.revision,
                    status: 'APPROVED',
                    reason: null,
                    // Die Zeilen einer freigegebenen BOM ändern sich nie ohne Revision —
                    // der Abzug ist darum auch nachträglich genau die Freigabe.
                    lines: (0, exports.revisionLinesJson)(bom.lines.map((line) => ({
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
        }
        catch (error) {
            // Ein gleichzeitiger Aufruf hat sie schon angelegt.
            if (!isUniqueViolation(error))
                throw error;
        }
    }
    async createDraft(tenantId, input, userId) {
        if (await prisma_client_1.default.productionBomRevision.findFirst({ where: { tenantId, bomId: input.bomId, status: 'DRAFT' }, select: { id: true } })) {
            return null;
        }
        try {
            const row = await prisma_client_1.default.productionBomRevision.create({
                data: {
                    id: newId(),
                    tenantId,
                    bomId: input.bomId,
                    revision: input.revision,
                    status: 'DRAFT',
                    reason: input.reason,
                    lines: (0, exports.revisionLinesJson)(input.lines),
                    createdById: userId,
                },
            });
            return toRevision(row);
        }
        catch (error) {
            // Dieselbe Nummer zweimal: ein zweiter Klick war schneller.
            if (isUniqueViolation(error))
                return null;
            throw error;
        }
    }
    async saveDraftLines(tenantId, bomId, lines, _userId) {
        const result = await prisma_client_1.default.productionBomRevision.updateMany({
            where: { tenantId, bomId, status: 'DRAFT' },
            data: { lines: (0, exports.revisionLinesJson)(lines) },
        });
        return result.count ? this.draftOf(tenantId, bomId) : null;
    }
    async deleteDraft(tenantId, bomId) {
        const result = await prisma_client_1.default.productionBomRevision.deleteMany({ where: { tenantId, bomId, status: 'DRAFT' } });
        return result.count > 0;
    }
    async purchaseRevisions(tenantId, purchaseOrderIds) {
        const unique = [...new Set(purchaseOrderIds.filter(Boolean))];
        if (!unique.length)
            return [];
        const rows = await prisma_client_1.default.productionBomPurchaseRevision.findMany({
            where: { tenantId, purchaseOrderId: { in: unique } },
            select: PURCHASE_REVISION_LIGHT,
            orderBy: [{ purchaseOrderId: 'asc' }, { number: 'asc' }],
        });
        return rows.map(toPurchaseRevisionLight);
    }
    async purchaseRevisionsForBoms(tenantId, bomIds) {
        const unique = [...new Set(bomIds.filter(Boolean))];
        if (!unique.length)
            return [];
        const rows = await prisma_client_1.default.productionBomPurchaseRevision.findMany({
            where: { tenantId, bomId: { in: unique } },
            select: PURCHASE_REVISION_LIGHT,
            orderBy: [{ purchaseOrderId: 'asc' }, { number: 'asc' }],
        });
        return rows.map(toPurchaseRevisionLight);
    }
    async removePurchaseRevisions(tenantId, purchaseOrderId) {
        const rows = await prisma_client_1.default.productionBomPurchaseRevision.findMany({
            where: { tenantId, purchaseOrderId },
            select: { quoteFileRef: true },
        });
        if (rows.length)
            await prisma_client_1.default.productionBomPurchaseRevision.deleteMany({ where: { tenantId, purchaseOrderId } });
        return rows;
    }
    async purchaseRevision(tenantId, purchaseOrderId, number) {
        const row = await prisma_client_1.default.productionBomPurchaseRevision.findFirst({ where: { tenantId, purchaseOrderId, number } });
        if (!row)
            return null;
        const previous = row.previousOrder;
        return {
            ...toPurchaseRevisionLight(row),
            previousOrder: previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {},
        };
    }
}
exports.PrismaBomRevisionRepository = PrismaBomRevisionRepository;
//# sourceMappingURL=ProductionBomRevisionRepository.js.map