import { IInvoiceRepository, InvoiceLineItemInput } from "../../../domain/repositories/IInvoiceRepository";
import { Invoice } from "../../../domain/entities/Invoice";
import prisma from "../../../infrastructure/database/prisma.client";
import { nextDocumentNumber } from "../../../shared/documentNumber";

/**
 * ── DIREKTRECHNUNG: DIE LEERE VORLAGE ────────────────────────────────────────
 *
 * Vorgabe Samet (30.08.2026): neben der Rechnung AUS EINEM AUFTRAG braucht es
 * eine Rechnung, die man selbst ausfüllt — Empfänger wählen, Positionen aus dem
 * Katalog holen oder von Hand tippen, Preise setzen, fertig. Sie hängt an
 * keinem Auftrag und an keinem Projekt.
 *
 * Was die Auftragsrechnung aus der Offerte nachliest (Empfängeradresse,
 * Steuersatz, Einleitungstext), trägt diese Rechnung deshalb SELBST. Der
 * Prozentsatz ist immer 100: es gibt keinen Vertragswert, von dem sie einen
 * Teil abrechnen könnte — die Positionen SIND der Betrag.
 *
 * Preise sind NETTO (wie auf der Offerte); `amount` ist der BRUTTOBETRAG, denn
 * das ist die Zahl, die der QR-Zahlteil einzieht. `baseAmount` hält das Netto,
 * damit die Rechnung ihre eigene Steuer nachrechenbar behält.
 */
export interface DirectInvoiceLineInput {
    description: string;
    quantity?: number | null;
    unitAmount?: number | null;
    unit?: string | null;
    /** Katalogartikel, aus dem die Zeile kopiert wurde (nur Herkunftsnachweis). */
    articleId?: string | null;
}

export interface CreateDirectInvoiceInput {
    tenantId: string;
    issuedByEmployeeId: string;
    /** Bestandskunde — optional: der Empfänger darf auch frei getippt sein. */
    customerId?: string | null;
    recipientName: string;
    /** Ganze Zeilen, wie sie im Empfängerblock stehen sollen. */
    recipientAddress?: string | null;
    introText?: string | null;
    invoiceDate?: string | null;
    dueDate?: string | null;
    salespersonName?: string | null;
    commissionNumber?: string | null;
    /** MWST-Satz in Prozent. Wird eingefroren (siehe `Invoice.vatRate`). */
    vatRate?: number | null;
    notes?: string | null;
    lines: DirectInvoiceLineInput[];
}

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const parseIsoDate = (value: string | null | undefined): Date | null => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

export class CreateDirectInvoiceUseCase {
    constructor(private invoiceRepository: IInvoiceRepository) {}

    async execute(input: CreateDirectInvoiceInput): Promise<Invoice> {
        const recipientName = (input.recipientName || "").trim();
        if (!recipientName) throw new Error("Rechnungsempfänger fehlt.");

        // Leere Zeilen (angelegt, aber nie ausgefüllt) fallen still weg — der
        // Editor lässt sie stehen, auf dem Beleg haben sie nichts zu suchen.
        const lines = (input.lines || []).filter((line) => {
            const hasText = Boolean((line.description || "").trim());
            const hasFigures = Number(line.quantity || 0) !== 0 || Number(line.unitAmount || 0) !== 0;
            return hasText || hasFigures;
        });
        if (lines.length === 0) throw new Error("Rechnung ohne Positionen kann nicht erstellt werden.");
        const untitled = lines.find((line) => !(line.description || "").trim());
        if (untitled) throw new Error("Jede Position braucht eine Bezeichnung.");

        // Ein Bestandskunde muss dem Mandanten gehören — sonst hinge die
        // Rechnung an einem fremden Datensatz.
        let customerId: string | null = input.customerId?.trim() || null;
        if (customerId) {
            const customer = await (prisma as any).customer.findFirst({
                where: { id: customerId, tenantId: input.tenantId },
                select: { id: true },
            });
            if (!customer) throw new Error("Kunde nicht gefunden.");
        }

        const vatRate = Number.isFinite(Number(input.vatRate)) ? Math.max(0, Number(input.vatRate)) : 0;

        const lineItems: InvoiceLineItemInput[] = lines.map((line, index) => {
            const quantity = Number(line.quantity ?? 1) || 0;
            const unitAmount = Number(line.unitAmount ?? 0) || 0;
            return {
                description: (line.description || "").trim(),
                // Der Zeile ist anzusehen, ob sie aus dem Katalog kam: ein
                // Artikel steht als Herkunft in `sourceId`, getippte Zeilen
                // sind MANUAL ohne Herkunft.
                sourceType: line.articleId ? "EXTRA_MATERIAL" : "MANUAL",
                sourceId: line.articleId?.trim() || null,
                quantity,
                unitAmount,
                lineTotal: round2(quantity * unitAmount),
                unit: line.unit?.trim() || null,
                sortOrder: index,
            };
        });

        const netTotal = round2(lineItems.reduce((sum, item) => sum + item.lineTotal, 0));
        const grossTotal = round2(netTotal * (1 + vatRate / 100));
        if (grossTotal <= 0) throw new Error("Rechnungsbetrag muss grösser als 0 sein.");

        const invoiceDate = parseIsoDate(input.invoiceDate) ?? new Date();
        const invoiceNumber = await nextDocumentNumber(input.tenantId, "INVOICE");

        return this.invoiceRepository.createWithItems(
            {
                tenantId: input.tenantId,
                customerId,
                // Keine Bindung an Auftrag oder Projekt — genau das macht sie
                // zur Direktrechnung (siehe `deriveInvoiceCategory`).
                projectId: null,
                salesOrderId: null,
                invoiceNumber,
                billingType: "FULL",
                kind: "RECHNUNG",
                invoiceDate,
                // Fälligkeit folgt dem Rechnungsdatum, wenn keine gesetzt ist —
                // dieselbe Regel wie bei der Auftragsrechnung.
                dueDate: parseIsoDate(input.dueDate) ?? invoiceDate,
                salespersonName: input.salespersonName?.trim() || null,
                commissionNumber: input.commissionNumber?.trim() || null,
                billedPercent: 100,
                baseAmount: netTotal,
                amount: grossTotal,
                status: "ISSUED",
                notes: input.notes?.trim() || null,
                recipientName,
                recipientAddress: input.recipientAddress?.trim() || null,
                introText: input.introText?.trim() || null,
                vatRate,
                issuedByEmployeeId: input.issuedByEmployeeId,
            },
            lineItems,
        );
    }
}
