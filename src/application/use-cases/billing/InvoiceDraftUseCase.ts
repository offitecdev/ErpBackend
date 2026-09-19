import { IInvoiceRepository } from '../../../domain/repositories/IInvoiceRepository';
import { Invoice } from '../../../domain/entities/Invoice';
import prisma from '../../../infrastructure/database/prisma.client';
import { nextDocumentNumber } from '../../../shared/documentNumber';
import { recordDocumentEvent } from '../../../shared/documentGovernance';
import { CreateInvoiceUseCase } from './CreateInvoiceUseCase';
import { invoiceError } from './invoiceErrors';

/**
 * ── RECHNUNGSENTWÜRFE: ÄNDERN, AUSSTELLEN, VERWERFEN (16.09.2026, Schritt 5) ─
 *
 * Vorgabe Samet: eine Rechnung entsteht an EINER Stelle — der Buchhaltung —
 * und zwar in drei Schritten: Auftrag wählen → Vorschlag prüfen → Vorschau →
 * «Ausstellen». Bis zum Ausstellen ist sie ein ENTWURF:
 *
 *   • ohne RE-Nummer (die Reihe bekommt so nie eine Lücke);
 *   • nirgends als verrechnet gezählt (kein Fortschritt, kein Umsatz);
 *   • frei änderbar und ohne Spur löschbar — er ist nie verschickt worden.
 *
 * Beim AUSSTELLEN rechnet eine Auftragsrechnung noch einmal mit dem Stand
 * DIESES Augenblicks (dieselbe Strecke wie das Erstellen): wurde inzwischen
 * eine andere Rechnung ausgestellt, wird aus einer «Rechnung» eine
 * «Schlussrechnung», und ein Akonto über den Rest hinaus wird abgewiesen.
 * Eine Direktrechnung hat keinen Auftrag, gegen den sich etwas verschieben
 * könnte — sie bekommt nur ihre Nummer.
 */

type Actor = { employeeId: string; ip?: string | null };

const CLOSING_KINDS = new Set(['RECHNUNG', 'SCHLUSS']);

const dayOf = (value: unknown): string | null => {
    if (!value) return null;
    const date = new Date(value as any);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};

export interface OrderDraftInput {
    percent?: number | null;
    invoiceDate?: string | null;
    dueDate?: string | null;
    salespersonName?: string | null;
    commissionNumber?: string | null;
    notes?: string | null;
}

export class InvoiceDraftUseCase {
    constructor(
        private invoiceRepository: IInvoiceRepository,
        private createInvoice: CreateInvoiceUseCase,
    ) {}

    private async loadDraft(id: string, tenantId: string): Promise<Invoice> {
        const invoice = await this.invoiceRepository.findById(id, tenantId);
        if (!invoice) throw invoiceError('NOT_FOUND', 'Rechnung nicht gefunden.', { status: 404 });
        if (invoice.status !== 'DRAFT') {
            throw invoiceError('NOT_DRAFT', 'Diese Rechnung ist bereits ausgestellt.', { status: 409 });
        }
        return invoice;
    }

    /**
     * Den Entwurf einer AUFTRAGSrechnung neu rechnen — Prozentsatz, Daten,
     * Verkäufer, Notiz. `percent` fehlt = der offene Rest (Schluss/Rechnung).
     */
    async updateOrderDraft(id: string, tenantId: string, input: OrderDraftInput): Promise<Invoice> {
        const draft = await this.loadDraft(id, tenantId);
        if (!draft.salesOrderId && !draft.projectId) {
            throw invoiceError('DIRECT_ONLY', 'Eine Direktrechnung wird in ihrer eigenen Maske geändert.', { status: 409 });
        }
        const { data, lineItems } = await this.createInvoice.build({
            tenantId,
            issuedByEmployeeId: draft.issuedByEmployeeId,
            salesOrderId: draft.salesOrderId ?? null,
            projectId: draft.salesOrderId ? null : (draft.projectId ?? null),
            percent: input.percent ?? null,
            invoiceDate: input.invoiceDate ?? null,
            dueDate: input.dueDate ?? null,
            salespersonName: input.salespersonName ?? null,
            commissionNumber: input.commissionNumber ?? null,
            notes: input.notes ?? null,
        });
        return this.invoiceRepository.updateWithItems(id, { ...data, invoiceNumber: '', status: 'DRAFT' }, lineItems);
    }

