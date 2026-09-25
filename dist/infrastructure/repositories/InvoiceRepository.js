"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvoiceRepository = exports.deriveInvoiceCategory = void 0;
const client_1 = require("@prisma/client");
const directInvoiceNumber_1 = require("../../shared/directInvoiceNumber");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const invoiceDrafts_1 = require("../../shared/invoiceDrafts");
/**
 * Rechnungstyp aus dem Beleg ABLEITEN, an dem die Rechnung hängt — sie trägt
 * keine eigene Spalte dafür (siehe `InvoiceCategory`):
 *  - ein Projekt am Beleg          → Projektauftrag
 *  - ein Auftrag ohne Projekt      → Lieferauftrag (Auftragsart INVOICE/REGIE)
 *  - weder Auftrag noch Projekt    → Direktrechnung (selbst ausgefüllt)
 *
 * Wandert ein Auftrag später in ein Projekt, wandern seine Rechnungen mit,
 * ohne dass irgendwo nachgetragen werden müsste.
 */
const deriveInvoiceCategory = (row) => {
    if (row.projectId)
        return "PROJECT";
    if (row.salesOrderId)
        return String(row.orderType || "").startsWith("PROJECT") ? "PROJECT" : "DELIVERY";
    return "DIRECT";
};
exports.deriveInvoiceCategory = deriveInvoiceCategory;
const money = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
/**
 * Offener Betrag einer Listenzeile — dieselbe Regel wie `readInvoiceBalance`
 * (shared/invoicePayments.ts): Betrag − Zahlungen − Gutschriften; beim
 * Gegenbeleg nur, was noch zurückzuzahlen ist; Entwurf/Storno: nichts.
 */
const invoiceBalanceOf = (row) => {
    const amount = Math.abs(Number(row.amount ?? 0));
    const paid = Math.abs(Number(row.paidSum ?? 0));
    const credited = Math.abs(Number(row.creditSum ?? 0));
    const kind = String(row.kind ?? '');
    const status = String(row.status ?? '');
    let openAmount = 0;
    if (status === 'ISSUED' || status === 'PAID') {
        if (kind === 'STORNO')
            openAmount = 0;
        else if (kind === 'GUTSCHRIFT')
            openAmount = Math.max(0, money(amount - paid));
        else
            openAmount = Math.max(0, money(amount - paid - credited));
    }
    return {
        paidAmount: money(Math.abs(Number(row.paidMoney ?? 0))),
        creditedAmount: money(credited),
        openAmount,
    };
};
const invoiceInclude = {
    // Positionsreihenfolge ist eine Angabe des Belegs, keine Zufälligkeit der
    // Abfrage — die Direktrechnung setzt sie beim Speichern.
    lineItems: { orderBy: { sortOrder: 'asc' } },
    customer: { select: { id: true, companyName: true } },
    project: { select: { id: true, projectNumber: true, projectName: true } },
    salesOrder: { select: { id: true, orderNumber: true, orderType: true } },
    issuedBy: { select: { id: true, firstName: true, lastName: true } },
};
/* ── DIE LISTE DER BUCHHALTUNG KOMMT SEITENWEISE (22.09.2026) ───────────────
 *
 * Vorgabe Samet: «20'şer 20'şer getirsin» — die Rechnungsliste lädt nicht mehr
 * alle Belege, sondern eine SEITE (20 Zeilen), und zuoberst steht, woran
 * zuletzt etwas geschehen ist: ausgestellt, bezahlt, geändert, storniert.
 *
 * Damit das geht, rechnet der Server, was bisher die Oberfläche rechnete —
 * Reiter (Stand), Suche, Herkunft und die Zähler der Reiter. Die Regeln sind
 * WÖRTLICH dieselben wie in `pages/accounting/accountingShared.ts`:
 * «Überfällig» ist kein Status, sondern ein Datum, und «Offen» schliesst
 * «Überfällig» ein.
 */
const todayString = () => new Date().toISOString().slice(0, 10);
/** Ein Gegenbeleg (Storno/Gutschrift) hat einen eigenen Reiter — er ist weder offen noch bezahlt. */
const NOT_CREDIT_SQL = client_1.Prisma.sql `i.kind NOT IN ('STORNO', 'GUTSCHRIFT')`;
/**
 * Bedingung EINES Reiters. «Offen» meint jede ausgestellte Rechnung, also
 * auch die überfälligen — genau wie `matchesTab()` in der Oberfläche.
 */
