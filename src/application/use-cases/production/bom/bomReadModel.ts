import type {
    Bom,
    BomLine,
    BomLineChange,
    BomLineCoverage,
    BomOrderAction,
    BomOrderActionLine,
    BomPurchaseLink,
    BomPurchaseRevision,
    BomRevision,
    BomStockProduct,
    BomTemplate,
    BomTemplateSummary,
} from '../../../../domain/entities/ProductionBom';
import type { BomPurchaseOrderRow } from '../../../../domain/repositories/IProductionBomRepository';
import {
    CONFIRMED_ORDER_STATUSES,
    completionOf,
    openOf,
    PRICE_REQUEST_STATUSES,
    round3,
    type BomCompletion,
} from '../../../../domain/services/productionBom';

/**
 * ── WAS DIE OBERFLÄCHE SIEHT (27.09.2026) ────────────────────────────────────
 * Spiegel: ErpFront/offitec-frontend/src/types/productionBom.ts.
 */

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

export interface BomTemplateSummaryDto {
    id: string;
    name: string;
    category: BomTemplateSummary['category'];
    mainCard: string;
    codePrefix: string;
    lineCount: number;
    usedBy: number;
    isExample: boolean;
    updatedAt: string;
}

export const templateSummaryDto = (summary: BomTemplateSummary): BomTemplateSummaryDto => ({
    id: summary.id,
    name: summary.name,
    category: summary.category,
    mainCard: summary.mainCard,
    codePrefix: summary.codePrefix,
    lineCount: summary.lineCount,
    usedBy: summary.usedBy,
    isExample: Boolean(summary.exampleKey),
    updatedAt: summary.updatedAt.toISOString(),
});

/** Eine Depo-Karte, wie Suche und Zeilen sie zeigen — «depodaki satırın aynısı». */
export interface BomProductDto {
    id: string;
    erpCode: string | null;
    name: string;
    brand: string | null;
    modelNumber: string | null;
    description: string | null;
    supplierName: string | null;
    suppliers: Array<{ id: string | null; name: string }>;
    quantity: number;
    /** Nicht reserviert. */
    free: number;
    serialRequired: boolean;
    minimumOrderQuantity: number | null;
    hasErpCode: boolean;
}

export const productDto = (product: BomStockProduct, free?: number): BomProductDto => ({
    id: product.productId,
    erpCode: product.erpCode,
    name: product.name,
    brand: product.brand,
    modelNumber: product.modelNumber,
    description: product.description,
    supplierName: product.suppliers[0]?.name ?? null,
    suppliers: product.suppliers.map((entry) => ({ id: entry.supplierId, name: entry.name })),
    quantity: product.quantity,
    free: round3(free ?? product.quantity),
    serialRequired: product.serialRequired,
    minimumOrderQuantity: product.minimumOrderQuantity,
    hasErpCode: Boolean(product.erpCode),
});

export interface BomTemplateLineDto {
    id: string;
    productId: string;
    erpCode: string | null;
    name: string;
    brand: string | null;
    modelNumber: string | null;
    quantity: number;
    unit: string;
    note: string | null;
    /** Die Karte, wie sie JETZT ist (null = gelöscht). */
    product: BomProductDto | null;
}

export interface BomTemplateDto {
    id: string;
    name: string;
    category: BomTemplate['category'];
    mainCard: string;
    codePrefix: string;
    description: string | null;
    isExample: boolean;
    usedBy: number;
    updatedAt: string;
    lines: BomTemplateLineDto[];
}

export const templateDto = (
    template: BomTemplate,
    products: Map<string, BomStockProduct>,
    free: Map<string, number>,
    usedBy: number,
): BomTemplateDto => ({
    id: template.id,
    name: template.name,
    category: template.category,
    mainCard: template.mainCard,
    codePrefix: template.codePrefix,
    description: template.description,
    isExample: Boolean(template.exampleKey),
    usedBy,
    updatedAt: template.updatedAt.toISOString(),
    lines: template.lines.map((line) => {
        const product = products.get(line.productId) ?? null;
        return {
            id: line.id,
            productId: line.productId,
            erpCode: product?.erpCode ?? line.erpCode,
            name: product?.name ?? line.name,
            brand: product?.brand ?? line.brand,
            modelNumber: product?.modelNumber ?? line.modelNumber,
            quantity: line.quantity,
            unit: line.unit,
            note: line.note,
            product: product ? productDto(product, free.get(product.productId)) : null,
        };
    }),
});

