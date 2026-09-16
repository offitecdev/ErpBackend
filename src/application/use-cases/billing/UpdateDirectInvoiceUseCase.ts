import { IInvoiceRepository } from '../../../domain/repositories/IInvoiceRepository';
import { Invoice } from '../../../domain/entities/Invoice';
import { buildDirectInvoiceDraft, type CreateDirectInvoiceInput } from './CreateDirectInvoiceUseCase';
import { invoiceError } from './invoiceErrors';

/**
 * ── EINE DIREKTRECHNUNG ÄNDERN ───────────────────────────────────────────────
 *
 * Vorgabe Samet (05.09.2026): «für die direkt erzeugten Rechnungen soll es
 * einen Bearbeiten-Knopf geben». Also darf eine Direktrechnung noch einmal
 * geöffnet und als GANZES neu geschrieben werden — Empfänger, Texte,
 * Positionen, Rabatte, Zahlungsplan.
 *
 * Zwei Dinge ändert sie NIE:
 *   • **Die Nummer bleibt.** Sie ist die Kennung des Belegs; eine neue würde
 *     eine zweite Rechnung erfinden und eine Lücke in der Reihe lassen.
 *   • **Der Status bleibt** (samt Zahlungsdatum): «bezahlt» ist eine Tatsache
 *     aus der Buchhaltung, keine Eingabe dieser Maske.
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
export class UpdateDirectInvoiceUseCase {
    constructor(private invoiceRepository: IInvoiceRepository) {}

    async execute(id: string, input: CreateDirectInvoiceInput): Promise<Invoice> {
        const existing = await this.invoiceRepository.findById(id, input.tenantId);
        if (!existing) throw invoiceError('NOT_FOUND', 'Rechnung nicht gefunden.', { status: 404 });
        if (existing.salesOrderId || existing.projectId) {
            throw invoiceError('DIRECT_ONLY', 'Nur eine Direktrechnung kann hier geändert werden.', { status: 409 });
        }
        if (existing.status === 'PAID') throw invoiceError('PAID_LOCKED', 'Eine bezahlte Rechnung kann nicht geändert werden.', { status: 409 });
        if (existing.status === 'CANCELLED') throw invoiceError('CANCELLED_LOCKED', 'Eine stornierte Rechnung kann nicht geändert werden.', { status: 409 });

        const draft = await buildDirectInvoiceDraft(input);
        return this.invoiceRepository.updateWithItems(
            id,
            {
                ...draft.invoice,
                // Kennung und Zahlungsstand gehören dem bestehenden Beleg.
                invoiceNumber: existing.invoiceNumber,
                status: existing.status,
                paidAt: existing.paidAt ?? null,
                issuedByEmployeeId: existing.issuedByEmployeeId,
            },
            draft.lineItems,
        );
    }
}
