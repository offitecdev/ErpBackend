"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.revisionHistory = exports.bomDto = exports.purchaseDto = exports.bomLinesDto = exports.bomSummaryDto = exports.bomActivity = exports.templateDto = exports.productDto = exports.templateSummaryDto = void 0;
const productionBom_1 = require("../../../../domain/services/productionBom");
/**
 * ── WAS DIE OBERFLÄCHE SIEHT (27.09.2026) ────────────────────────────────────
 * Spiegel: ErpFront/offitec-frontend/src/types/productionBom.ts.
 */
const iso = (value) => (value ? value.toISOString() : null);
const templateSummaryDto = (summary) => ({
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
exports.templateSummaryDto = templateSummaryDto;
const productDto = (product, free) => ({
    id: product.productId,
    erpCode: product.erpCode,
    name: product.name,
    brand: product.brand,
    modelNumber: product.modelNumber,
    productCode: product.productCode ?? null,
    unit: product.unit ?? null,
    isDraft: Boolean(product.isDraft),
    materialGroupName: product.materialGroupName ?? null,
    description: product.description,
    supplierName: product.suppliers[0]?.name ?? null,
    suppliers: product.suppliers.map((entry) => ({ id: entry.supplierId, name: entry.name, hasEmail: Boolean(entry.email) })),
    quantity: product.quantity,
    free: (0, productionBom_1.round3)(free ?? product.quantity),
    serialRequired: product.serialRequired,
    minimumOrderQuantity: product.minimumOrderQuantity,
    hasErpCode: Boolean(product.erpCode),
});
exports.productDto = productDto;
const templateDto = (template, products, free, usedBy) => ({
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
            product: product ? (0, exports.productDto)(product, free.get(product.productId)) : null,
        };
    }),
});
exports.templateDto = templateDto;
const bomActivity = (bom) => {
    if (bom.activity)
        return bom.activity;
    const priceRequests = {};
    for (const request of bom.procurement) {
        if (request.kind !== 'PRICE' || request.status === 'CANCELLED')
            continue;
        for (const line of request.lines)
            priceRequests[line.bomLineId] ??= request.requestNumber;
    }
    const received = {};
    for (const entry of bom.goodsIn) {
        if (entry.lineId)
            received[entry.lineId] = (received[entry.lineId] ?? 0) + entry.quantity;
    }
    const orders = bom.purchases.filter((order) => order.kind === 'ORDER');
    const needing = bom.status === 'DRAFT' && !bom.consumedAt ? bom.lines : bom.lines.filter((line) => line.coverage.missing > 1e-9);
    return {
        requestsCount: bom.procurement.length, goodsCount: bom.goodsIn.length, priceRequests, received,
        orderCount: orders.length, confirmedOrders: orders.filter((order) => order.checks.confirmed).length,
        needing: needing.length, requestedNeeding: needing.filter((line) => Boolean(priceRequests[line.id])).length,
    };
};
exports.bomActivity = bomActivity;
const bomSummaryDto = (bom) => ({
    id: bom.id, bomNumber: bom.bomNumber, kind: bom.kind, parentBomId: bom.parentBomId,
    templateName: bom.templateName, area: bom.area, status: bom.status, consumedAt: bom.consumedAt,
    revision: bom.revision, updatedAt: bom.updatedAt, completion: bom.completion, counts: bom.counts,
    activity: { ...(0, exports.bomActivity)(bom), priceRequests: {}, received: {} },
});
exports.bomSummaryDto = bomSummaryDto;
const bomLinesDto = (bom) => ({
    ...bom, activity: (0, exports.bomActivity)(bom), purchases: [], revisions: [], procurement: [], goodsIn: [],
});
exports.bomLinesDto = bomLinesDto;
const itemNumber = (value) => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};
/** Der Wert einer eigenen Spalte der Position (`extras: [{ key, value }]`). */
const itemExtra = (item, key) => {
    const entry = (Array.isArray(item.extras) ? item.extras : [])
        .find((extra) => extra && typeof extra === 'object' && extra.key === key);
    const value = String(entry?.value ?? '').trim();
    return value || null;
};
const quoteFileDto = (file, fallback) => (file.quoteFileRef
    ? { name: file.quoteFileName ?? fallback, type: file.quoteFileType, size: file.quoteFileSize, uploadedAt: iso(file.quoteUploadedAt) }
    : null);
