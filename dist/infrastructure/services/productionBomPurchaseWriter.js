"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BomPurchaseOrderWriter = exports.MODEL_COLUMN_KEY = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const productionBom_1 = require("../../domain/services/productionBom");
const standardOrderTemplate_1 = require("../../shared/standardOrderTemplate");
/* Die Lieferantenbestellung hat EINE Rechenstelle — die Hilfen stehen in
   inventory.routes.ts und werden hier nur zur Laufzeit gerufen (wie in
   projectProcurement.routes.ts). inventory.routes selbst importiert diese
   Datei NICHT (nur den Wächter), darum entsteht kein Ring. */
const inventory_routes_1 = require("../../presentation/routes/inventory.routes");
const productionModule_1 = require("../../presentation/composition/productionModule");
/**
 * ── DIE BESTELLUNGEN EINER BOM SCHREIBEN (27.09.2026) ───────────────────────
 *
 * «Siparişler projeden geldiği belli olmalı — proje, cihaz ve sipariş
 *  numaramız … erp kodu, ürün adı, birim fiyat, miktar, net fiyat, satır
 *  fiyatı.»
 *
 * Eine BOM-Bestellung ist eine gewöhnliche Lieferantenbestellung
 * (ORDER_DRAFT, Standardvorlage, eigene BE-Nummer) mit zwei Besonderheiten:
 *   · jede Position trägt ihre BOM-Zeile (`bomLineId`) und ihr Gerät;
 *   · die Bestellung ist dem Produktionsprojekt und Gerät zugeordnet
 *     (uretim_siparis_atamalari) — sie erscheint dort wie jede andere.
 *
 * KEIN ERP-CODE AUF DEM BELEG (29.09.2026, Samet: «sipariş PDF'lerinde ERP
 * kodları gözükmesin, satırlarda da gözükmesin — sipariş, hani aktarım
 * yapıyoruz»): die frühere Spalte «ERP-Code» vorn (`stdErp`) wird nicht mehr
 * geschrieben. Der Code reist nur noch im Feld `code` der Position mit — das
 * zeigt weder die Tabelle noch ein PDF; der Wareneingang braucht ihn.
 */
/* Die Preisanfrage trägt statt des ERP-Codes das MODELL des Produkts (Samet,
   27.09.2026: «fiyat talebinde sadece ürün adı, miktarı, modeli ile aktarım
   yapılsın») — eine eigene Spalte gleich nach dem Namen. Der Name steht in
   den drei Sprachen in `utils/standardOrderColumns.ts` (Oberfläche und PDF). */
exports.MODEL_COLUMN_KEY = 'stdModel';
const MODEL_COLUMN_NAME = 'Modell';
/** Die Einheit einer BOM-Zeile, wie sie in der Bestellung steht (eine Liste mit der Revision). */
const UNIT_LABELS = productionBom_1.ORDER_UNIT_LABELS;
/**
 * Die eigenen Angaben der Produktionsvorlage an einer Position: Gruppe,
 * Produkttyp- und Bestellnummer DES Lieferanten (von seiner Zeile auf der
 * Depo-Karte, 01.10.2026; leer → die Spalte fällt im PDF weg) und die Einheit
 * als Wort («Adet» — das PDF schreibt sie in seiner Sprache).
 */
const productionExtras = (line) => [
    { key: standardOrderTemplate_1.PRODUCTION_GROUP_KEY, name: 'Materialgruppe', value: (line.materialGroup ?? '').trim(), width: 150 },
    { key: standardOrderTemplate_1.PRODUCTION_ARTICLE_NO_KEY, name: 'Produkttypnummer', value: (line.supplierArticleNumber ?? '').trim(), width: 140 },
    { key: standardOrderTemplate_1.PRODUCTION_ORDER_NO_KEY, name: 'Bestellnummer', value: (line.supplierOrderNumber ?? '').trim(), width: 140 },
    { key: standardOrderTemplate_1.PRODUCTION_UNIT_KEY, name: 'Einheit', value: UNIT_LABELS[line.unit] ?? 'Adet', width: 90 },
];
/**
 * Der Name der Position. Seit dem 30.09.2026 schlicht der Produktname — der
 * Hersteller-/Modellcode steht nicht mehr auf dem Beleg (Samet: «model
 * numarasını kaldırın … basılmayacak»); den Code für den Lieferanten trägt
 * die Spalte «Ürün kodu».
 */