/* ── BOM ────────────────────────────────────────────────────────────────── */

export interface BomLineOrderDto {
    purchaseOrderId: string;
    referenceNumber: string;
    kind: 'ORDER' | 'REQUEST';
    status: string;
    quantity: number;
    received: number;
}

export interface BomLineDto {
    id: string;
    productId: string;
    erpCode: string | null;
    name: string;
    brand: string | null;
    modelNumber: string | null;
    unit: string;
    quantity: number;
    consumedQuantity: number;
    note: string | null;
    product: BomProductDto | null;
    coverage: {
        open: number;
        reserved: number;
        incoming: number;
        incomingConfirmed: number;
        missing: number;
        serials: string[];
    };
    orders: BomLineOrderDto[];
}

export interface BomPurchaseDto {
    purchaseOrderId: string;
    referenceNumber: string;
    kind: 'ORDER' | 'REQUEST';
    status: string;
    supplierName: string;
    quoteNumber: string | null;
    currency: string;
    totalNet: number;
    lineCount: number;
    createdAt: string;
    emailSentAt: string | null;
    sourcePurchaseOrderId: string | null;
    quoteFile: { name: string; type: string | null; size: number | null; uploadedAt: string | null } | null;
    checks: { quoteNumber: boolean; quoteFile: boolean; prices: boolean; confirmed: boolean; received: boolean };
    receivedLines: number;
    /** Die BOM-Revision, für die der Beleg gilt (angelegt oder zuletzt nachgezogen). */
    bomRevision: number;
    /** Wie oft eine BOM-Revision die Bestellung beim Lieferanten geändert hat. */
    orderRevision: number;
    /** Eine Preisanfrage einer älteren Revision («eski revizyona ait»). */
    stale: boolean;
    /** Die alten Fassungen der Bestellung (älteste zuerst) — altes PDF, alte Bestätigung. */
    revisions: BomPurchaseRevisionDto[];
    lines: Array<{
        index: number;
        bomLineId: string | null;
        code: string | null;
        name: string;
        /** Das Modell der Preisanfrage (eigene Spalte `stdModel`). */
        model: string | null;
        unit: string | null;
        quantity: number;
        received: number;
        grossPrice: number;
        netPrice: number;
        lineTotal: number;
    }>;
}

/** Eine alte Fassung einer BOM-Bestellung: `number` = die Revision, die dabei entstand. */
export interface BomPurchaseRevisionDto {
    number: number;
    bomRevision: number;
    createdAt: string;
    previousStatus: string;
    changes: BomOrderActionLine[];
    /** Die Bestätigung des Lieferanten zur Fassung davor. */
    quoteFile: { name: string; type: string | null; size: number | null; uploadedAt: string | null } | null;
}

/** Eine Zeile der Revision im Entwurf, mit der Depo-Karte, wie sie jetzt ist. */
export interface BomRevisionLineDto {
    id: string;
    productId: string;
    erpCode: string | null;
    name: string;
    brand: string | null;
    modelNumber: string | null;
    unit: string;
    quantity: number;
    note: string | null;
    product: BomProductDto | null;
}

/** Die Revision im Entwurf — die Arbeitskopie (die BOM gilt unverändert weiter). */
export interface BomRevisionDraftDto {
    id: string;
    revision: number;
    reason: string | null;
    createdAt: string;
    createdByName: string | null;
    updatedAt: string;
    lines: BomRevisionLineDto[];
}

/** Eine freigegebene Revision in der Geschichte der BOM (ohne ihre Zeilen). */
export interface BomRevisionSummaryDto {
    revision: number;
    reason: string | null;
    approvedAt: string | null;
    approvedByName: string | null;
    changes: BomLineChange[];
    orderActions: Array<Pick<BomOrderAction, 'purchaseOrderId' | 'referenceNumber' | 'supplierName' | 'action' | 'orderRevision'>>;
}