const purchaseDto = (link, order, revision = { current: link.bomRevision, draft: null, archive: [] }) => {
    const lines = order.items.map((item, index) => ({
        index,
        bomLineId: typeof item.bomLineId === 'string' ? item.bomLineId : null,
        code: typeof item.code === 'string' ? item.code : null,
        name: String(item.name ?? ''),
        model: itemExtra(item, 'stdModel'),
        unit: typeof item.unit === 'string' ? item.unit : null,
        quantity: (0, productionBom_1.round3)(itemNumber(item.quantity)),
        received: (0, productionBom_1.round3)(itemNumber(item.receivedQuantity)),
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
            confirmed: productionBom_1.CONFIRMED_ORDER_STATUSES.has(status),
            received: lines.length > 0 && receivedLines === lines.length,
        },
        receivedLines,
        lines,
    };
};
exports.purchaseDto = purchaseDto;
const EMPTY_COVERAGE = (line) => ({
    open: (0, productionBom_1.openOf)(line),
    reserved: 0,
    incoming: 0,
    incomingConfirmed: 0,
    missing: (0, productionBom_1.openOf)(line),
    serials: [],
});
const bomDto = (bom, context) => {
    const revisions = (context.revisions ?? []).filter((entry) => entry.bomId === bom.id);
    const draft = revisions.find((entry) => entry.status === 'DRAFT') ?? null;
    const nameOf = (id) => (id ? context.names?.get(id) ?? null : null);
    const purchases = context.purchases.map(({ link, order }) => (0, exports.purchaseDto)(link, order, {
        current: bom.revision,
        draft: draft?.revision ?? null,
        archive: context.purchaseRevisions ?? [],
    }));
    const ordersByLine = new Map();
    for (const purchase of purchases) {
        for (const line of purchase.lines) {
            if (!line.bomLineId)
                continue;
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
    const lines = bom.lines.map((line) => {
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
            product: product ? (0, exports.productDto)(product, context.free.get(product.productId)) : null,
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
        request: productionBom_1.PRICE_REQUEST_STATUSES.has(purchase.status),
    }));
    const subs = (context.subs ?? []).map((sub) => ({ completed: sub.status === 'COMPLETED' || Boolean(sub.consumedAt) }));
    const completion = (0, productionBom_1.completionOf)(bom, active ? context.coverage : new Map(), orderRows, subs);
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
                approval: (() => {
                    const entry = context.approvals?.get(draft.id);
                    return entry && entry.action !== 'APPROVED'
                        ? { state: entry.action, at: entry.at.toISOString(), byName: entry.actorName, note: entry.note }
                        : null;
                })(),
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
                        product: product ? (0, exports.productDto)(product, context.free.get(product.productId)) : null,
                    };
                }),
            }
            : null,
        revisions: (0, exports.revisionHistory)(bom, revisions, nameOf),
        procurement: context.procurement ?? [],
        goodsIn: context.goodsIn ?? [],
    };
};
exports.bomDto = bomDto;
/**
 * Die Geschichte einer BOM: die freigegebenen Revisionen, älteste zuerst. Eine
 * BOM, die vor den Revisionen freigegeben wurde, hat noch keinen Abzug ihrer
 * Rev.0 — dann steht Rev.0 aus der BOM selbst da (ihre Zeilen haben sich seit
 * der Freigabe nicht geändert).
 */
const revisionHistory = (bom, revisions, nameOf) => {
    if (bom.status === 'DRAFT' && !bom.revision)
        return [];
    const approved = revisions.filter((entry) => entry.status === 'APPROVED').sort((a, b) => a.revision - b.revision);
    const history = approved.map((entry) => ({
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
exports.revisionHistory = revisionHistory;
//# sourceMappingURL=bomReadModel.js.map