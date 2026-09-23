"use strict";
/**
 * ── RECHNUNGSENTWÜRFE (16.09.2026, Schritt 5) ────────────────────────────────
 *
 * Vorgabe Samet: eine Rechnung entsteht in der Buchhaltung zuerst als ENTWURF.
 * Ein Entwurf hat noch keine RE-Nummer, ist noch nicht verschickt und zählt
 * darum nirgends als «verrechnet» — weder im Fortschritt des Auftrags noch in
 * den Umsatzzahlen. Erst «Ausstellen» zieht die Nummer.
 *
 * Diese Datei ist die EINE Stelle, an der das festgehalten ist:
 *   • `NOT_BILLED_STATUSES` — was bei jeder Summe «verrechnet» wegfällt;
 *   • `billedInvoiceWhere`  — dieselbe Bedingung als Prisma-Filter;
 *   • `discardDraftInvoices` — fällt ein Auftrag oder ein Projekt (Löschen,
 *     Storno, zurück in den Entwurf), fallen seine Entwürfe mit: sie sind
 *     unverschickte Arbeit, kein Beleg.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.discardDraftInvoices = exports.issuedInvoiceWhere = exports.settleableInvoiceWhere = exports.BILLED_INVOICE_SQL = exports.billedInvoiceWhere = exports.isCreditKind = exports.CREDIT_KINDS = exports.CREDIT_KIND = exports.STORNO_KIND = exports.NOT_BILLED_STATUSES = exports.DRAFT_INVOICE_STATUS = void 0;
exports.DRAFT_INVOICE_STATUS = 'DRAFT';
/** Stornierte und noch nicht ausgestellte Rechnungen zählen nie als verrechnet. */
exports.NOT_BILLED_STATUSES = ['CANCELLED', exports.DRAFT_INVOICE_STATUS];
/**
 * GEGENBELEGE (17.09.2026, Schritt 6):
 *   STORNO      hebt eine OFFENE Rechnung auf. Die Rechnung selbst steht danach
 *               auf CANCELLED und fällt aus jeder Summe — ihr Stornobeleg
 *               darum AUCH, sonst würde der Betrag zweimal abgezogen.
 *   GUTSCHRIFT  gibt Geld einer BEZAHLTEN Rechnung zurück. Die Rechnung bleibt
 *               bezahlt; die Gutschrift zählt mit NEGATIVEM Betrag und Anteil.
 */
exports.STORNO_KIND = 'STORNO';
exports.CREDIT_KIND = 'GUTSCHRIFT';
exports.CREDIT_KINDS = [exports.STORNO_KIND, exports.CREDIT_KIND];
const isCreditKind = (kind) => kind === exports.STORNO_KIND || kind === exports.CREDIT_KIND;
exports.isCreditKind = isCreditKind;
/** Prisma-Filter «zählt als verrechnet». */
exports.billedInvoiceWhere = {
    status: { notIn: [...exports.NOT_BILLED_STATUSES] },
    kind: { not: exports.STORNO_KIND },
};
/** Dieselbe Bedingung für Roh-SQL über den Alias `i`. */
exports.BILLED_INVOICE_SQL = `i.status NOT IN ('CANCELLED', 'DRAFT') AND i.kind <> 'STORNO'`;
/** Prisma-Filter «eine Rechnung, die noch geregelt werden muss» (offen oder bezahlt, kein Gegenbeleg). */
exports.settleableInvoiceWhere = {
    status: { in: ['ISSUED', 'PAID'] },
    kind: { notIn: [...exports.CREDIT_KINDS] },
};
/** Prisma-Filter «ausgestellt» (jede Rechnung mit Nummer, auch storniert). */
exports.issuedInvoiceWhere = { NOT: { status: exports.DRAFT_INVOICE_STATUS } };
/**
 * Die Entwürfe eines Auftrags(-stammes) oder eines Projekts verwerfen.
 * Ausgestellte Rechnungen bleiben unberührt — die sperren den Eingriff vorher.
 */
const discardDraftInvoices = async (db, where) => {
    const scopes = [];
    if (where.salesOrderIds?.length)
        scopes.push({ salesOrderId: { in: where.salesOrderIds } });
    if (where.projectId)
        scopes.push({ projectId: where.projectId });
    if (scopes.length === 0)
        return 0;
    const result = await db.invoice.deleteMany({
        where: {
            status: exports.DRAFT_INVOICE_STATUS,
            ...(where.tenantId ? { tenantId: where.tenantId } : {}),
            OR: scopes,
        },
    });
    return result.count;
};
exports.discardDraftInvoices = discardDraftInvoices;
//# sourceMappingURL=invoiceDrafts.js.map