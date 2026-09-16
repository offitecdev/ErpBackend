"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateInvoiceDatesUseCase = void 0;
const invoiceErrors_1 = require("./invoiceErrors");
/**
 * ── RECHNUNGSDATUM UND FÄLLIGKEIT KORRIGIEREN ────────────────────────────────
 *
 * Vorgabe Samet (16.09.2026): die beiden Daten einer Rechnung müssen sich auch
 * NACH dem Stellen noch ändern lassen — für jede Rechnungsart (Projekt,
 * Lieferung, Direkt), offen oder bezahlt. Beide Felder werden als ganzer Tag
 * geschrieben; die Fälligkeit darf nicht vor dem Rechnungsdatum liegen.
 *
 * Nur die STORNIERTE Rechnung bleibt, wie sie ist: sie ist Geschichte.
 * Betrag, Nummer und Status berührt dieser Weg nie.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const parseDay = (value) => {
    const text = String(value ?? '').trim().slice(0, 10);
    if (!DAY.test(text))
        return null;
    // Mittag UTC: in keiner Zeitzone rutscht der Tag auf den Vortag.
    const date = new Date(`${text}T12:00:00.000Z`);
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : date;
};
class UpdateInvoiceDatesUseCase {
    invoiceRepository;
    constructor(invoiceRepository) {
        this.invoiceRepository = invoiceRepository;
    }
    async execute(id, tenantId, input) {
        const invoiceDate = parseDay(input.invoiceDate);
        const dueDate = parseDay(input.dueDate);
        if (!invoiceDate || !dueDate) {
            throw (0, invoiceErrors_1.invoiceError)('DATE_INVALID', 'Rechnungsdatum oder Fälligkeit ungültig.');
        }
        if (dueDate.getTime() < invoiceDate.getTime()) {
            throw (0, invoiceErrors_1.invoiceError)('DUE_BEFORE_DATE', 'Die Fälligkeit darf nicht vor dem Rechnungsdatum liegen.');
        }
        const existing = await this.invoiceRepository.findById(id, tenantId);
        if (!existing)
            throw (0, invoiceErrors_1.invoiceError)('NOT_FOUND', 'Rechnung nicht gefunden.', { status: 404 });
        if (existing.status === 'CANCELLED') {
            throw (0, invoiceErrors_1.invoiceError)('CANCELLED_LOCKED', 'Eine stornierte Rechnung kann nicht geändert werden.', { status: 409 });
        }
        return this.invoiceRepository.updateDates(id, tenantId, invoiceDate, dueDate);
    }
}
exports.UpdateInvoiceDatesUseCase = UpdateInvoiceDatesUseCase;
//# sourceMappingURL=UpdateInvoiceDatesUseCase.js.map