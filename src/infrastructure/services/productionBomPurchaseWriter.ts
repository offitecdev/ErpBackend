import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';

import prisma from '../database/prisma.client';
import type { BomPurchaseLineRecord, BomUnit } from '../../domain/entities/ProductionBom';
import {
    ORDER_UNIT_LABELS,
    acceptsMoreLines,
    mergeLinkRecords,
    mergeOrderItems,
    round3,
} from '../../domain/services/productionBom';
import {
    STANDARD_ORDER_COLUMNS,
    STANDARD_REQUEST_COLUMNS,
    ensureStandardTemplate,
    standardHiddenKeysJson,
} from '../../shared/standardOrderTemplate';
/* Die Lieferantenbestellung hat EINE Rechenstelle — die Hilfen stehen in
   inventory.routes.ts und werden hier nur zur Laufzeit gerufen (wie in
   projectProcurement.routes.ts). inventory.routes selbst importiert diese
   Datei NICHT (nur den Wächter), darum entsteht kein Ring. */
import {
    nextPurchaseReference,
    normalizePurchaseOrderItems,
    purchaseOrderTotalVat,
    resolvePurchaseOrderSupplier,
} from '../../presentation/routes/inventory.routes';
import { productionModule } from '../../presentation/composition/productionModule';

/**
 * ── DIE BESTELLUNGEN EINER BOM SCHREIBEN (27.09.2026) ───────────────────────
 *
 * «Siparişler projeden geldiği belli olmalı — proje, cihaz ve sipariş
 *  numaramız … erp kodu, ürün adı, birim fiyat, miktar, net fiyat, satır
 *  fiyatı.»
 *
 * Eine BOM-Bestellung ist eine gewöhnliche Lieferantenbestellung
 * (ORDER_DRAFT, Standardvorlage, eigene BE-Nummer) mit drei Besonderheiten:
 *   · vorn eine Spalte «ERP-Code» (`stdErp`, eine eigene Angabe der Zeile) —
 *     so steht der Code in Tabelle UND PDF, ohne das PDF anzufassen;
 *   · jede Position trägt ihre BOM-Zeile (`bomLineId`) und ihr Gerät;
 *   · die Bestellung ist dem Produktionsprojekt und Gerät zugeordnet
 *     (uretim_siparis_atamalari) — sie erscheint dort wie jede andere.
 */

export const ERP_COLUMN_KEY = 'stdErp';
const ERP_COLUMN_NAME = 'ERP-Code';
/* Die Preisanfrage trägt statt des ERP-Codes das MODELL des Produkts (Samet,
   27.09.2026: «fiyat talebinde sadece ürün adı, miktarı, modeli ile aktarım
   yapılsın») — eine eigene Spalte gleich nach dem Namen. Der Name steht in
   den drei Sprachen in `utils/standardOrderColumns.ts` (Oberfläche und PDF). */
export const MODEL_COLUMN_KEY = 'stdModel';
const MODEL_COLUMN_NAME = 'Modell';

/** Die Einheit einer BOM-Zeile, wie sie in der Bestellung steht (eine Liste mit der Revision). */
const UNIT_LABELS: Record<BomUnit, string> = ORDER_UNIT_LABELS;

export interface BomOrderDraftLine {
    bomLineId: string;
    erpCode: string | null;
    name: string;
    brand: string | null;
    modelNumber: string | null;
    unit: BomUnit;
    quantity: number;
}

/** Bestellung: ERP-Code vorn, dann die Standardvorlage. */
const orderColumnsJson = (): string => JSON.stringify([
    { key: ERP_COLUMN_KEY, name: ERP_COLUMN_NAME, label: null, type: 'text' },
    ...STANDARD_ORDER_COLUMNS.map(({ key, name, label, type }) => ({ key, name, label, type })),
]);

/** Preisanfrage: Produkt · Modell · Menge — kein ERP-Code, keine Preise. */
const requestColumnsJson = (): string => JSON.stringify(STANDARD_REQUEST_COLUMNS.flatMap(({ key, name, label, type }) => [
    { key, name, label, type },
    ...(label === 'productName' ? [{ key: MODEL_COLUMN_KEY, name: MODEL_COLUMN_NAME, label: null, type: 'text' }] : []),
]));