const lineName = (line) => line.name.slice(0, 500);
const priceOf = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number * 10_000) / 10_000 : 0;
};
const itemOf = (line, productionItemId) => {
    const quantity = (0, productionBom_1.round3)(line.quantity);
    const gross = priceOf(line.unitPrice);
    const discount = Math.min(100, Math.max(0, Number(line.discount) || 0));
    const net = Math.round(gross * (1 - discount / 100) * 10_000) / 10_000;
    return {
        itemType: 'PRODUCT',
        articleId: null,
        code: line.erpCode,
        name: lineName(line),
        quantity,
        unit: UNIT_LABELS[line.unit] ?? 'Adet',
        grossPrice: gross,
        netPrice: net,
        discount,
        discount2: 0,
        vatRate: 0,
        calcMode: 'DIRECT',
        directCopy: true,
        lineTotal: Math.round(quantity * net * 100) / 100,
        extras: productionExtras(line),
        bomLineId: line.bomLineId,
        productionItemId,
    };
};
const employeeName = async (userId) => {
    const employee = await prisma_client_1.default.employee.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } }).catch(() => null);
    const name = `${employee?.firstName ?? ''} ${employee?.lastName ?? ''}`.trim();
    return name || null;
};
/** Höchstzahl Positionen einer Bestellung — dieselbe Grenze wie `normalizePurchaseOrderItems`. */
const ORDER_ITEMS_MAX = 500;
const parseItems = (raw) => {
    try {
        const parsed = JSON.parse(String(raw ?? '[]'));
        return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
    }
    catch {
        return [];
    }
};
/** Die Zeilen der Verknüpfung, wie sie gespeichert sind (uretim_bom_siparisleri.lines). */
const linkRecordsOf = (raw) => (Array.isArray(raw) ? raw : []).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        return [];
    const record = entry;
    const bomLineId = typeof record.bomLineId === 'string' ? record.bomLineId : '';
    if (!bomLineId)
        return [];
    const minimum = Number(record.minimum);
    return [{
            bomLineId,
            missing: (0, productionBom_1.round3)(Number(record.missing) || 0),
            minimum: record.minimum === null || record.minimum === undefined || !Number.isFinite(minimum) ? null : minimum,
            ordered: (0, productionBom_1.round3)(Number(record.ordered) || 0),
            note: typeof record.note === 'string' && record.note.trim() ? record.note : null,
        }];
});
/** Jemand hat die Bestellung zwischen Lesen und Schreiben gespeichert — noch einmal lesen. */
class OrderChangedMeanwhile extends Error {
}
class BomPurchaseOrderWriter {
    /** Neue Bestellung (ORDER_DRAFT) für EINEN Lieferanten mit diesen Zeilen. */
    async createOrder(input) {
        const { tenantId, userId } = input;
        const supplier = await (0, inventory_routes_1.resolvePurchaseOrderSupplier)(tenantId, {
            supplierId: input.supplier.supplierId,
            supplierName: input.supplier.supplierName,
        });
        const [record, last, orderedBy] = await Promise.all([
            prisma_client_1.default.supplier.findFirst({ where: { id: supplier.supplierId, tenantId } }),
            prisma_client_1.default.purchaseOrder.findFirst({
                where: { tenantId },
                orderBy: { createdAt: 'desc' },
                select: { vatMode: true, orderVatRate: true, orderVatCountry: true, currency: true },
            }),
            employeeName(userId),
        ]);
        const normalized = (0, inventory_routes_1.normalizePurchaseOrderItems)(input.lines.map((line) => itemOf(line, input.productionItemId)));
        // KDV: wie jede neue Bestellung — Angabe des Lieferanten, sonst die der letzten Bestellung.
        const vatLiable = record?.vatLiable;
        const offerVat = typeof input.vatRate === 'number' && Number.isFinite(input.vatRate) ? input.vatRate : null;
        /* Druckt das Angebot eine MwSt, gilt SIE — als Gesamt-MwSt ganz unten
           («KDV eğer PDF'de yakalarsa en sona», Samet 01.10.2026), nie je Zeile. */
        const vat = offerVat !== null
            ? { vatMode: 'TOTAL', orderVatRate: offerVat }
            : typeof vatLiable === 'boolean'
                ? { vatMode: 'TOTAL', orderVatRate: vatLiable ? Number(record?.vatRate) || 0 : 0 }
                : { vatMode: last?.vatMode === 'TOTAL' ? 'TOTAL' : 'LINE', orderVatRate: Number(last?.orderVatRate) || 0 };
        const vatCountry = typeof vatLiable === 'boolean'
            ? (vatLiable ? record?.vatCountry ?? null : last?.orderVatCountry ?? null)
            : last?.orderVatCountry ?? null;
        let row = null;
        for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
            const referenceNumber = await (0, inventory_routes_1.nextPurchaseReference)(tenantId, 'ORDER');
            try {
                row = await prisma_client_1.default.purchaseOrder.create({
                    data: {
                        id: (0, nanoid_1.nanoid)(12),
                        tenantId,
                        referenceNumber,
                        orderNumber: referenceNumber,
                        status: 'ORDER_DRAFT',
                        orderedByName: orderedBy,
                        projectName: input.projectLabel.slice(0, 190) || null,
                        tableColumns: (0, standardOrderTemplate_1.productionColumnsJson)('ORDER'),
                        hiddenColumnKeys: (0, standardOrderTemplate_1.productionHiddenKeysJson)('ORDER'),
                        vatMode: vat.vatMode,
                        orderVatRate: vat.orderVatRate,
                        orderVatCountry: vatCountry,
                        supplierId: supplier.supplierId,
                        supplierName: supplier.supplierName,
                        supplierEmail: supplier.supplierEmail,
                        supplierAddress: supplier.supplierAddress,
                        items: JSON.stringify(normalized.items),
                        additionalFees: '[]',
                        currency: input.currency || last?.currency || 'CHF',
                        quoteNumber: input.quoteNumber?.trim().slice(0, 120) || null,
                        recipientName: input.recipientName?.trim().slice(0, 120) || null,
                        totalNet: normalized.totalNet,
                        totalGross: normalized.totalGross,
                        totalVat: (0, inventory_routes_1.purchaseOrderTotalVat)(vat, normalized.totalNet, 0, normalized.totalVat, normalized.items.map((item) => item.lineTotal)),
                        totalFees: 0,
                        createdByEmpId: userId,
                    },
                    select: { id: true, referenceNumber: true, status: true, supplierName: true, currency: true, items: true },
                });
            }
            catch (error) {
                if (error?.code !== 'P2002')
                    throw error;
            }
        }
        if (!row)
            throw new Error('Bestellnummer konnte nicht vergeben werden.');
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
    async appendToOrder(input) {
        const { tenantId, userId } = input;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            let row;
            try {
                row = await prisma_client_1.default.$transaction(async (tx) => {
                    const order = await tx.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, tenantId } });
                    if (!order || !(0, productionBom_1.acceptsMoreLines)(order))
                        return null;
                    const link = await tx.productionBomPurchase.findFirst({
                        where: { tenantId, purchaseOrderId: order.id, bomId: input.bomId, kind: 'ORDER' },
                    });
                    if (!link)
                        return null;
                    const items = (0, productionBom_1.mergeOrderItems)(parseItems(order.items), input.lines.map((line) => itemOf(line, input.productionItemId)));
                    if (items.length > ORDER_ITEMS_MAX)
                        return null;
                    const normalized = (0, inventory_routes_1.normalizePurchaseOrderItems)(items);
                    const vat = { vatMode: String(order.vatMode || 'LINE'), orderVatRate: Number(order.orderVatRate) || 0 };
                    // Nur auf den gelesenen Stand — sonst gingen Preise verloren, die gerade jemand speichert.
                    const written = await tx.purchaseOrder.updateMany({
                        where: { id: order.id, tenantId, updatedAt: order.updatedAt },
                        data: {
                            items: JSON.stringify(normalized.items),
                            totalNet: normalized.totalNet,
                            totalGross: normalized.totalGross,
                            totalVat: (0, inventory_routes_1.purchaseOrderTotalVat)(vat, normalized.totalNet, Number(order.totalFees) || 0, normalized.totalVat, normalized.items.map((item) => item.lineTotal)),
                        },
                    });
                    if (!written.count)
                        throw new OrderChangedMeanwhile();
                    await tx.productionBomPurchase.update({
                        where: { id: link.id },
                        data: {
                            lines: (0, productionBom_1.mergeLinkRecords)(linkRecordsOf(link.lines), input.records, normalized.items),
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
            }
            catch (error) {
                if (error instanceof OrderChangedMeanwhile)
                    continue;
                throw error;
            }
            if (!row)
                return null;
            // Wie beim Anlegen: die Produktion führt die Zeilen der Bestellung (auch im Entwurf).
            if (await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId).catch(() => false)) {
                await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, row, userId).catch(() => undefined);
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
    async createRequest(input) {
        const { tenantId, userId } = input;
        const supplier = await (0, inventory_routes_1.resolvePurchaseOrderSupplier)(tenantId, {
            supplierId: input.supplier.supplierId,
            supplierName: input.supplier.supplierName,
        });
        const [last, orderedBy] = await Promise.all([
            prisma_client_1.default.purchaseOrder.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' }, select: { currency: true } }),
            employeeName(userId),
        ]);
        const normalized = (0, inventory_routes_1.normalizePurchaseOrderItems)(input.lines.map((line) => ({
            itemType: 'PRODUCT',
            articleId: null,
            // Der ERP-Code reist still mit (Suche, Zuordnung) — gedruckt wird er nie.
            code: line.erpCode,
            name: lineName(line),
            quantity: (0, productionBom_1.round3)(line.quantity),
            unit: UNIT_LABELS[line.unit] ?? 'Adet',
            grossPrice: 0,
            netPrice: 0,
            discount: 0,
            discount2: 0,
            vatRate: 0,
            calcMode: 'DIRECT',
            directCopy: true,
            lineTotal: 0,
            extras: productionExtras(line),
            bomLineId: line.bomLineId,
            productionItemId: input.productionItemId,
        })));
        let row = null;
        for (let attempt = 0; attempt < 3 && !row; attempt += 1) {
            const referenceNumber = await (0, inventory_routes_1.nextPurchaseReference)(tenantId, 'PRICE_REQUEST');
            try {
                row = await prisma_client_1.default.purchaseOrder.create({
                    data: {
                        id: (0, nanoid_1.nanoid)(12),
                        tenantId,
                        referenceNumber,
                        priceRequestNumber: referenceNumber,
                        status: 'DRAFT',
                        orderedByName: orderedBy,
                        projectName: input.projectLabel.slice(0, 190) || null,
                        tableColumns: (0, standardOrderTemplate_1.productionColumnsJson)('PRICE_REQUEST'),
                        hiddenColumnKeys: (0, standardOrderTemplate_1.productionHiddenKeysJson)('PRICE_REQUEST'),
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
            }
            catch (error) {
                if (error?.code !== 'P2002')
                    throw error;
            }
        }
        if (!row)
            throw new Error('Nummer der Preisanfrage konnte nicht vergeben werden.');
        await this.assignProduction(tenantId, row, input.productionProjectId, input.productionItemId, userId);
        return { id: row.id, referenceNumber: row.referenceNumber, supplierName: row.supplierName };
    }
    /** Die Angebotsnummer des Lieferanten («tedarikçi sipariş numarası») — sie steht im PDF. */
    async setQuoteNumber(tenantId, purchaseOrderId, quoteNumber) {
        const order = await prisma_client_1.default.purchaseOrder.findFirst({
            where: { id: purchaseOrderId, tenantId },
            select: { id: true, emailSentAt: true, quoteNumber: true },
        });
        if (!order)
            return false;
        if ((order.quoteNumber ?? null) === quoteNumber)
            return true;
        await prisma_client_1.default.purchaseOrder.update({
            where: { id: order.id },
            // Mail schon draussen: die nächste trägt «aktualisiert».
            data: { quoteNumber, ...(order.emailSentAt ? { revision: { increment: 1 } } : {}) },
        });
        return true;
    }
    /**
     * «Teklif PDF'ini bırak» (28.09.2026): die Preise aus dem Angebot oder der
     * Antwort des Lieferanten — je Position EIN Stückpreis ohne Rabatt, der
     * Betrag ist Menge × Preis. Geschrieben nur auf den gelesenen Stand.
     */
    async setPrices(tenantId, userId, purchaseOrderId, prices) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const order = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: purchaseOrderId, tenantId } });
            if (!order)
                return false;
            const items = parseItems(order.items);
            for (const { index, unitPrice } of prices) {
                const item = items[index];
                if (!item)
                    continue;
                const price = Math.round(unitPrice * 10_000) / 10_000;
                Object.assign(item, {
                    grossPrice: price,
                    netPrice: price,
                    discount: 0,
                    discount2: 0,
                    calcMode: 'DIRECT',
                    lineTotal: Math.round((Number(item.quantity) || 0) * price * 100) / 100,
                });
            }
            const normalized = (0, inventory_routes_1.normalizePurchaseOrderItems)(items);
            const vat = { vatMode: String(order.vatMode || 'LINE'), orderVatRate: Number(order.orderVatRate) || 0 };
            const written = await prisma_client_1.default.purchaseOrder.updateMany({
                where: { id: order.id, tenantId, updatedAt: order.updatedAt },
                data: {
                    items: JSON.stringify(normalized.items),
                    totalNet: normalized.totalNet,
                    totalGross: normalized.totalGross,
                    totalVat: (0, inventory_routes_1.purchaseOrderTotalVat)(vat, normalized.totalNet, Number(order.totalFees) || 0, normalized.totalVat, normalized.items.map((item) => item.lineTotal)),
                },
            });
            if (!written.count)
                continue;
            if (await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId).catch(() => false)) {
                await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, {
                    id: order.id,
                    referenceNumber: order.referenceNumber,
                    status: order.status,
                    supplierName: order.supplierName,
                    currency: order.currency,
                    items: JSON.stringify(normalized.items),
                }, userId).catch(() => undefined);
            }
            return true;
        }
        throw new Error('Die Bestellung wird gerade von jemand anderem bearbeitet — bitte noch einmal versuchen.');
    }
    /**
     * Wareneingang in die Positionen schreiben (`receivedQuantity`/`receivedAt`)
     * und den Stand nachziehen: alles da → COMPLETED. Der Bestand selbst geht
     * ins Depo (der Anwendungsfall), nicht ins Artikellager.
     */
    async applyReceipt(input) {
        const { tenantId } = input;
        const order = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, tenantId } });
        if (!order)
            throw new Error('Bestellung nicht gefunden.');
        let items = [];
        try {
            items = JSON.parse(order.items || '[]');
        }
        catch {
            items = [];
        }
        const now = new Date().toISOString();
        for (const entry of input.received) {
            const item = items[entry.index];
            if (!item)
                continue;
            const ordered = Number(item.quantity) || 0;
            const already = Number(item.receivedQuantity) || 0;
            item.receivedQuantity = (0, productionBom_1.round3)(Math.min(ordered, already + entry.quantity));
            item.receivedAt = now;
        }
        const complete = items.length > 0 && items.every((item) => (Number(item.receivedQuantity) || 0) + 1e-9 >= (Number(item.quantity) || 0));
        const status = complete ? 'COMPLETED' : order.status;
        const updated = await prisma_client_1.default.purchaseOrder.update({
            where: { id: order.id },
            data: {
                items: JSON.stringify(items),
                status,
                ...(complete && !order.stockedAt ? { stockedAt: new Date() } : {}),
            },
            select: { id: true, referenceNumber: true, status: true, supplierName: true, currency: true, items: true },
        });
        if (await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId)) {
            await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, updated, input.userId).catch(() => undefined);
        }
        return { status: updated.status, items };
    }
    /**
     * «Geri al» einer Depo-Buchung (28.09.2026): die Stücke kommen aus den
     * Positionen wieder heraus. Eine Bestellung, die dadurch nicht mehr ganz
     * geliefert ist, wartet wieder (MAL KABULDE) — nie unter 0.
     */
    async revertReceipt(input) {
        const { tenantId } = input;
        const order = await prisma_client_1.default.purchaseOrder.findFirst({ where: { id: input.purchaseOrderId, tenantId } });
        if (!order)
            throw new Error('Bestellung nicht gefunden.');
        let items = [];
        try {
            items = JSON.parse(order.items || '[]');
        }
        catch {
            items = [];
        }
        for (const entry of input.reverted) {
            const item = items[entry.index];
            if (!item)
                continue;
            const left = (0, productionBom_1.round3)(Math.max(0, (Number(item.receivedQuantity) || 0) - entry.quantity));
            item.receivedQuantity = left;
            if (left <= 0)
                delete item.receivedAt;
        }
        const complete = items.length > 0 && items.every((item) => (Number(item.receivedQuantity) || 0) + 1e-9 >= (Number(item.quantity) || 0));
        const reopened = String(order.status).toUpperCase() === 'COMPLETED' && !complete;
        const updated = await prisma_client_1.default.purchaseOrder.update({
            where: { id: order.id },
            data: {
                items: JSON.stringify(items),
                ...(reopened ? { status: 'TO_BE_STOCKED', stockedAt: null } : {}),
            },
            select: { id: true, referenceNumber: true, status: true, supplierName: true, currency: true, items: true },
        });
        if (await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId)) {
            await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, updated, input.userId).catch(() => undefined);
        }
        return { status: updated.status };
    }
    /** Die Bestellung steht beim Produktionsprojekt und Gerät (wie jede zugeordnete). */
    async assignProduction(tenantId, row, productionProjectId, productionItemId, userId) {
        try {
            if (!(await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId)))
                return;
            await productionModule_1.productionModule.purchaseLink.saveAssignment(tenantId, row.id, {
                productionProjectId,
                productionItemIds: [productionItemId],
            }, userId);
            await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, row, userId);
        }
        catch (error) {
            // Die Zuordnung ist Beiwerk — die Bestellung steht trotzdem.
            console.warn('[production-bom] assignment failed', row.id, error?.message);
        }
    }
}
exports.BomPurchaseOrderWriter = BomPurchaseOrderWriter;
//# sourceMappingURL=productionBomPurchaseWriter.js.map