export interface BomDto {
    id: string;
    bomNumber: string;
    /** MAIN = Haupt-BOM (BOM-MEK-00001) · SUB = Alt-BOM darunter. */
    kind: Bom['kind'];
    parentBomId: string | null;
    templateId: string | null;
    templateName: string;
    mainCard: string | null;
    area: Bom['area'];
    status: Bom['status'];
    approvedAt: string | null;
    completedAt: string | null;
    consumedAt: string | null;
    createdAt: string;
    updatedAt: string;
    lines: BomLineDto[];
    completion: BomCompletion;
    counts: { lines: number; missing: number; reserved: number; ordered: number };
    purchases: BomPurchaseDto[];
    /** Die geltende Revision (0 = die erste Freigabe). */
    revision: number;
    /** Die Revision im Entwurf — oder keine. */
    revisionDraft: BomRevisionDraftDto | null;
    /** Die freigegebenen Revisionen, älteste zuerst (Rev.0 = die erste Freigabe). */
    revisions: BomRevisionSummaryDto[];
}

const itemNumber = (value: unknown): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};

/** Der Wert einer eigenen Spalte der Position (`extras: [{ key, value }]`). */
const itemExtra = (item: Record<string, unknown>, key: string): string | null => {
    const entry = (Array.isArray(item.extras) ? item.extras : [])
        .find((extra) => extra && typeof extra === 'object' && (extra as { key?: unknown }).key === key) as { value?: unknown } | undefined;
    const value = String(entry?.value ?? '').trim();
    return value || null;
};

const quoteFileDto = (
    file: { quoteFileRef: string | null; quoteFileName: string | null; quoteFileType: string | null; quoteFileSize: number | null; quoteUploadedAt: Date | null },
    fallback: string,
) => (file.quoteFileRef
    ? { name: file.quoteFileName ?? fallback, type: file.quoteFileType, size: file.quoteFileSize, uploadedAt: iso(file.quoteUploadedAt) }
    : null);

export const purchaseDto = (
    link: BomPurchaseLink,
    order: BomPurchaseOrderRow,
    revision: {
        /** Die geltende Revision der BOM und die im Entwurf (null = keine). */
        current: number;
        draft: number | null;
        archive: Array<Omit<BomPurchaseRevision, 'previousOrder'>>;
    } = { current: link.bomRevision, draft: null, archive: [] },
): BomPurchaseDto => {
    const lines = order.items.map((item, index) => ({
        index,
        bomLineId: typeof item.bomLineId === 'string' ? item.bomLineId : null,
        code: typeof item.code === 'string' ? item.code : null,
        name: String(item.name ?? ''),
        model: itemExtra(item, 'stdModel'),
        unit: typeof item.unit === 'string' ? item.unit : null,
        quantity: round3(itemNumber(item.quantity)),
        received: round3(itemNumber(item.receivedQuantity)),
        grossPrice: itemNumber(item.grossPrice),
        netPrice: itemNumber(item.netPrice),
        lineTotal: itemNumber(item.lineTotal),
    }));
    const status = String(order.status).toUpperCase();
    const receivedLines = lines.filter((line) => line.quantity > 0 && line.received + 1e-9 >= line.quantity).length;
    return {
        purchaseOrderId: order.id,
        referenceNumber: order.referenceNumber,
        kind: link.kind,
        status,
        supplierName: order.supplierName,
        quoteNumber: order.quoteNumber,
        currency: order.currency,
        totalNet: order.totalNet,
        lineCount: lines.length,
        createdAt: order.createdAt.toISOString(),
        emailSentAt: iso(order.emailSentAt),
        sourcePurchaseOrderId: link.sourcePurchaseOrderId,
        quoteFile: link.quoteFileRef
            ? { name: link.quoteFileName ?? 'quote.pdf', type: link.quoteFileType, size: link.quoteFileSize, uploadedAt: iso(link.quoteUploadedAt) }
            : null,
        bomRevision: link.bomRevision,
        orderRevision: link.orderRevision,
        stale: link.kind === 'REQUEST' && link.bomRevision !== revision.current && link.bomRevision !== revision.draft,
        revisions: revision.archive
            .filter((entry) => entry.purchaseOrderId === link.purchaseOrderId)
            .sort((a, b) => a.number - b.number)
            .map((entry) => ({
                number: entry.number,
                bomRevision: entry.bomRevision,
                createdAt: entry.createdAt.toISOString(),
                previousStatus: entry.previousStatus,
                changes: entry.changes,
                quoteFile: quoteFileDto(entry, 'angebot.pdf'),
            })),
        checks: {
            quoteNumber: Boolean(order.quoteNumber?.trim()),
            quoteFile: Boolean(link.quoteFileRef),
            prices: lines.length > 0 && lines.every((line) => (line.grossPrice > 0 || line.netPrice > 0) && line.lineTotal > 0),
            confirmed: CONFIRMED_ORDER_STATUSES.has(status),
            received: lines.length > 0 && receivedLines === lines.length,
        },
        receivedLines,
        lines,
    };
};