const stateSql = (state, today) => {
    switch (state) {
        case "CREDIT":
            return client_1.Prisma.sql `i.kind IN ('STORNO', 'GUTSCHRIFT')`;
        case "DRAFT":
            return client_1.Prisma.sql `(${NOT_CREDIT_SQL} AND i.status = 'DRAFT')`;
        case "PAID":
            return client_1.Prisma.sql `(${NOT_CREDIT_SQL} AND i.status = 'PAID')`;
        case "CANCELLED":
            return client_1.Prisma.sql `(${NOT_CREDIT_SQL} AND i.status = 'CANCELLED')`;
        case "OVERDUE":
            return client_1.Prisma.sql `(${NOT_CREDIT_SQL} AND i.status = 'ISSUED' AND i.dueDate IS NOT NULL AND DATE(i.dueDate) < ${today})`;
        default:
            return client_1.Prisma.sql `(${NOT_CREDIT_SQL} AND i.status = 'ISSUED')`;
    }
};
/** `%` und `_` sind in LIKE Platzhalter — getippte Zeichen bleiben Zeichen. */
const escapeLike = (value) => value.replace(/[\\%_]/g, (character) => "\\" + character);
/**
 * Die Suche der Liste: dieselben Felder, die die Tabelle zeigt — Nummer,
 * Empfänger, Auftrag, Projekt, Verkäufer und der Betrag.
 */
const searchSql = (search) => {
    const needle = `%${escapeLike(search)}%`;
    return client_1.Prisma.sql `(
        i.invoiceNumber LIKE ${needle}
        OR i.legacyNumber LIKE ${needle}
        OR COALESCE(c.companyName, i.recipientName) LIKE ${needle}
        OR so.orderNumber LIKE ${needle}
        OR pr.projectNumber LIKE ${needle}
        OR pr.projectName LIKE ${needle}
        OR i.salespersonName LIKE ${needle}
        OR CAST(ROUND(ABS(i.amount), 2) AS CHAR) LIKE ${needle}
    )`;
};
/**
 * LETZTER VORGANG einer Rechnung: die Änderung am Beleg selbst ODER ein
 * Zahlungseingang. Eine Teilzahlung ändert die Rechnung nicht (sie ist eine
 * eigene Zeile) — ohne den Eingang fiele die eben verbuchte Rechnung nicht
 * nach oben, und genau das ist die Sortierung, die verlangt wurde.
 */
const ACTIVITY_SQL = client_1.Prisma.sql `GREATEST(COALESCE(i.updatedAt, i.createdAt), COALESCE(pay.lastPaymentAt, i.createdAt))`;
const orderBySql = (sort) => {
    switch (sort) {
        // Rechnungsdatum — die alte Reihenfolge der Liste.
        case "invoiceDate":
            return client_1.Prisma.sql `ORDER BY COALESCE(i.invoiceDate, i.createdAt) DESC, i.invoiceNumber DESC`;
        // Fälligkeit: die älteste zuerst — sie braucht zuerst einen Anruf.
        case "dueDate":
            return client_1.Prisma.sql `ORDER BY i.dueDate IS NULL, i.dueDate ASC, ${ACTIVITY_SQL} DESC`;
        case "amount":
            return client_1.Prisma.sql `ORDER BY ABS(i.amount) DESC, ${ACTIVITY_SQL} DESC`;
        case "number":
            return client_1.Prisma.sql `ORDER BY i.invoiceNumber DESC, i.createdAt DESC`;
        default:
            return client_1.Prisma.sql `ORDER BY ${ACTIVITY_SQL} DESC, i.createdAt DESC`;
    }
};
/**
 * Der FROM-Teil, den die WHERE-Kette braucht. Kunde und Projekt hängen daran,
 * weil die Suche ihre Namen liest — Zähler, Positionen und Gegenbelege
 * benutzen denselben Block, damit sie nie eine andere Menge treffen.
 */