/** Eine Zeile der Preisanfrage — ohne Hersteller, ohne ERP-Spalte. */
export interface BomRequestDraftLine {
    bomLineId: string;
    erpCode: string | null;
    name: string;
    modelNumber: string | null;
    unit: BomUnit;
    quantity: number;
}

/** Name + Hersteller und Modellnummer — das braucht der Lieferant, um zu verstehen, was gemeint ist. */
const lineName = (line: BomOrderDraftLine): string => {
    const maker = [line.brand, line.modelNumber].filter((part) => part && part.trim()).join(' ');
    return (maker && !line.name.includes(line.modelNumber ?? '\u0000') ? `${line.name} · ${maker}` : line.name).slice(0, 500);
};

const itemOf = (line: BomOrderDraftLine, productionItemId: string) => ({
    itemType: 'PRODUCT',
    articleId: null,
    code: line.erpCode,
    name: lineName(line),
    quantity: round3(line.quantity),
    unit: UNIT_LABELS[line.unit] ?? 'Adet',
    grossPrice: 0,
    netPrice: 0,
    discount: 0,
    discount2: 0,
    vatRate: 0,
    calcMode: 'DIRECT',
    directCopy: true,
    lineTotal: 0,
    extras: [{ key: ERP_COLUMN_KEY, name: ERP_COLUMN_NAME, value: line.erpCode ?? '', width: 130 }],
    bomLineId: line.bomLineId,
    productionItemId,
});

const employeeName = async (userId: string): Promise<string | null> => {
    const employee = await prisma.employee.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } }).catch(() => null);
    const name = `${employee?.firstName ?? ''} ${employee?.lastName ?? ''}`.trim();
    return name || null;
};

/** Höchstzahl Positionen einer Bestellung — dieselbe Grenze wie `normalizePurchaseOrderItems`. */
const ORDER_ITEMS_MAX = 500;

const parseItems = (raw: unknown): Array<Record<string, unknown>> => {
    try {
        const parsed = JSON.parse(String(raw ?? '[]'));
        return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
    } catch {
        return [];
    }
};

/** Die Zeilen der Verknüpfung, wie sie gespeichert sind (uretim_bom_siparisleri.lines). */
const linkRecordsOf = (raw: Prisma.JsonValue | null): BomPurchaseLineRecord[] =>
    (Array.isArray(raw) ? raw : []).flatMap((entry): BomPurchaseLineRecord[] => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const record = entry as Record<string, unknown>;
        const bomLineId = typeof record.bomLineId === 'string' ? record.bomLineId : '';
        if (!bomLineId) return [];
        const minimum = Number(record.minimum);
        return [{
            bomLineId,
            missing: round3(Number(record.missing) || 0),
            minimum: record.minimum === null || record.minimum === undefined || !Number.isFinite(minimum) ? null : minimum,
            ordered: round3(Number(record.ordered) || 0),
            note: typeof record.note === 'string' && record.note.trim() ? record.note : null,
        }];
    });

/** Jemand hat die Bestellung zwischen Lesen und Schreiben gespeichert — noch einmal lesen. */
class OrderChangedMeanwhile extends Error {}