const EMPTY_COVERAGE = (line: BomLine): BomLineDto['coverage'] => ({
    open: openOf(line),
    reserved: 0,
    incoming: 0,
    incomingConfirmed: 0,
    missing: openOf(line),
    serials: [],
});

export const bomDto = (
    bom: Bom,
    context: {
        coverage: Map<string, BomLineCoverage>;
        products: Map<string, BomStockProduct>;
        free: Map<string, number>;
        purchases: Array<{ link: BomPurchaseLink; order: BomPurchaseOrderRow }>;
        /** Nur die Haupt-BOM: ihre Alt-BOMs (für «BOM tamamla»). */
        subs?: Array<Pick<Bom, 'status' | 'consumedAt'>>;
        /** Die Revisionen DIESER BOM (freigegebene und die im Entwurf). */
        revisions?: BomRevision[];
        /** Die alten Fassungen ihrer Bestellungen. */
        purchaseRevisions?: Array<Omit<BomPurchaseRevision, 'previousOrder'>>;
        /** Namen der Personen (Kennung → Name). */
        names?: Map<string, string>;
    },
): BomDto => {
    const revisions = (context.revisions ?? []).filter((entry) => entry.bomId === bom.id);
    const draft = revisions.find((entry) => entry.status === 'DRAFT') ?? null;
    const nameOf = (id: string | null) => (id ? context.names?.get(id) ?? null : null);
    const purchases = context.purchases.map(({ link, order }) => purchaseDto(link, order, {
        current: bom.revision,
        draft: draft?.revision ?? null,
        archive: context.purchaseRevisions ?? [],
    }));
    const ordersByLine = new Map<string, BomLineOrderDto[]>();
    for (const purchase of purchases) {
        for (const line of purchase.lines) {
            if (!line.bomLineId) continue;
            const list = ordersByLine.get(line.bomLineId) ?? [];
            list.push({
                purchaseOrderId: purchase.purchaseOrderId,
                referenceNumber: purchase.referenceNumber,
                kind: purchase.kind,
                status: purchase.status,
                quantity: line.quantity,
                received: line.received,
            });
            ordersByLine.set(line.bomLineId, list);
        }
    }
    const active = bom.status !== 'DRAFT' && !bom.consumedAt;
    const lines: BomLineDto[] = bom.lines.map((line) => {
        const product = context.products.get(line.productId) ?? null;
        const entry = active ? context.coverage.get(line.id) : undefined;
        return {
            id: line.id,
            productId: line.productId,
            erpCode: product?.erpCode ?? line.erpCode,
            name: product?.name ?? line.name,
            brand: product?.brand ?? line.brand,
            modelNumber: product?.modelNumber ?? line.modelNumber,
            unit: line.unit,
            quantity: line.quantity,
            consumedQuantity: line.consumedQuantity,
            note: line.note,
            product: product ? productDto(product, context.free.get(product.productId)) : null,
            coverage: entry
                ? {
                    open: entry.open,
                    reserved: entry.reserved,
                    incoming: entry.incoming,
                    incomingConfirmed: entry.incomingConfirmed,
                    missing: entry.missing,
                    serials: entry.serials,
                }
                : bom.consumedAt
                    ? { open: 0, reserved: 0, incoming: 0, incomingConfirmed: 0, missing: 0, serials: [] }
                    : EMPTY_COVERAGE(line),
            orders: ordersByLine.get(line.id) ?? [],
        };
    });
    const orderRows = purchases.map((purchase) => ({
        kind: purchase.kind,
        confirmed: purchase.checks.confirmed,
        request: PRICE_REQUEST_STATUSES.has(purchase.status),
    }));
    const subs = (context.subs ?? []).map((sub) => ({ completed: sub.status === 'COMPLETED' || Boolean(sub.consumedAt) }));
    const completion = completionOf(bom, active ? context.coverage : new Map(), orderRows, subs);
    return {
        id: bom.id,
        bomNumber: bom.bomNumber,
        kind: bom.kind,
        parentBomId: bom.parentBomId,
        templateId: bom.templateId,
        templateName: bom.templateName,
        mainCard: bom.mainCard,
        area: bom.area,
        status: bom.status,
        approvedAt: iso(bom.approvedAt),
        completedAt: iso(bom.completedAt),
        consumedAt: iso(bom.consumedAt),
        createdAt: bom.createdAt.toISOString(),
        updatedAt: bom.updatedAt.toISOString(),
        lines,
        completion,
        counts: {
            lines: lines.length,
            missing: lines.filter((line) => line.coverage.missing > 1e-9).length,
            reserved: lines.filter((line) => line.coverage.open <= 1e-9 || line.coverage.reserved + 1e-9 >= line.coverage.open).length,
            ordered: lines.filter((line) => line.orders.some((order) => order.kind === 'ORDER')).length,
        },
        purchases,
        revision: bom.revision,
        revisionDraft: draft && !bom.consumedAt
            ? {
                id: draft.id,
                revision: draft.revision,
                reason: draft.reason,
                createdAt: draft.createdAt.toISOString(),
                createdByName: nameOf(draft.createdById),
                updatedAt: draft.updatedAt.toISOString(),
                lines: draft.lines.map((line) => {
                    const product = context.products.get(line.productId) ?? null;
                    return {
                        id: line.id,
                        productId: line.productId,
                        erpCode: product?.erpCode ?? line.erpCode,
                        name: product?.name ?? line.name,
                        brand: product?.brand ?? line.brand,
                        modelNumber: product?.modelNumber ?? line.modelNumber,
                        unit: line.unit,
                        quantity: line.quantity,
                        note: line.note,
                        product: product ? productDto(product, context.free.get(product.productId)) : null,
                    };
                }),
            }
            : null,
        revisions: revisionHistory(bom, revisions, nameOf),
    };
};

