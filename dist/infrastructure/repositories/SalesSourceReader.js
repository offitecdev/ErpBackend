"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaSalesSourceReader = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const production_1 = require("../../domain/services/production");
/**
 * ── DIE VERKAUFSSEITE, WIE DIE PRODUKTION SIE LIEST ─────────────────────────
 *
 * Die Grenze zwischen Verkauf und Produktion: hier und nur hier kennt das
 * Modul die Tabellen des Verkaufs. Vier Abfragen, egal wie viele Aufträge:
 *
 *   1. die Aufträge der Quellfirmen (Projektaufträge, Lieferaufträge,
 *      Nachträge) samt Projekt, Kunde und Offerten-Referenz
 *   2. die Positionen ihrer Offerten — Produkt- und OSP-Zeilen, keine Titel
 *      und keine Textzeilen
 *   3. die Artikelzeilen der Nachträge (und Zusatzmaterial am Auftrag)
 *   4. die freien Zeilen der Nachträge (Aufwand)
 *
 * Nichts wird geschrieben.
 */
const IN_CHUNK = 500;
const inChunks = async (ids, run) => {
    const out = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK)
        out.push(...await run(ids.slice(i, i + IN_CHUNK)));
    return out;
};
const toDate = (value) => {
    if (!value)
        return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
};
const text = (value) => {
    const clean = String(value ?? '').trim();
    return clean ? clean : null;
};
/** Rich-Text der Offerte → schlichter Text für die Geräteansicht. */
const plainText = (value, max = 1000) => {
    const raw = String(value ?? '');
    if (!raw.trim())
        return null;
    const stripped = raw
        .replace(/<\s*(br|\/p|\/li|\/div)\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n')
        .trim();
    return stripped ? stripped.slice(0, max) : null;
};
const metaOf = (raw) => {
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(String(raw));
        return parsed && typeof parsed === 'object' ? parsed : null;
    }
    catch {
        return null;
    }
};
const kindOf = (itemType) => String(itemType || '').toUpperCase() === 'SERVICE' ? 'SERVICE' : 'DEVICE';
class PrismaSalesSourceReader {
    async read(sourceTenantIds) {
        if (!sourceTenantIds.length)
            return { orders: [], lines: [] };
        const orderRows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT so.id, so.tenantId, so.orderNumber, so.orderType, so.status, so.cancelledAt,
                   so.parentSalesOrderId, so.projectId, so.tenderId, so.totalAmount,
                   COALESCE(so.orderDate, so.createdAt) AS orderDate,
                   p.projectNumber, p.projectName, p.status AS projectStatus,
                   COALESCE(NULLIF(TRIM(t.manualCustomerName), ''), c.companyName) AS customerName,
                   NULLIF(TRIM(t.customerReference), '') AS customerReference,
                   NULLIF(TRIM(t.commissionNumber), '') AS commissionNumber
            FROM SalesOrder so
            LEFT JOIN Project p ON p.id = so.projectId
            LEFT JOIN Tender t ON t.id = so.tenderId
            LEFT JOIN Customer c ON c.id = so.customerId
            WHERE so.tenantId IN (${client_1.Prisma.join(sourceTenantIds)})
              AND so.orderType IN (${client_1.Prisma.join([...production_1.PRODUCTION_ORDER_TYPES])})
        `);
        const orders = orderRows.map((row) => ({
            id: String(row.id),
            tenantId: String(row.tenantId),
            orderNumber: String(row.orderNumber || ''),
            orderType: String(row.orderType || ''),
            status: row.cancelledAt || String(row.status || '').toUpperCase() === 'CANCELLED' ? 'CANCELLED' : 'ORDERED',
            parentSalesOrderId: row.parentSalesOrderId ? String(row.parentSalesOrderId) : null,
            projectId: row.projectId ? String(row.projectId) : null,
            projectNumber: text(row.projectNumber),
            projectName: text(row.projectName),
            projectStatus: text(row.projectStatus),
            customerName: text(row.customerName),
            reference: text(row.customerReference) ?? text(row.commissionNumber),
            orderDate: toDate(row.orderDate),
            totalAmount: Number(row.totalAmount) || 0,
        }));
        const orderIds = orders.map((order) => order.id);
        const orderByTender = new Map();
        for (const row of orderRows)
            if (row.tenderId)
                orderByTender.set(String(row.tenderId), String(row.id));
        const tenderIds = [...orderByTender.keys()];
        const [positionRows, materialRows, expenseRows] = await Promise.all([
            inChunks(tenderIds, (part) => prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT pos.id, pos.tenderId, pos.rowType, pos.positionNumber, pos.shortDescription,
                       pos.longDescription, pos.quantity, pos.unit, pos.unitPrice, pos.discount, pos.displayOrder,
                       a.id AS articleId, a.articleCode, a.itemType
                FROM Position pos
                LEFT JOIN Article a ON a.id = pos.sourceArticleId
                WHERE pos.tenderId IN (${client_1.Prisma.join(part)})
                  AND pos.rowType IN ('PRODUCT', 'CUSTOM')
            `)),
            inChunks(orderIds, (part) => prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT em.id, em.salesOrderId, em.quantity, em.unitPrice, em.description, em.documentLine,
                       a.id AS articleId, a.articleCode, a.name AS articleName, a.unit AS articleUnit, a.itemType
                FROM ProjectExtraMaterial em
                JOIN Article a ON a.id = em.articleId
                WHERE em.salesOrderId IN (${client_1.Prisma.join(part)})
            `)),
            inChunks(orderIds, (part) => prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT pe.id, pe.salesOrderId, pe.expenseType, pe.amount, pe.description, pe.documentLine
                FROM ProjectExpense pe
                WHERE pe.salesOrderId IN (${client_1.Prisma.join(part)})
            `)),
        ]);
        const lines = [];
        // Offertpositionen: Menge × Einzelpreis × (1 − Rabatt) — dieselbe
        // Rechnung wie die Offerte selbst (Position.discount ist der
        // zusammengefasste Zeilenrabatt).
        for (const row of positionRows) {
            const orderId = orderByTender.get(String(row.tenderId));
            if (!orderId)
                continue;
            const quantity = Number(row.quantity) || 0;
            const unitPrice = Number(row.unitPrice) || 0;
            const discount = Math.min(100, Math.max(0, Number(row.discount) || 0));
            lines.push({
                orderId,
                sourceType: 'POSITION',
                sourceId: String(row.id),
                kind: kindOf(row.itemType),
                positionNumber: text(row.positionNumber),
                name: plainText(row.shortDescription, 500) || text(row.articleCode) || '—',
                description: plainText(row.longDescription),
                articleId: row.articleId ? String(row.articleId) : null,
                articleCode: text(row.articleCode),
                quantity,
                unit: text(row.unit),
                unitPrice,
                totalPrice: (0, production_1.round2)(quantity * unitPrice * (1 - discount / 100)),
                sortOrder: Number(row.displayOrder) || 0,
            });
        }
        // Artikelzeilen der Nachträge: `unitPrice` ist dort schon der
        // rabattierte Preis (Betrag ÷ Menge), die Belegzeile kennt Titel und Einheit.
        materialRows.forEach((row, index) => {
            const meta = metaOf(row.documentLine);
            const quantity = Number(row.quantity) || 0;
            const unitPrice = Number(row.unitPrice) || 0;
            lines.push({
                orderId: String(row.salesOrderId),
                sourceType: 'EXTRA_MATERIAL',
                sourceId: String(row.id),
                kind: kindOf(row.itemType),
                positionNumber: null,
                name: text(meta?.description) || text(row.articleName) || '—',
                description: plainText(row.description),
                articleId: row.articleId ? String(row.articleId) : null,
                articleCode: text(row.articleCode),
                quantity,
                unit: text(meta?.unit) || text(row.articleUnit),
                unitPrice,
                totalPrice: (0, production_1.round2)(quantity * unitPrice),
                sortOrder: 10_000 + (Number(meta?.sortOrder) >= 0 ? Number(meta?.sortOrder) : index),
            });
        });
        // Freie Zeilen (Aufwand) — eine Leistung.
        expenseRows.forEach((row, index) => {
            const meta = metaOf(row.documentLine);
            const amount = Number(row.amount) || 0;
            const quantity = Number(meta?.quantity) || 1;
            lines.push({
                orderId: String(row.salesOrderId),
                sourceType: 'EXPENSE',
                sourceId: String(row.id),
                kind: 'SERVICE',
                positionNumber: null,
                name: text(meta?.description) || text(row.expenseType) || '—',
                description: plainText(row.description),
                articleId: null,
                articleCode: null,
                quantity,
                unit: text(meta?.unit),
                unitPrice: quantity ? amount / quantity : amount,
                totalPrice: (0, production_1.round2)(amount),
                sortOrder: 20_000 + (Number(meta?.sortOrder) >= 0 ? Number(meta?.sortOrder) : index),
            });
        });
        return { orders, lines };
    }
}
exports.PrismaSalesSourceReader = PrismaSalesSourceReader;
//# sourceMappingURL=SalesSourceReader.js.map