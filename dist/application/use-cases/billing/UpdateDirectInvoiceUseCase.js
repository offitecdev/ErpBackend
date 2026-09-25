"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateDirectInvoiceUseCase = void 0;
const CreateDirectInvoiceUseCase_1 = require("./CreateDirectInvoiceUseCase");
const invoiceErrors_1 = require("./invoiceErrors");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const directInvoiceDocument_1 = require("../../../shared/directInvoiceDocument");
/**
 * ── EINE DIREKTRECHNUNG ÄNDERN ───────────────────────────────────────────────
 *
 * Vorgabe Samet (05.09.2026): «für die direkt erzeugten Rechnungen soll es
 * einen Bearbeiten-Knopf geben». Also darf eine Direktrechnung noch einmal
 * geöffnet und als GANZES neu geschrieben werden — Empfänger, Texte,
 * Positionen, Rabatte, Zahlungsplan.
 *
 * Die Belegnummer ist editierbar und wird innerhalb der Schreibtransaktion
 * auf Eindeutigkeit geprüft. Der Zahlungsstand bleibt erhalten; ein Entwurf
 * kann mit `draft: false` direkt ausgestellt werden.
 *
 * Und zwei Rechnungen sind hier NICHT zu ändern: eine BEZAHLTE (das Geld ist
 * gegen den alten Betrag geflossen) und eine STORNIERTE (sie ist Geschichte).
 * Auch eine Auftrags- oder Projektrechnung nicht — die entsteht aus ihrem
 * Auftrag und wird dort gerechnet.
 *
 * Die Zahlen kommen aus derselben Strecke wie beim Erstellen
 * (`buildDirectInvoiceDraft`): eine zweite Rechenstrecke wäre eine zweite
 * Wahrheit, und ein geänderter Beleg müsste sonst anders rechnen als ein neuer.
 */
class UpdateDirectInvoiceUseCase {
    invoiceRepository;
    constructor(invoiceRepository) {
        this.invoiceRepository = invoiceRepository;
    }
    async execute(id, input) {
        const existing = await this.invoiceRepository.findById(id, input.tenantId);
        if (!existing)
            throw (0, invoiceErrors_1.invoiceError)('NOT_FOUND', 'Rechnung nicht gefunden.', { status: 404 });
        if (existing.salesOrderId || existing.projectId) {
            throw (0, invoiceErrors_1.invoiceError)('DIRECT_ONLY', 'Nur eine Direktrechnung kann hier geändert werden.', { status: 409 });
        }
        if (existing.status === 'PAID')
            throw (0, invoiceErrors_1.invoiceError)('PAID_LOCKED', 'Eine bezahlte Rechnung kann nicht geändert werden.', { status: 409 });
        if (existing.status === 'CANCELLED')
            throw (0, invoiceErrors_1.invoiceError)('CANCELLED_LOCKED', 'Eine stornierte Rechnung kann nicht geändert werden.', { status: 409 });
        // Mit Zahlungseingang oder Gutschrift steht der Betrag fest (Schritt 7).
        const [payments, credits] = await Promise.all([
            prisma_client_1.default.invoicePayment.count({ where: { invoiceId: id } }),
            prisma_client_1.default.invoice.count({ where: { reversesInvoiceId: id, NOT: { status: 'DRAFT' } } }),
        ]);
        if (payments > 0 || credits > 0) {
            throw (0, invoiceErrors_1.invoiceError)('PAID_LOCKED', 'Auf dieser Rechnung sind Zahlungen oder Gutschriften erfasst — sie kann nicht mehr geändert werden.', { status: 409 });
        }
        // Gegenbelege sind endgültig (Schritt 6).
        if (existing.kind === 'STORNO' || existing.kind === 'GUTSCHRIFT') {
            throw (0, invoiceErrors_1.invoiceError)('CREDIT_DOCUMENT_FINAL', 'Ein Gegenbeleg wird nicht geändert.', { status: 409 });
        }
        // Older clients preserve document preferences when they do not send them.
        let savedOptions;
        try {
            savedOptions = JSON.parse(existing.sections || '{}').document;
        }
        catch {
            savedOptions = undefined;
        }
        const draft = await (0, CreateDirectInvoiceUseCase_1.buildDirectInvoiceDraft)({ ...input, documentOptions: input.documentOptions ?? savedOptions });
        const options = (0, directInvoiceDocument_1.normalizeDirectInvoiceDocument)(input.documentOptions ?? savedOptions, Number(input.vatRate) || 0);
        return this.invoiceRepository.updateWithItems(id, {
            ...draft.invoice,
            // Payment state stays with the existing invoice; its code may be edited.
            invoiceNumber: existing.invoiceNumber,
            status: existing.status === 'DRAFT' && input.draft === false ? 'ISSUED' : existing.status,
            paidAt: existing.paidAt ?? null,
            issuedByEmployeeId: existing.issuedByEmployeeId,
        }, draft.lineItems, (existing.status !== 'DRAFT' && input.invoiceNumber != null) || (existing.status === 'DRAFT' && input.draft === false)
            ? { requested: input.invoiceNumber || existing.invoiceNumber, proforma: options.language === 'en', year: draft.invoice.invoiceDate.getFullYear() }
            : undefined);
    }
}
exports.UpdateDirectInvoiceUseCase = UpdateDirectInvoiceUseCase;
//# sourceMappingURL=UpdateDirectInvoiceUseCase.js.map