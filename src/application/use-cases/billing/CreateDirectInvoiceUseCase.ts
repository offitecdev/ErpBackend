import { normalizePaymentStages, serializePaymentStages, validatePaymentStages } from '../../utils/paymentSchedule';
import { IInvoiceRepository, InvoiceLineItemInput } from "../../../domain/repositories/IInvoiceRepository";
import { Invoice } from "../../../domain/entities/Invoice";
import prisma from "../../../infrastructure/database/prisma.client";
import { nextDocumentNumber } from "../../../shared/documentNumber";
import {
    combinedDiscountPercent,
    MAX_LINE_DISCOUNTS,
    MAX_TOTAL_DISCOUNTS,
    normalizeDiscountList,
    parseDiscountList,
    remainingAfterDiscounts,
} from "../../../presentation/controllers/tender.discounts";
import { invoiceError } from './invoiceErrors';

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
    /**
     * Beschreibung UNTER der Bezeichnung — dieselbe Rolle wie
     * `Position.longDescription` auf der Offerte. Vorgabe Samet: die Rechnung
     * muss genau die Offertentabelle zeigen, „mit Beschreibung und allem".
     */
    longDescription?: string | null;
    quantity?: number | null;
    unitAmount?: number | null;
    unit?: string | null;
    /** Zeilenrabatt — Stapel wie `Position.discounts` (Liste oder JSON-Text). */
    discounts?: unknown;
    /** Katalogartikel, aus dem die Zeile kopiert wurde (nur Herkunftsnachweis). */
    articleId?: string | null;
}

/**
 * ── DIE DREI ABSCHNITTE DES BELEGS ───────────────────────────────────────────
 * Positionen · Rabatt · Schlusstext. Jeder darf entfernt werden; entfernt heisst
 * "steht nicht auf dem PDF".
 *
 * Zwei davon aendern dabei auch den BETRAG bzw. nur das Bild:
 *  - `discount` aus  → der Rabattstapel wird nicht gerechnet und nicht gedruckt
 *                      (die Rechnung wird also teurer — das ist beabsichtigt).
 *  - `positions` aus → die Zeilen bleiben gespeichert und bleiben die Grundlage
 *                      des Betrags, aber die Tabelle wird nicht gedruckt: der
 *                      Beleg zeigt dann nur noch die Summe.
 *  - `closing` aus   → kein Absatz unter der Summe.
 */
export interface InvoiceSectionFlags {
    positions: boolean;
    discount: boolean;
    closing: boolean;
}

const ALL_SECTIONS: InvoiceSectionFlags = { positions: true, discount: true, closing: true };

/**
 * Liest die Abschnittsschalter aus der Anfrage. Was fehlt, ist EINGESCHALTET —
 * ein alter Client (und jede vor diesem Umbau erstellte Rechnung) druckt so
 * unveraendert alle drei Abschnitte.
 */
export const readSectionFlags = (raw: unknown): InvoiceSectionFlags => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...ALL_SECTIONS };
    const record = raw as Record<string, unknown>;
    const on = (key: keyof InvoiceSectionFlags) => record[key] !== false;
    return { positions: on("positions"), discount: on("discount"), closing: on("closing") };
};

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
    /** Welche der drei Abschnitte gedruckt werden. Fehlt = alle drei. */
    sections?: unknown;
    /** Rabattstapel — Form wie `Tender.totalDiscounts` (Liste oder JSON-Text). */
    discounts?: unknown;
    /** Absatz unter der Summe. Leer = der Satz aus den Firmeneinstellungen. */
    closingText?: string | null;
    /** Gedruckte Absenderzeile. Leer = die Zeile aus den Firmeneinstellungen. */
    senderAddress?: string | null;
    paymentStages?: unknown;
}

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const parseIsoDate = (value: string | null | undefined): Date | null => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * ── DER ENTWURF EINER DIREKTRECHNUNG ─────────────────────────────────────────
 * Prüfen, rechnen, in Datensätze giessen — OHNE zu speichern und ohne eine
 * Nummer zu ziehen. Erstellen und Ändern benutzen dieselbe Strecke, damit ein
 * geänderter Beleg nie anders rechnet als ein neuer.
 */
