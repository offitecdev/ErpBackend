"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateDirectInvoiceUseCase = void 0;
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const documentNumber_1 = require("../../../shared/documentNumber");
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const parseIsoDate = (value) => {
    if (!value)
        return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};
class CreateDirectInvoiceUseCase {
    invoiceRepository;
    constructor(invoiceRepository) {
        this.invoiceRepository = invoiceRepository;
    }
    async execute(input) {
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
        if (grossTotal <= 0)
            throw new Error("Rechnungsbetrag muss grösser als 0 sein.");
        const invoiceDate = parseIsoDate(input.invoiceDate) ?? new Date();
        const invoiceNumber = await (0, documentNumber_1.nextDocumentNumber)(input.tenantId, "INVOICE");
        return this.invoiceRepository.createWithItems({
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
        }, lineItems);
    }
}
exports.CreateDirectInvoiceUseCase = CreateDirectInvoiceUseCase;
//# sourceMappingURL=CreateDirectInvoiceUseCase.js.map