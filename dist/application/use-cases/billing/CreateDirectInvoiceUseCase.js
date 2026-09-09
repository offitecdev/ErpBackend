"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateDirectInvoiceUseCase = exports.buildDirectInvoiceDraft = exports.readSectionFlags = void 0;
const paymentSchedule_1 = require("../../utils/paymentSchedule");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const documentNumber_1 = require("../../../shared/documentNumber");
const tender_discounts_1 = require("../../../presentation/controllers/tender.discounts");
const ALL_SECTIONS = { positions: true, discount: true, closing: true };
/**
 * Liest die Abschnittsschalter aus der Anfrage. Was fehlt, ist EINGESCHALTET —
 * ein alter Client (und jede vor diesem Umbau erstellte Rechnung) druckt so
 * unveraendert alle drei Abschnitte.
 */
const readSectionFlags = (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return { ...ALL_SECTIONS };
    const record = raw;
    const on = (key) => record[key] !== false;
    return { positions: on("positions"), discount: on("discount"), closing: on("closing") };
};
exports.readSectionFlags = readSectionFlags;
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const parseIsoDate = (value) => {
    if (!value)
        return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};
/**
 * ── DER ENTWURF EINER DIREKTRECHNUNG ─────────────────────────────────────────
 * Prüfen, rechnen, in Datensätze giessen — OHNE zu speichern und ohne eine
 * Nummer zu ziehen. Erstellen und Ändern benutzen dieselbe Strecke, damit ein
 * geänderter Beleg nie anders rechnet als ein neuer.
 */
const buildDirectInvoiceDraft = async (input) => {
    const recipientName = (input.recipientName || "").trim();
    if (!recipientName)
        throw new Error("Rechnungsempfänger fehlt.");
    // Leere Zeilen (angelegt, aber nie ausgefüllt) fallen still weg — der
    // Editor lässt sie stehen, auf dem Beleg haben sie nichts zu suchen.
    const lines = (input.lines || []).filter((line) => {
        const hasText = Boolean((line.description || "").trim());
        const hasFigures = Number(line.quantity || 0) !== 0 || Number(line.unitAmount || 0) !== 0;
        return hasText || hasFigures;
    });
    if (lines.length === 0)
        throw new Error("Rechnung ohne Positionen kann nicht erstellt werden.");
    const untitled = lines.find((line) => !(line.description || "").trim());
    if (untitled)
        throw new Error("Jede Position braucht eine Bezeichnung.");
    // Ein Bestandskunde muss dem Mandanten gehören — sonst hinge die
    // Rechnung an einem fremden Datensatz.
    let customerId = input.customerId?.trim() || null;
    if (customerId) {
        const customer = await prisma_client_1.default.customer.findFirst({
            where: { id: customerId, tenantId: input.tenantId },
            select: { id: true },
        });
        if (!customer)
            throw new Error("Kunde nicht gefunden.");
    }
    const vatRate = Number.isFinite(Number(input.vatRate)) ? Math.max(0, Number(input.vatRate)) : 0;
    const lineItems = lines.map((line, index) => {
        const quantity = Number(line.quantity ?? 1);
        const unitAmount = Number(line.unitAmount ?? 0);
        if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitAmount) || unitAmount < 0 || !Number.isFinite(quantity * unitAmount))
            throw new Error('Menge oder Preis ung?ltig.');
        // Zeilenrabatt wie auf der Offerte: der Stapel greift auf Menge ×
        // Einzelpreis, und `lineTotal` ist das, was danach uebrig bleibt
        // (NETTO — die MWST kommt erst im Summenblock dazu). `discount`
        // spiegelt den Stapel als EINE Prozentzahl, genau wie
        // `Position.discount` es fuer eine Offertzeile tut.
        const lineBase = round2(quantity * unitAmount);
        const lineDiscountsJson = (0, tender_discounts_1.normalizeDiscountList)(line.discounts, tender_discounts_1.MAX_LINE_DISCOUNTS);
        const lineDiscounts = (0, tender_discounts_1.parseDiscountList)(lineDiscountsJson, tender_discounts_1.MAX_LINE_DISCOUNTS);
        const lineNet = round2((0, tender_discounts_1.remainingAfterDiscounts)(lineBase, lineDiscounts));
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
            discount: lineDiscounts.length > 0 ? (0, tender_discounts_1.combinedDiscountPercent)(lineBase, lineDiscounts) : null,
            unit: line.unit?.trim() || null,
            sortOrder: index,
        };
    });
    // ── Abschnitte und Rabatt ────────────────────────────────────────────
    // Der Rabattstapel wird NUR gerechnet, wenn sein Abschnitt eingeschaltet
    // ist — abgeschaltet ist er weder auf dem Beleg noch im Betrag. Die
    // Rabatte greifen nacheinander (jeder auf den Rest des vorigen), genau
    // wie auf der Offerte; die MWST rechnet auf dem rabattierten Netto.
    const sections = (0, exports.readSectionFlags)(input.sections);
    const discountsJson = sections.discount
        ? (0, tender_discounts_1.normalizeDiscountList)(input.discounts, tender_discounts_1.MAX_TOTAL_DISCOUNTS)
        : null;
    const discountList = (0, tender_discounts_1.parseDiscountList)(discountsJson, tender_discounts_1.MAX_TOTAL_DISCOUNTS);
    const linesTotal = round2(lineItems.reduce((sum, item) => sum + item.lineTotal, 0));
    const netTotal = round2((0, tender_discounts_1.remainingAfterDiscounts)(linesTotal, discountList));
    const grossTotal = round2(netTotal * (1 + vatRate / 100));
    if (grossTotal <= 0)
        throw new Error("Rechnungsbetrag muss grösser als 0 sein.");
    const stages = (0, paymentSchedule_1.normalizePaymentStages)(input.paymentStages);
    if (input.paymentStages != null && !stages && !(Array.isArray(input.paymentStages) && input.paymentStages.length === 0))
        throw new Error('Zahlungsplan ung?ltig.');
    const planError = stages?.length ? (0, paymentSchedule_1.validatePaymentStages)(stages) : null;
    if (planError)
        throw new Error(planError);
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
            paymentStages: stages?.length ? (0, paymentSchedule_1.serializePaymentStages)(stages) : null,
        },
        lineItems,
    };
};
exports.buildDirectInvoiceDraft = buildDirectInvoiceDraft;
class CreateDirectInvoiceUseCase {
    invoiceRepository;
    constructor(invoiceRepository) {
        this.invoiceRepository = invoiceRepository;
    }
    async execute(input) {
        const draft = await (0, exports.buildDirectInvoiceDraft)(input);
        // Die Nummer wird ERST hier gezogen — ein abgewiesener Entwurf soll
        // keine Lücke in der RE-Reihe hinterlassen.
        const invoiceNumber = await (0, documentNumber_1.nextDocumentNumber)(input.tenantId, 'INVOICE');
        return this.invoiceRepository.createWithItems({ ...draft.invoice, invoiceNumber, status: 'ISSUED', issuedByEmployeeId: input.issuedByEmployeeId }, draft.lineItems);
    }
}
exports.CreateDirectInvoiceUseCase = CreateDirectInvoiceUseCase;
//# sourceMappingURL=CreateDirectInvoiceUseCase.js.map