export const buildDirectInvoiceDraft = async (input: CreateDirectInvoiceInput): Promise<{
    invoice: Record<string, unknown>;
    lineItems: InvoiceLineItemInput[];
}> => {
    const recipientName = (input.recipientName || "").trim();
    if (!recipientName) throw invoiceError('NEED_RECIPIENT', 'Rechnungsempfänger fehlt.');

    // Leere Zeilen (angelegt, aber nie ausgefüllt) fallen still weg — der
    // Editor lässt sie stehen, auf dem Beleg haben sie nichts zu suchen.
    const lines = (input.lines || []).filter((line) => {
        const hasText = Boolean((line.description || "").trim());
        const hasFigures = Number(line.quantity || 0) !== 0 || Number(line.unitAmount || 0) !== 0;
        return hasText || hasFigures;
    });
    if (lines.length === 0) throw invoiceError('NEED_LINES', 'Rechnung ohne Positionen kann nicht erstellt werden.');
    const untitled = lines.find((line) => !(line.description || "").trim());
    if (untitled) throw invoiceError('LINE_NEEDS_TITLE', 'Jede Position braucht eine Bezeichnung.');

    // Ein Bestandskunde muss dem Mandanten gehören — sonst hinge die
    // Rechnung an einem fremden Datensatz.
    let customerId: string | null = input.customerId?.trim() || null;
    if (customerId) {
        const customer = await (prisma as any).customer.findFirst({
            where: { id: customerId, tenantId: input.tenantId },
            select: { id: true },
        });
        if (!customer) throw invoiceError('CUSTOMER_NOT_FOUND', 'Kunde nicht gefunden.', { status: 404 });
    }

    const vatRate = Number.isFinite(Number(input.vatRate)) ? Math.max(0, Number(input.vatRate)) : 0;

    const lineItems: InvoiceLineItemInput[] = lines.map((line, index) => {
        const quantity = Number(line.quantity ?? 1);
        const unitAmount = Number(line.unitAmount ?? 0);
        if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitAmount) || unitAmount < 0 || !Number.isFinite(quantity * unitAmount)) throw invoiceError('LINE_INVALID', 'Menge oder Preis ungültig.');
        // Zeilenrabatt wie auf der Offerte: der Stapel greift auf Menge ×
        // Einzelpreis, und `lineTotal` ist das, was danach uebrig bleibt
        // (NETTO — die MWST kommt erst im Summenblock dazu). `discount`
        // spiegelt den Stapel als EINE Prozentzahl, genau wie
        // `Position.discount` es fuer eine Offertzeile tut.
        const lineBase = round2(quantity * unitAmount);
        const lineDiscountsJson = normalizeDiscountList(line.discounts, MAX_LINE_DISCOUNTS);
        const lineDiscounts = parseDiscountList(lineDiscountsJson, MAX_LINE_DISCOUNTS);
        const lineNet = round2(remainingAfterDiscounts(lineBase, lineDiscounts));
        return {
            description: (line.description || "").trim(),
            longDescription: line.longDescription?.trim() || null,
            // Der Zeile ist anzusehen, ob sie aus dem Katalog kam: ein
            // Artikel steht als Herkunft in `sourceId`, getippte Zeilen
            // sind MANUAL ohne Herkunft.
            sourceType: line.articleId ? "EXTRA_MATERIAL" : "MANUAL",
            sourceId: line.articleId?.trim() || null,
            quantity,
            unitAmount,
            lineTotal: lineNet,
            discounts: lineDiscountsJson,
            discount: lineDiscounts.length > 0 ? combinedDiscountPercent(lineBase, lineDiscounts) : null,
            unit: line.unit?.trim() || null,
            sortOrder: index,
        };
    });

    // ── Abschnitte und Rabatt ────────────────────────────────────────────
    // Der Rabattstapel wird NUR gerechnet, wenn sein Abschnitt eingeschaltet
    // ist — abgeschaltet ist er weder auf dem Beleg noch im Betrag. Die
    // Rabatte greifen nacheinander (jeder auf den Rest des vorigen), genau
    // wie auf der Offerte; die MWST rechnet auf dem rabattierten Netto.
    const sections = readSectionFlags(input.sections);
    const discountsJson = sections.discount
        ? normalizeDiscountList(input.discounts, MAX_TOTAL_DISCOUNTS)
        : null;
    const discountList = parseDiscountList(discountsJson, MAX_TOTAL_DISCOUNTS);

    const linesTotal = round2(lineItems.reduce((sum, item) => sum + item.lineTotal, 0));
    const netTotal = round2(remainingAfterDiscounts(linesTotal, discountList));
    const grossTotal = round2(netTotal * (1 + vatRate / 100));
    if (grossTotal <= 0) throw invoiceError('AMOUNT_ZERO', 'Rechnungsbetrag muss grösser als 0 sein.');

    const stages = normalizePaymentStages(input.paymentStages);
    if (input.paymentStages != null && !stages && !(Array.isArray(input.paymentStages) && input.paymentStages.length === 0)) throw invoiceError('PLAN_INVALID', 'Zahlungsplan ungültig.');
    const planError = stages?.length ? validatePaymentStages(stages) : null;
    if (planError) throw invoiceError('PLAN_INVALID', planError);
    const invoiceDate = parseIsoDate(input.invoiceDate) ?? new Date();

    return {
        invoice: {
            tenantId: input.tenantId,
            customerId,
            // Keine Bindung an Auftrag oder Projekt — genau das macht sie
            // zur Direktrechnung (siehe `deriveInvoiceCategory`).
            projectId: null,
            salesOrderId: null,
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
            notes: input.notes?.trim() || null,
            recipientName,
            recipientAddress: input.recipientAddress?.trim() || null,
            introText: input.introText?.trim() || null,
            vatRate,
            // Der Beleg selbst: welche Abschnitte er zeigt, sein
            // Rabattstapel, sein Schlussabsatz und seine Absenderzeile.
            sections: JSON.stringify(sections),
            discounts: discountsJson,
            closingText: sections.closing ? (input.closingText?.trim() || null) : null,
            // Die Absenderzeile wird EINGEFROREN: eine später geänderte
            // Firmenadresse darf eine gestellte Rechnung nicht umschreiben.
            // Auf EINE Zeile normiert — der Beleg druckt sie als einzelne
            // Zeile über dem Empfängerblock, ein Umbruch ginge dort still
            // verloren. Leer bleibt leer: dann gilt weiter die Einstellung.
            senderAddress: input.senderAddress?.replace(/\s+/g, " ").trim() || null,
            paymentStages: stages?.length ? serializePaymentStages(stages) : null,
        },
        lineItems,
    };
};

export class CreateDirectInvoiceUseCase {
    constructor(private invoiceRepository: IInvoiceRepository) {}

    async execute(input: CreateDirectInvoiceInput): Promise<Invoice> {
        const draft = await buildDirectInvoiceDraft(input);
        // Die Nummer wird ERST hier gezogen — ein abgewiesener Entwurf soll
        // keine Lücke in der RE-Reihe hinterlassen.
        const invoiceNumber = await nextDocumentNumber(input.tenantId, 'INVOICE');
        return this.invoiceRepository.createWithItems(
            { ...draft.invoice, invoiceNumber, status: 'ISSUED', issuedByEmployeeId: input.issuedByEmployeeId },
            draft.lineItems,
        );
    }
}