export class BomPurchaseOrderWriter {
    /** Neue Bestellung (ORDER_DRAFT) für EINEN Lieferanten mit diesen Zeilen. */
    async createOrder(input: {
        tenantId: string;
        userId: string;
        supplier: { supplierId: string | null; supplierName: string };
        projectLabel: string;
        productionProjectId: string;
        productionItemId: string;
        lines: BomOrderDraftLine[];
    }): Promise<{ id: string; referenceNumber: string; supplierName: string }> {
        const { tenantId, userId } = input;
        await ensureStandardTemplate(tenantId, 'ORDER');
        const supplier = await resolvePurchaseOrderSupplier(tenantId, {
            supplierId: input.supplier.supplierId,
            supplierName: input.supplier.supplierName,
        });
        const [record, last, orderedBy] = await Promise.all([
            prisma.supplier.findFirst({ where: { id: supplier.supplierId, tenantId } }),
            prisma.purchaseOrder.findFirst({
                where: { tenantId },
                orderBy: { createdAt: 'desc' },
                select: { vatMode: true, orderVatRate: true, orderVatCountry: true, currency: true },
            }),
            employeeName(userId),
        ]);
        const normalized = normalizePurchaseOrderItems(input.lines.map((line) => itemOf(line, input.productionItemId)));
        // KDV: wie jede neue Bestellung — Angabe des Lieferanten, sonst die der letzten Bestellung.
        const vatLiable = record?.vatLiable;
        const vat = typeof vatLiable === 'boolean'
            ? { vatMode: 'TOTAL', orderVatRate: vatLiable ? Number(record?.vatRate) || 0 : 0 }
            : { vatMode: last?.vatMode === 'TOTAL' ? 'TOTAL' : 'LINE', orderVatRate: Number(last?.orderVatRate) || 0 };
        const vatCountry = typeof vatLiable === 'boolean'
            ? (vatLiable ? record?.vatCountry ?? null : last?.orderVatCountry ?? null)
            : last?.orderVatCountry ?? null;

        let row: { id: string; referenceNumber: string; status: string; supplierName: string; currency: string; items: string } | null = null;
        for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
            const referenceNumber = await nextPurchaseReference(tenantId, 'ORDER');
            try {
                row = await prisma.purchaseOrder.create({
                    data: {
                        id: nanoid(12),
                        tenantId,
                        referenceNumber,
                        orderNumber: referenceNumber,
                        status: 'ORDER_DRAFT',
                        orderedByName: orderedBy,
                        projectName: input.projectLabel.slice(0, 190) || null,
                        tableColumns: orderColumnsJson(),
                        hiddenColumnKeys: standardHiddenKeysJson('ORDER'),
                        vatMode: vat.vatMode,
                        orderVatRate: vat.orderVatRate,
                        orderVatCountry: vatCountry,
                        supplierId: supplier.supplierId,
                        supplierName: supplier.supplierName,
                        supplierEmail: supplier.supplierEmail,
                        supplierAddress: supplier.supplierAddress,
                        items: JSON.stringify(normalized.items),
                        additionalFees: '[]',
                        currency: last?.currency || 'CHF',
                        totalNet: normalized.totalNet,
                        totalGross: normalized.totalGross,
                        totalVat: purchaseOrderTotalVat(vat, normalized.totalNet, 0, normalized.totalVat, normalized.items.map((item: { lineTotal: number }) => item.lineTotal)),
                        totalFees: 0,
                        createdByEmpId: userId,
                    },
                    select: { id: true, referenceNumber: true, status: true, supplierName: true, currency: true, items: true },
                });
            } catch (error: unknown) {
                if ((error as { code?: string })?.code !== 'P2002') throw error;
            }
        }
        if (!row) throw new Error('Bestellnummer konnte nicht vergeben werden.');
        await this.assignProduction(tenantId, row, input.productionProjectId, input.productionItemId, userId);
        return { id: row.id, referenceNumber: row.referenceNumber, supplierName: row.supplierName };
    }

    /**
     * «Aynı tedarikçiye ait … zaten olan siparişe eklenir (aynı BOM altında)»
     * (Samet, 27.09.2026): die Zeilen kommen in die Bestellung, die der
     * Lieferant in DIESER BOM schon hat — Positionen, Summen und die Zeilen der
     * Verknüpfung in EINEM Vorgang. Was der Einkauf dort schon eingetragen hat
     * (Preise, Angebotsnummer, eigene Spalten), bleibt stehen.
     *
     * `null` = die Bestellung nimmt nichts mehr auf (inzwischen beim
     * Lieferanten, gelöscht, voll) — dann legt der Aufrufer eine neue an.
     */
    async appendToOrder(input: {
        tenantId: string;
        userId: string;
        purchaseOrderId: string;
        bomId: string;
        /** Die BOM-Revision, nach der jetzt bestellt wird — die Verknüpfung gilt ab da für sie. */
        bomRevision: number;
        productionItemId: string;
        lines: BomOrderDraftLine[];
        records: BomPurchaseLineRecord[];
    }): Promise<{ id: string; referenceNumber: string; supplierName: string } | null> {
        const { tenantId, userId } = input;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            let row: { id: string; referenceNumber: string; status: string; supplierName: string; currency: string; items: string } | null;
            try {
                row = await prisma.$transaction(async (tx) => {
                    const order = await tx.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, tenantId } });
                    if (!order || !acceptsMoreLines(order)) return null;
                    const link = await tx.productionBomPurchase.findFirst({
                        where: { tenantId, purchaseOrderId: order.id, bomId: input.bomId, kind: 'ORDER' },
                    });
                    if (!link) return null;
                    const items = mergeOrderItems(
                        parseItems(order.items),
                        input.lines.map((line) => itemOf(line, input.productionItemId)),
                    );
                    if (items.length > ORDER_ITEMS_MAX) return null;
                    const normalized = normalizePurchaseOrderItems(items);
                    const vat = { vatMode: String(order.vatMode || 'LINE'), orderVatRate: Number(order.orderVatRate) || 0 };
                    // Nur auf den gelesenen Stand — sonst gingen Preise verloren, die gerade jemand speichert.
                    const written = await tx.purchaseOrder.updateMany({
                        where: { id: order.id, tenantId, updatedAt: order.updatedAt },
                        data: {
                            items: JSON.stringify(normalized.items),
                            totalNet: normalized.totalNet,
                            totalGross: normalized.totalGross,
                            totalVat: purchaseOrderTotalVat(
                                vat,
                                normalized.totalNet,
                                Number(order.totalFees) || 0,
                                normalized.totalVat,
                                normalized.items.map((item: { lineTotal: number }) => item.lineTotal),
                            ),
                        },
                    });
                    if (!written.count) throw new OrderChangedMeanwhile();
                    await tx.productionBomPurchase.update({
                        where: { id: link.id },
                        data: {
                            lines: mergeLinkRecords(linkRecordsOf(link.lines), input.records, normalized.items) as unknown as Prisma.InputJsonValue,
                            bomRevision: input.bomRevision,
                        },
                    });
                    return {
                        id: order.id,
                        referenceNumber: order.referenceNumber,
                        status: order.status,
                        supplierName: order.supplierName,
                        currency: order.currency,
                        items: JSON.stringify(normalized.items),
                    };
                });
            } catch (error) {
                if (error instanceof OrderChangedMeanwhile) continue;
                throw error;
            }
            if (!row) return null;
            // Wie beim Anlegen: die Produktion führt die Zeilen der Bestellung (auch im Entwurf).
            if (await productionModule.purchaseLink.isEnabled(tenantId).catch(() => false)) {
                await productionModule.purchaseLink.syncConfirmedLines(tenantId, row, userId).catch(() => undefined);
            }
            return { id: row.id, referenceNumber: row.referenceNumber, supplierName: row.supplierName };
        }
        throw new Error('Die Bestellung wird gerade von jemand anderem bearbeitet — bitte noch einmal versuchen.');
    }

    /**
     * «Fiyat talebi» einer BOM im ENTWURF (27.09.2026, Vorgabe Samet: «bom
     * onaylanmamış olması gerekir … fiyat talepleri ayrı ayrı tedarikçiler
     * üzerinden açılsın»): EINE Preisanfrage (DRAFT, neue PA-Nummer) für EINEN
     * Lieferanten. Sie trägt nur Produktname, Modell und Menge — keine Preise,
     * keinen sichtbaren ERP-Code, kein Angebot und keine Angebotsnummer — und
     * wird nie zur Bestellung: bestellt wird aus der freigegebenen BOM.
     */
    async createRequest(input: {
        tenantId: string;
        userId: string;
        supplier: { supplierId: string | null; supplierName: string };
        projectLabel: string;
        productionProjectId: string;
        productionItemId: string;
        lines: BomRequestDraftLine[];
    }): Promise<{ id: string; referenceNumber: string; supplierName: string }> {
        const { tenantId, userId } = input;
        await ensureStandardTemplate(tenantId, 'PRICE_REQUEST');
        const supplier = await resolvePurchaseOrderSupplier(tenantId, {
            supplierId: input.supplier.supplierId,
            supplierName: input.supplier.supplierName,
        });
        const [last, orderedBy] = await Promise.all([
            prisma.purchaseOrder.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: { currency: true } }),
            employeeName(userId),
        ]);
        const normalized = normalizePurchaseOrderItems(input.lines.map((line) => ({
            itemType: 'PRODUCT',
            articleId: null,
            // Der ERP-Code reist still mit (Suche, Zuordnung) — gedruckt wird er nie.
            code: line.erpCode,
            name: line.name.slice(0, 500),
            quantity: round3(line.quantity),
            unit: UNIT_LABELS[line.unit] ?? 'Adet',
            grossPrice: 0,
            netPrice: 0,
            discount: 0,
            discount2: 0,
            vatRate: 0,
            calcMode: 'DIRECT',
            directCopy: true,
            lineTotal: 0,
            extras: line.modelNumber?.trim()
                ? [{ key: MODEL_COLUMN_KEY, name: MODEL_COLUMN_NAME, value: line.modelNumber.trim(), width: 180 }]
                : [],
            bomLineId: line.bomLineId,
            productionItemId: input.productionItemId,
        })));
        let row: { id: string; referenceNumber: string; status: string; supplierName: string; currency: string; items: string } | null = null;
        for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
            const referenceNumber = await nextPurchaseReference(tenantId, 'PRICE_REQUEST');
            try {
                row = await prisma.purchaseOrder.create({
                    data: {
                        id: nanoid(12),
                        tenantId,
                        referenceNumber,
                        priceRequestNumber: referenceNumber,
                        status: 'DRAFT',
                        orderedByName: orderedBy,
                        projectName: input.projectLabel.slice(0, 190) || null,
                        tableColumns: requestColumnsJson(),
                        hiddenColumnKeys: standardHiddenKeysJson('PRICE_REQUEST'),
                        supplierId: supplier.supplierId,
                        supplierName: supplier.supplierName,
                        supplierEmail: supplier.supplierEmail,
                        supplierAddress: supplier.supplierAddress,
                        // Genau EIN Lieferant je Anfrage — sein PDF, seine Mail.
                        requestSuppliers: JSON.stringify([{
                            supplierId: supplier.supplierId,
                            supplierName: supplier.supplierName,
                            supplierEmail: supplier.supplierEmail,
                            supplierAddress: supplier.supplierAddress,
                            emailSentAt: null,
                            emailRecipient: null,
                        }]),
                        items: JSON.stringify(normalized.items),
                        additionalFees: '[]',
                        currency: last?.currency || 'CHF',
                        // Eine Anfrage kennt keine Beträge — also auch keine Steuer.
                        vatMode: 'TOTAL',
                        orderVatRate: 0,
                        orderVatCountry: null,
                        totalNet: 0,
                        totalGross: 0,
                        totalVat: 0,
                        totalFees: 0,
                        createdByEmpId: userId,
                    },
                    select: { id: true, referenceNumber: true, status: true, supplierName: true, currency: true, items: true },
                });
            } catch (error: unknown) {
                if ((error as { code?: string })?.code !== 'P2002') throw error;
            }
        }
        if (!row) throw new Error('Nummer der Preisanfrage konnte nicht vergeben werden.');
        await this.assignProduction(tenantId, row, input.productionProjectId, input.productionItemId, userId);
        return { id: row.id, referenceNumber: row.referenceNumber, supplierName: row.supplierName };
    }

    /** Die Angebotsnummer des Lieferanten («tedarikçi sipariş numarası») — sie steht im PDF. */
    async setQuoteNumber(tenantId: string, purchaseOrderId: string, quoteNumber: string | null): Promise<boolean> {
        const order = await prisma.purchaseOrder.findFirst({
            where: { id: purchaseOrderId, tenantId },
            select: { id: true, emailSentAt: true, quoteNumber: true },
        });
        if (!order) return false;
        if ((order.quoteNumber ?? null) === quoteNumber) return true;
        await prisma.purchaseOrder.update({
            where: { id: order.id },
            // Mail schon draussen: die nächste trägt «aktualisiert».
            data: { quoteNumber, ...(order.emailSentAt ? { revision: { increment: 1 } } : {}) },
        });
        return true;
    }

    /**
     * Wareneingang in die Positionen schreiben (`receivedQuantity`/`receivedAt`)
     * und den Stand nachziehen: alles da → COMPLETED. Der Bestand selbst geht
     * ins Depo (der Anwendungsfall), nicht ins Artikellager.
     */
    async applyReceipt(input: {
        tenantId: string;
        userId: string;
        purchaseOrderId: string;
        received: Array<{ index: number; quantity: number }>;
    }): Promise<{ status: string; items: Array<Record<string, unknown>> }> {
        const { tenantId } = input;
        const order = await prisma.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, tenantId } });
        if (!order) throw new Error('Bestellung nicht gefunden.');
        let items: Array<Record<string, unknown>> = [];
        try { items = JSON.parse(order.items || '[]'); } catch { items = []; }
        const now = new Date().toISOString();
        for (const entry of input.received) {
            const item = items[entry.index];
            if (!item) continue;
            const ordered = Number(item.quantity) || 0;
            const already = Number(item.receivedQuantity) || 0;
            item.receivedQuantity = round3(Math.min(ordered, already + entry.quantity));
            item.receivedAt = now;
        }
        const complete = items.length > 0 && items.every((item) => (Number(item.receivedQuantity) || 0) + 1e-9 >= (Number(item.quantity) || 0));
        const status = complete ? 'COMPLETED' : order.status;
        const updated = await prisma.purchaseOrder.update({
            where: { id: order.id },
            data: {
                items: JSON.stringify(items),
                status,
                ...(complete && !order.stockedAt ? { stockedAt: new Date() } : {}),
            },
            select: { id: true, referenceNumber: true, status: true, supplierName: true, currency: true, items: true },
        });
        if (await productionModule.purchaseLink.isEnabled(tenantId)) {
            await productionModule.purchaseLink.syncConfirmedLines(tenantId, updated, input.userId).catch(() => undefined);
        }
        return { status: updated.status, items };
    }

    /**
     * «Geri al» einer Depo-Buchung (28.09.2026): die Stücke kommen aus den
     * Positionen wieder heraus. Eine Bestellung, die dadurch nicht mehr ganz
     * geliefert ist, wartet wieder (MAL KABULDE) — nie unter 0.
     */
    async revertReceipt(input: {
        tenantId: string;
        userId: string;
        purchaseOrderId: string;
        reverted: Array<{ index: number; quantity: number }>;
    }): Promise<{ status: string }> {
        const { tenantId } = input;
        const order = await prisma.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, tenantId } });
        if (!order) throw new Error('Bestellung nicht gefunden.');
        let items: Array<Record<string, unknown>> = [];
        try { items = JSON.parse(order.items || '[]'); } catch { items = []; }
        for (const entry of input.reverted) {
            const item = items[entry.index];
            if (!item) continue;
            const left = round3(Math.max(0, (Number(item.receivedQuantity) || 0) - entry.quantity));
            item.receivedQuantity = left;
            if (left <= 0) delete item.receivedAt;
        }
        const complete = items.length > 0 && items.every((item) => (Number(item.receivedQuantity) || 0) + 1e-9 >= (Number(item.quantity) || 0));
        const reopened = String(order.status).toUpperCase() === 'COMPLETED' && !complete;
        const updated = await prisma.purchaseOrder.update({
            where: { id: order.id },
            data: {
                items: JSON.stringify(items),
                ...(reopened ? { status: 'TO_BE_STOCKED', stockedAt: null } : {}),
            },
            select: { id: true, referenceNumber: true, status: true, supplierName: true, currency: true, items: true },
        });
        if (await productionModule.purchaseLink.isEnabled(tenantId)) {
            await productionModule.purchaseLink.syncConfirmedLines(tenantId, updated, input.userId).catch(() => undefined);
        }
        return { status: updated.status };
    }

    /** Die Bestellung steht beim Produktionsprojekt und Gerät (wie jede zugeordnete). */
    private async assignProduction(
        tenantId: string,
        row: { id: string; referenceNumber: string; status: string; supplierName: string; currency: string; items: string },
        productionProjectId: string,
        productionItemId: string,
        userId: string,
    ): Promise<void> {
        try {
            if (!(await productionModule.purchaseLink.isEnabled(tenantId))) return;
            await productionModule.purchaseLink.saveAssignment(tenantId, row.id, {
                productionProjectId,
                productionItemIds: [productionItemId],
            }, userId);
            await productionModule.purchaseLink.syncConfirmedLines(tenantId, row, userId);
        } catch (error) {
            // Die Zuordnung ist Beiwerk — die Bestellung steht trotzdem.
            console.warn('[production-bom] assignment failed', row.id, (error as Error)?.message);
        }
    }
}