const SCOPE_FROM_SQL = client_1.Prisma.sql `
    FROM Invoice i
    LEFT JOIN SalesOrder so ON so.id = i.salesOrderId
    LEFT JOIN Customer c ON c.id = i.customerId
    LEFT JOIN Project pr ON pr.id = i.projectId
`;
/** Dasselbe plus die Spalten, die nur die Zeile selbst braucht. */
const ROWS_FROM_SQL = client_1.Prisma.sql `
    ${SCOPE_FROM_SQL}
    LEFT JOIN Employee e ON e.id = i.issuedByEmployeeId
    LEFT JOIN Invoice rv ON rv.id = i.reversesInvoiceId
    LEFT JOIN (
        SELECT p.invoiceId, MAX(p.createdAt) AS lastPaymentAt
        FROM InvoicePayment p
        GROUP BY p.invoiceId
    ) pay ON pay.invoiceId = i.id
`;
const ROW_COLUMNS_SQL = client_1.Prisma.sql `
    i.id, i.tenantId, i.customerId, i.projectId, i.salesOrderId,
    i.invoiceNumber, i.billingType, i.kind, i.invoiceDate, i.dueDate,
    i.salespersonName, i.commissionNumber, i.billedPercent, i.baseAmount,
    i.amount, i.status, i.notes, i.issuedByEmployeeId,
    i.recipientName, i.recipientAddress, i.introText, i.vatRate,
    -- Die drei Abschnitte, ihr Rabattstapel, der Schlusstext und
    -- die eigene Absenderzeile: OHNE sie druckt die Liste eine
    -- andere Rechnung als die Erfassungsseite (utils/pdf/invoicePdf.ts).
    i.sections, i.discounts, i.closingText, i.senderAddress, i.paymentStages, i.paidAt,
    i.createdAt, i.updatedAt,
    -- Letzter Vorgang — wonach die Buchhaltung sortiert.
    ${ACTIVITY_SQL} AS activityAt,
    -- Gegenbeleg (17.09.2026): worauf er zeigt.
    i.reversesInvoiceId, i.creditReason,
    rv.invoiceNumber AS reversesNumber, rv.invoiceDate AS reversesDate,
    rv.kind AS reversesKind, rv.amount AS reversesAmount,
    -- Zahlungsstand (Schritt 7): Eingänge, davon Geld, Gutschriften.
    (SELECT COALESCE(SUM(p.amount), 0) FROM InvoicePayment p WHERE p.invoiceId = i.id) AS paidSum,
    (SELECT COALESCE(SUM(p.amount), 0) FROM InvoicePayment p WHERE p.invoiceId = i.id AND p.kind = 'PAYMENT') AS paidMoney,
    (SELECT COALESCE(SUM(g.amount), 0) FROM Invoice g
        WHERE g.reversesInvoiceId = i.id AND g.kind = 'GUTSCHRIFT' AND g.status <> 'DRAFT') AS creditSum,
    c.companyName AS customerCompanyName,
    pr.projectName AS projectName,
    pr.projectNumber AS projectNumber,
    so.orderNumber AS orderNumber,
    so.orderType AS orderType,
    -- Die Offerte hinter dem Auftrag: OHNE sie druckt die
    -- Gesamtrechnung aus der Liste nur eine Sammelzeile statt
    -- der Positionen (siehe utils/pdf/invoicePdf.ts).
    so.tenderId AS orderTenderId,
    so.paymentStages AS orderPaymentStages,
    e.firstName AS issuerFirstName,
    e.lastName AS issuerLastName
`;
const LINE_ITEM_COLUMNS_SQL = client_1.Prisma.sql `
    li.id, li.invoiceId, li.description, li.sourceType, li.sourceId,
    li.quantity, li.unitAmount, li.lineTotal, li.unit, li.sortOrder,
    -- Beschreibung und Zeilenrabatt: OHNE sie druckt die
    -- Liste eine andere Tabelle als die Erfassungsseite.
    li.longDescription, li.discounts, li.discount
`;
const REVERSAL_COLUMNS_SQL = client_1.Prisma.sql `
    r.id, r.reversesInvoiceId, r.invoiceNumber, r.kind, r.amount, r.status, r.invoiceDate
`;
class InvoiceRepository {
    async createWithItems(invoice, items, numbering) {
        return (await prisma_client_1.default.$transaction(async (tx) => {
            if (numbering)
                invoice = { ...invoice, invoiceNumber: await (0, directInvoiceNumber_1.assignDirectInvoiceNumber)(tx, invoice.tenantId, numbering) };
            const created = await tx.invoice.create({ data: invoice });
            if (items.length > 0) {
                await tx.invoiceLineItem.createMany({
                    data: items.map((item) => ({ ...item, invoiceId: created.id })),
                });
            }
            return tx.invoice.findUnique({ where: { id: created.id }, include: invoiceInclude });
        }));
    }
    async updateWithItems(id, invoice, items, numbering) {
        return (await prisma_client_1.default.$transaction(async (tx) => {
            if (numbering)
                invoice = { ...invoice, invoiceNumber: await (0, directInvoiceNumber_1.assignDirectInvoiceNumber)(tx, invoice.tenantId, numbering, id) };
            await tx.invoice.update({ where: { id }, data: invoice });
            await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id } });
            if (items.length > 0) {
                await tx.invoiceLineItem.createMany({
                    data: items.map((item) => ({ ...item, invoiceId: id })),
                });
            }
            return tx.invoice.findUnique({ where: { id }, include: invoiceInclude });
        }));
    }
    async findActiveByOrder(salesOrderId, tenantId) {
        return (await prisma_client_1.default.invoice.findFirst({
            where: { salesOrderId, tenantId, status: { not: "CANCELLED" } },
            include: invoiceInclude,
        }));
    }
    async findActiveByProject(projectId, tenantId) {
        return (await prisma_client_1.default.invoice.findFirst({
            where: { projectId, tenantId, status: { not: "CANCELLED" } },
            include: invoiceInclude,
        }));
    }
    async findById(id, tenantId) {
        return (await prisma_client_1.default.invoice.findFirst({
            where: { id, tenantId },
            include: invoiceInclude,
        }));
    }
    /**
     * Die WHERE-Kette der Liste: Mandant, Bezüge, Herkunft, Suche und Reiter.
     * `withState: false` lässt den Reiter weg — die Zähler zählen ALLE Stände
     * innerhalb derselben Suche/Herkunft.
     */
    whereOf(filter, withState = true) {
        const conditions = [client_1.Prisma.sql `i.tenantId = ${filter.tenantId}`];
        if (filter.id)
            conditions.push(client_1.Prisma.sql `i.id = ${filter.id}`);
        if (filter.projectId)
            conditions.push(client_1.Prisma.sql `i.projectId = ${filter.projectId}`);
        if (filter.salesOrderId)
            conditions.push(client_1.Prisma.sql `i.salesOrderId = ${filter.salesOrderId}`);
        if (filter.customerId)
            conditions.push(client_1.Prisma.sql `i.customerId = ${filter.customerId}`);
        if (filter.status)
            conditions.push(client_1.Prisma.sql `i.status = ${filter.status}`);
        // Der Typ steckt nicht in einer Spalte, sondern in der Kombination
        // Projekt/Auftrag/Auftragsart — die Bedingung wird darum GENAUSO
        // formuliert wie die Ableitung selbst (`deriveInvoiceCategory`), damit
        // Filter und angezeigter Typ nie auseinanderlaufen.
        if (filter.category === 'PROJECT') {
            conditions.push(client_1.Prisma.sql `(i.projectId IS NOT NULL OR so.orderType LIKE 'PROJECT%')`);
        }
        else if (filter.category === 'DELIVERY') {
            conditions.push(client_1.Prisma.sql `(i.projectId IS NULL AND i.salesOrderId IS NOT NULL AND (so.orderType IS NULL OR so.orderType NOT LIKE 'PROJECT%'))`);
        }
        else if (filter.category === 'DIRECT') {
            conditions.push(client_1.Prisma.sql `(i.projectId IS NULL AND i.salesOrderId IS NULL)`);
        }
        const search = String(filter.search ?? '').trim();
        if (search)
            conditions.push(searchSql(search));
        if (withState && filter.state)
            conditions.push(stateSql(filter.state, filter.today || todayString()));
        return client_1.Prisma.join(conditions, ' AND ');
    }
    /**
     * Fatura listesi — cevap şekli `invoiceInclude` ile birebir aynı, ama iki
     * PARALEL ifadeyle üretiliyor (eskiden altı ARDIŞIK ifade).
     *
     * Prisma'da her `include` ayrı bir sorgu turu demek: veritabanı uzak olduğu
     * için (ifade başına ~100 ms) müşteri/proje/sipariş/personel/kalem ilişkileri
     * tek başına ~450 ms tutuyordu. Skaler ilişkiler artık tek JOIN'de geliyor;
     * kalemler ise aynı WHERE'i alt sorgu olarak kullandığı için sayfa id'lerini
     * beklemek zorunda değil, ilk sorguyla eş zamanlı koşuyor.
     *
     * Bu yol TÜM satırları getirir (bir siparişin/projenin faturaları gibi
     * sınırlı kümeler için). Muhasebe listesi `listPage` kullanır.
     */
    async list(filter) {
        const whereSql = this.whereOf(filter);
        // Die Unterabfrage der Positionen braucht dieselben JOINs, sonst
        // stünden `so.orderType` und die Suchfelder dort ohne Tabelle.
        const scopeSql = client_1.Prisma.sql `${SCOPE_FROM_SQL} WHERE ${whereSql}`;
        const [rows, lineItems, reversals] = await Promise.all([
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT ${ROW_COLUMNS_SQL}
                ${ROWS_FROM_SQL}
                WHERE ${whereSql}
                ${orderBySql(filter.sort)}
            `),
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT ${LINE_ITEM_COLUMNS_SQL}
                FROM InvoiceLineItem li
                WHERE li.invoiceId IN (SELECT i.id ${scopeSql})
                ORDER BY li.sortOrder ASC
            `),
            // Die Gegenbelege jeder gelisteten Rechnung (Storno/Gutschrift).
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT ${REVERSAL_COLUMNS_SQL}
                FROM Invoice r
                WHERE r.reversesInvoiceId IN (SELECT i.id ${scopeSql})
                  AND r.status <> 'DRAFT'
                ORDER BY r.createdAt ASC
            `),
        ]);
        return this.mapRows(rows, lineItems, reversals);
    }
    /**
     * EINE SEITE der Buchhaltungsliste (22.09.2026) — 20 Zeilen, sortiert nach
     * dem letzten Vorgang, dazu die Gesamtzahl und die Zähler aller Reiter.
     *
     * Positionen und Gegenbelege werden NACH den Zeilen geholt: MySQL lässt
     * kein `LIMIT` in einer `IN`-Unterabfrage zu — und für zwanzig Belege ist
     * die zweite Runde ohnehin billiger als die Positionen aller Rechnungen.
     */
    async listPage(filter) {
        const page = Math.max(1, Math.floor(Number(filter.page) || 1));
        const pageSize = Math.min(200, Math.max(1, Math.floor(Number(filter.pageSize) || 20)));
        const today = filter.today || todayString();
        const whereSql = this.whereOf(filter);
        // Die Zähler gelten für dieselbe Suche und Herkunft, aber für JEDEN
        // Stand — sonst zeigte der Reiter, auf dem man steht, als einziger eine Zahl.
        const countWhereSql = this.whereOf(filter, false);
        const [rows, totalRows, countRows] = await Promise.all([
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT ${ROW_COLUMNS_SQL}
                ${ROWS_FROM_SQL}
                WHERE ${whereSql}
                ${orderBySql(filter.sort)}
                LIMIT ${client_1.Prisma.raw(String(pageSize))} OFFSET ${client_1.Prisma.raw(String((page - 1) * pageSize))}
            `),
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT COUNT(*) AS total
                ${SCOPE_FROM_SQL}
                WHERE ${whereSql}
            `),
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT
                    COUNT(*) AS allCount,
                    SUM(CASE WHEN ${stateSql('DRAFT', today)} THEN 1 ELSE 0 END) AS draftCount,
                    SUM(CASE WHEN ${stateSql('OPEN', today)} THEN 1 ELSE 0 END) AS openCount,
                    SUM(CASE WHEN ${stateSql('OVERDUE', today)} THEN 1 ELSE 0 END) AS overdueCount,
                    SUM(CASE WHEN ${stateSql('PAID', today)} THEN 1 ELSE 0 END) AS paidCount,
                    SUM(CASE WHEN ${stateSql('CANCELLED', today)} THEN 1 ELSE 0 END) AS cancelledCount,
                    SUM(CASE WHEN ${stateSql('CREDIT', today)} THEN 1 ELSE 0 END) AS creditCount
                ${SCOPE_FROM_SQL}
                WHERE ${countWhereSql}
            `),
        ]);
        const ids = rows.map((row) => String(row.id));
        const [lineItems, reversals] = ids.length === 0
            ? [[], []]
            : await Promise.all([
                prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                    SELECT ${LINE_ITEM_COLUMNS_SQL}
                    FROM InvoiceLineItem li
                    WHERE li.invoiceId IN (${client_1.Prisma.join(ids)})
                    ORDER BY li.sortOrder ASC
                `),
                prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                    SELECT ${REVERSAL_COLUMNS_SQL}
                    FROM Invoice r
                    WHERE r.reversesInvoiceId IN (${client_1.Prisma.join(ids)})
                      AND r.status <> 'DRAFT'
                    ORDER BY r.createdAt ASC
                `),
            ]);
        const counts = countRows[0] ?? {};
        const number = (value) => Number(value ?? 0) || 0;
        return {
            items: this.mapRows(rows, lineItems, reversals),
            total: number(totalRows[0]?.total),
            page,
            pageSize,
            counts: {
                ALL: number(counts.allCount),
                DRAFT: number(counts.draftCount),
                // «Offen» enthält die überfälligen — wie der Reiter selbst.
                OPEN: number(counts.openCount),
                OVERDUE: number(counts.overdueCount),
                PAID: number(counts.paidCount),
                CANCELLED: number(counts.cancelledCount),
                CREDIT: number(counts.creditCount),
            },
        };
    }
    /** Aus den drei Abfragen wird EINE Zeile je Rechnung. */
    mapRows(rows, lineItems, reversals) {
        const reversalsByInvoice = new Map();
        for (const row of reversals) {
            const entry = {
                id: row.id,
                invoiceNumber: row.invoiceNumber,
                kind: row.kind,
                amount: Number(row.amount ?? 0),
                status: row.status,
                invoiceDate: row.invoiceDate ?? null,
            };
            const bucket = reversalsByInvoice.get(row.reversesInvoiceId);
            if (bucket)
                bucket.push(entry);
            else
                reversalsByInvoice.set(row.reversesInvoiceId, [entry]);
        }
        const itemsByInvoice = new Map();
        for (const item of lineItems) {
            const bucket = itemsByInvoice.get(item.invoiceId);
            if (bucket)
                bucket.push(item);
            else
                itemsByInvoice.set(item.invoiceId, [item]);
        }
        return rows.map((row) => ({
            id: row.id,
            tenantId: row.tenantId,
            customerId: row.customerId ?? null,
            projectId: row.projectId ?? null,
            salesOrderId: row.salesOrderId ?? null,
            invoiceNumber: row.invoiceNumber,
            billingType: row.billingType,
            kind: row.kind ?? 'RECHNUNG',
            // Der Typ ist ABGELEITET (keine Spalte) — hier einmal berechnet,
            // damit Liste, Filter und PDF dieselbe Antwort sehen.
            category: (0, exports.deriveInvoiceCategory)(row),
            orderType: row.orderType ?? null,
            invoiceDate: row.invoiceDate ?? null,
            dueDate: row.dueDate ?? null,
            salespersonName: row.salespersonName ?? null,
            commissionNumber: row.commissionNumber ?? null,
            billedPercent: Number(row.billedPercent ?? 0),
            baseAmount: Number(row.baseAmount ?? 0),
            amount: Number(row.amount ?? 0),
            status: row.status,
            notes: row.notes ?? null,
            // Direktrechnung: Empfänger, Einleitung und Steuersatz stehen auf
            // der Rechnung selbst; bei Auftragsrechnungen sind sie leer.
            recipientName: row.recipientName ?? null,
            recipientAddress: row.recipientAddress ?? null,
            introText: row.introText ?? null,
            vatRate: row.vatRate == null ? null : Number(row.vatRate),
            // Der Beleg selbst: welche Abschnitte gedruckt werden, ihr
            // Rabattstapel, der Schlusstext und die Absenderzeile.
            sections: row.sections ?? null,
            discounts: row.discounts ?? null,
            closingText: row.closingText ?? null,
            senderAddress: row.senderAddress ?? null,
            paymentStages: row.paymentStages ?? null,
            paidAt: row.paidAt ?? null,
            reversesInvoiceId: row.reversesInvoiceId ?? null,
            creditReason: row.creditReason ?? null,
            reversesInvoice: row.reversesInvoiceId
                ? {
                    id: row.reversesInvoiceId,
                    invoiceNumber: row.reversesNumber,
                    invoiceDate: row.reversesDate ?? null,
                    kind: row.reversesKind ?? 'RECHNUNG',
                    amount: Number(row.reversesAmount ?? 0),
                }
                : null,
            reversals: reversalsByInvoice.get(row.id) ?? [],
            ...invoiceBalanceOf(row),
            issuedByEmployeeId: row.issuedByEmployeeId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            // Letzter Vorgang: Aenderung am Beleg oder Zahlungseingang.
            activityAt: row.activityAt ?? row.updatedAt ?? row.createdAt,
            lineItems: itemsByInvoice.get(row.id) ?? [],
            customer: row.customerId
                ? { id: row.customerId, companyName: row.customerCompanyName }
                : null,
            project: row.projectId
                ? { id: row.projectId, projectNumber: row.projectNumber ?? null, projectName: row.projectName }
                : null,
            salesOrder: row.salesOrderId
                ? {
                    id: row.salesOrderId,
                    orderNumber: row.orderNumber,
                    orderType: row.orderType ?? null,
                    tenderId: row.orderTenderId ?? null,
                    paymentStages: row.orderPaymentStages ?? null,
                }
                : null,
            issuedBy: row.issuedByEmployeeId
                ? { id: row.issuedByEmployeeId, firstName: row.issuerFirstName, lastName: row.issuerLastName }
                : null,
        }));
    }
    // Feeds the batch billing summary only, so it selects the summary columns
    // instead of the full `invoiceInclude` — no line items, no joined customer /
    // project / order / employee rows for every invoice of every listed order.
    async listForOrders(tenantId, salesOrderIds) {
        if (salesOrderIds.length === 0)
            return [];
        return (await prisma_client_1.default.invoice.findMany({
            where: { tenantId, salesOrderId: { in: salesOrderIds } },
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                salesOrderId: true,
                invoiceNumber: true,
                billingType: true,
                kind: true,
                billedPercent: true,
                amount: true,
                status: true,
                createdAt: true,
            },
        }));
    }
    async countForTenant(tenantId) {
        return prisma_client_1.default.invoice.count({ where: { tenantId } });
    }
    // Yüzde ve tutar AYNI toplama sorgusundan gelir — kapanış faturası kalan
    // frankı kuruşu kuruşuna alacağı için ikisine de ihtiyaç var, ek tur yok.
    async sumBilled(where) {
        const agg = await prisma_client_1.default.invoice.aggregate({
            // Entwürfe reservieren nichts — gezählt wird erst beim Ausstellen.
            where: { ...where, ...invoiceDrafts_1.billedInvoiceWhere },
            _sum: { billedPercent: true, amount: true },
        });
        return {
            percent: Number(agg?._sum?.billedPercent || 0),
            amount: Number(agg?._sum?.amount || 0),
        };
    }
    async sumBilledForOrder(salesOrderId) {
        return this.sumBilled({ salesOrderId });
    }
    async sumBilledForProject(projectId) {
        return this.sumBilled({ projectId });
    }
    /**
     * Statuswechsel — und mit ihm der ZAHLUNGSEINGANG: "bezahlt" ist ein
     * Ereignis mit einem Datum, kein blosses Etikett. Beim Umschalten auf PAID
     * wird `paidAt` gesetzt (der Aufrufer darf ein anderes Datum als heute
     * nennen), beim Zurueckdrehen wieder geleert — sonst behielte eine wieder
     * geoeffnete Rechnung ein Zahlungsdatum, das es nicht mehr gibt.
     */
    async updateDates(id, tenantId, invoiceDate, dueDate) {
        const result = await prisma_client_1.default.invoice.updateMany({
            where: { id, tenantId },
            data: { invoiceDate, dueDate },
        });
        if (!result.count)
            throw new Error("Fatura bulunamadı.");
        return (await prisma_client_1.default.invoice.findUnique({ where: { id }, include: invoiceInclude }));
    }
    async deleteDraft(id, tenantId) {
        // Die Bedingung auf DRAFT steht IN der Löschung: ein zeitgleich
        // ausgestellter Entwurf wird so nie entfernt.
        const result = await prisma_client_1.default.invoice.deleteMany({ where: { id, tenantId, status: "DRAFT" } });
        return result.count > 0;
    }
    async updateStatus(id, tenantId, status, paidAt) {
        const existing = await prisma_client_1.default.invoice.findFirst({ where: { id, tenantId } });
        if (!existing)
            throw new Error("Fatura bulunamadı.");
        const paid = status === "PAID";
        await prisma_client_1.default.invoice.update({
            where: { id },
            data: { status, paidAt: paid ? (paidAt ?? existing.paidAt ?? new Date()) : null },
        });
        return (await prisma_client_1.default.invoice.findUnique({ where: { id }, include: invoiceInclude }));
    }
}
exports.InvoiceRepository = InvoiceRepository;
//# sourceMappingURL=InvoiceRepository.js.map