/**
 * Die Geschichte einer BOM: die freigegebenen Revisionen, älteste zuerst. Eine
 * BOM, die vor den Revisionen freigegeben wurde, hat noch keinen Abzug ihrer
 * Rev.0 — dann steht Rev.0 aus der BOM selbst da (ihre Zeilen haben sich seit
 * der Freigabe nicht geändert).
 */
const revisionHistory = (bom: Bom, revisions: BomRevision[], nameOf: (id: string | null) => string | null): BomRevisionSummaryDto[] => {
    if (bom.status === 'DRAFT' && !bom.revision) return [];
    const approved = revisions.filter((entry) => entry.status === 'APPROVED').sort((a, b) => a.revision - b.revision);
    const history: BomRevisionSummaryDto[] = approved.map((entry) => ({
        revision: entry.revision,
        reason: entry.reason,
        approvedAt: iso(entry.approvedAt),
        approvedByName: nameOf(entry.approvedById),
        changes: entry.changes,
        orderActions: entry.orderActions.map((action) => ({
            purchaseOrderId: action.purchaseOrderId,
            referenceNumber: action.referenceNumber,
            supplierName: action.supplierName,
            action: action.action,
            orderRevision: action.orderRevision,
        })),
    }));
    if (!history.some((entry) => entry.revision === 0)) {
        history.unshift({ revision: 0, reason: null, approvedAt: iso(bom.approvedAt), approvedByName: nameOf(bom.approvedById), changes: [], orderActions: [] });
    }
    return history;
};
