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

export const DRAFT_INVOICE_STATUS = 'DRAFT' as const;

/** Stornierte und noch nicht ausgestellte Rechnungen zählen nie als verrechnet. */
export const NOT_BILLED_STATUSES = ['CANCELLED', DRAFT_INVOICE_STATUS] as const;

/**
 * GEGENBELEGE (17.09.2026, Schritt 6):
 *   STORNO      hebt eine OFFENE Rechnung auf. Die Rechnung selbst steht danach
 *               auf CANCELLED und fällt aus jeder Summe — ihr Stornobeleg
 *               darum AUCH, sonst würde der Betrag zweimal abgezogen.
 *   GUTSCHRIFT  gibt Geld einer BEZAHLTEN Rechnung zurück. Die Rechnung bleibt
 *               bezahlt; die Gutschrift zählt mit NEGATIVEM Betrag und Anteil.
 */
export const STORNO_KIND = 'STORNO' as const;
export const CREDIT_KIND = 'GUTSCHRIFT' as const;
export const CREDIT_KINDS = [STORNO_KIND, CREDIT_KIND] as const;
export const isCreditKind = (kind: unknown): boolean => kind === STORNO_KIND || kind === CREDIT_KIND;

/** Prisma-Filter «zählt als verrechnet». */
export const billedInvoiceWhere = {
    status: { notIn: [...NOT_BILLED_STATUSES] },
    kind: { not: STORNO_KIND },
};

/** Dieselbe Bedingung für Roh-SQL über den Alias `i`. */
export const BILLED_INVOICE_SQL = `i.status NOT IN ('CANCELLED', 'DRAFT') AND i.kind <> 'STORNO'`;

/** Prisma-Filter «eine Rechnung, die noch geregelt werden muss» (offen oder bezahlt, kein Gegenbeleg). */
export const settleableInvoiceWhere = {
    status: { in: ['ISSUED', 'PAID'] },
    kind: { notIn: [...CREDIT_KINDS] },
};

/** Prisma-Filter «ausgestellt» (jede Rechnung mit Nummer, auch storniert). */
export const issuedInvoiceWhere = { NOT: { status: DRAFT_INVOICE_STATUS } };

type Db = { invoice: { deleteMany: (args: any) => Promise<{ count: number }> } };

/**
 * Die Entwürfe eines Auftrags(-stammes) oder eines Projekts verwerfen.
 * Ausgestellte Rechnungen bleiben unberührt — die sperren den Eingriff vorher.
 */
export const discardDraftInvoices = async (
    db: Db,
    where: { salesOrderIds?: string[]; projectId?: string | null; tenantId?: string },
): Promise<number> => {
    const scopes: any[] = [];
    if (where.salesOrderIds?.length) scopes.push({ salesOrderId: { in: where.salesOrderIds } });
    if (where.projectId) scopes.push({ projectId: where.projectId });
    if (scopes.length === 0) return 0;
    const result = await db.invoice.deleteMany({
        where: {
            status: DRAFT_INVOICE_STATUS,
            ...(where.tenantId ? { tenantId: where.tenantId } : {}),
            OR: scopes,
        },
    });
    return result.count;
};