    /** Ausstellen: Nummer ziehen, Status «offen», Verlauf schreiben. */
    async issue(id: string, tenantId: string, actor: Actor): Promise<Invoice> {
        const draft = await this.loadDraft(id, tenantId);
        let issued: Invoice;

        if (draft.salesOrderId || draft.projectId) {
            // Mit dem Stand von JETZT rechnen. Eine abschliessende Rechnung
            // nimmt den dann offenen Rest, eine Teilrechnung ihren Prozentsatz.
            const closes = CLOSING_KINDS.has(String(draft.kind));
            const { data, lineItems } = await this.createInvoice.build({
                tenantId,
                issuedByEmployeeId: actor.employeeId,
                salesOrderId: draft.salesOrderId ?? null,
                projectId: draft.salesOrderId ? null : (draft.projectId ?? null),
                billingType: closes ? 'FULL' : 'PARTIAL',
                percent: closes ? null : Number(draft.billedPercent),
                invoiceDate: dayOf(draft.invoiceDate) ?? dayOf(new Date()),
                dueDate: dayOf(draft.dueDate),
                salespersonName: draft.salespersonName ?? null,
                commissionNumber: draft.commissionNumber ?? null,
                notes: draft.notes ?? null,
            });
            const invoiceNumber = await nextDocumentNumber(tenantId, 'INVOICE');
            issued = await this.invoiceRepository.updateWithItems(
                id,
                { ...data, invoiceNumber, status: 'ISSUED', issuedByEmployeeId: actor.employeeId },
                lineItems,
            );
        } else {
            const invoiceNumber = await nextDocumentNumber(tenantId, 'INVOICE');
            // Nur ein noch offener Entwurf wird ausgestellt — zweimal
            // gleichzeitig «Ausstellen» zieht keine zweite Nummer durch.
            const claimed = await (prisma as any).invoice.updateMany({
                where: { id, tenantId, status: 'DRAFT' },
                data: {
                    invoiceNumber,
                    status: 'ISSUED',
                    issuedByEmployeeId: actor.employeeId,
                    invoiceDate: draft.invoiceDate ?? new Date(),
                    dueDate: draft.dueDate ?? draft.invoiceDate ?? new Date(),
                },
            });
            if (!claimed.count) throw invoiceError('NOT_DRAFT', 'Diese Rechnung ist bereits ausgestellt.', { status: 409 });
            issued = (await this.invoiceRepository.findById(id, tenantId))!;
        }

        await recordDocumentEvent(prisma as any, {
            tenantId,
            entityType: 'INVOICE',
            entityId: id,
            documentNumber: issued.invoiceNumber,
            action: 'ISSUED',
            actorId: actor.employeeId,
            snapshot: {
                kind: issued.kind,
                percent: Number(issued.billedPercent || 0),
                amount: Number(issued.amount || 0),
                invoiceDate: issued.invoiceDate ?? null,
                dueDate: issued.dueDate ?? null,
            },
            links: { projectId: issued.projectId ?? null, salesOrderId: issued.salesOrderId ?? null },
            ipAddress: actor.ip ?? null,
        }).catch((error: any) => console.error('[InvoiceDraft] Verlauf nicht geschrieben:', error?.message || error));

        return issued;
    }

    /** Einen Entwurf verwerfen. Eine ausgestellte Rechnung bleibt IMMER stehen. */
    async discard(id: string, tenantId: string, actor: Actor): Promise<void> {
        const draft = await this.loadDraft(id, tenantId);
        const removed = await this.invoiceRepository.deleteDraft(id, tenantId);
        if (!removed) throw invoiceError('NOT_DRAFT', 'Diese Rechnung ist bereits ausgestellt.', { status: 409 });
        await recordDocumentEvent(prisma as any, {
            tenantId,
            entityType: 'INVOICE',
            entityId: id,
            documentNumber: null,
            action: 'DRAFT_DISCARDED',
            actorId: actor.employeeId,
            snapshot: { kind: draft.kind, amount: Number(draft.amount || 0) },
            links: { projectId: draft.projectId ?? null, salesOrderId: draft.salesOrderId ?? null },
            ipAddress: actor.ip ?? null,
        }).catch((error: any) => console.error('[InvoiceDraft] Verlauf nicht geschrieben:', error?.message || error));
    }
}
