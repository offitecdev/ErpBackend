"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BillingController = void 0;
const documentLifecycle_1 = require("../../shared/documentLifecycle");
const invoicePayments_1 = require("../../shared/invoicePayments");
const accountingOverview_1 = require("../../shared/accountingOverview");
const invoiceErrors_1 = require("../../application/use-cases/billing/invoiceErrors");
const client_1 = require("@prisma/client");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const documentGovernance_1 = require("../../shared/documentGovernance");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const PdfImageThumbnailService_1 = require("../../infrastructure/services/PdfImageThumbnailService");
const documentNumber_1 = require("../../shared/documentNumber");
const INVOICE_CATEGORIES = ['PROJECT', 'DELIVERY', 'DIRECT'];
class BillingController {
    createInvoiceUseCase;
    getSummaryUseCase;
    listInvoicesUseCase;
    updateStatusUseCase;
    draftUseCase;
    creditUseCase;
    createDirectInvoiceUseCase;
    updateDirectInvoiceUseCase;
    updateDatesUseCase;
    constructor(createInvoiceUseCase, getSummaryUseCase, listInvoicesUseCase, updateStatusUseCase, draftUseCase, creditUseCase, createDirectInvoiceUseCase, updateDirectInvoiceUseCase, updateDatesUseCase) {
        this.createInvoiceUseCase = createInvoiceUseCase;
        this.getSummaryUseCase = getSummaryUseCase;
        this.listInvoicesUseCase = listInvoicesUseCase;
        this.updateStatusUseCase = updateStatusUseCase;
        this.draftUseCase = draftUseCase;
        this.creditUseCase = creditUseCase;
        this.createDirectInvoiceUseCase = createDirectInvoiceUseCase;
        this.updateDirectInvoiceUseCase = updateDirectInvoiceUseCase;
        this.updateDatesUseCase = updateDatesUseCase;
    }
    /** Verlauf: ein Entwurf ist angelegt (noch ohne Nummer). */
    async logDraftCreated(req, invoice) {
        await (0, documentGovernance_1.recordDocumentEvent)(prisma_client_1.default, {
            tenantId: req.user.tenantId,
            entityType: 'INVOICE',
            entityId: invoice.id,
            documentNumber: null,
            action: 'DRAFT_CREATED',
            actorId: req.user.id,
            snapshot: { kind: invoice.kind, percent: Number(invoice.billedPercent || 0), amount: Number(invoice.amount || 0) },
            links: { projectId: invoice.projectId ?? null, salesOrderId: invoice.salesOrderId ?? null },
            ipAddress: (0, documentGovernance_1.requestIp)(req),
        }).catch((error) => console.error('[Billing] Verlauf nicht geschrieben:', error?.message || error));
    }
    /** Eine Rechnung in voller Form (Detailseite der Buchhaltung) — mit ihren Regeln. */
    async getById(req, res) {
        try {
            const [invoice] = await this.listInvoicesUseCase.execute({ tenantId: req.user.tenantId, id: String(req.params.id) });
            if (!invoice)
                return res.status(404).json({ error: 'Rechnung nicht gefunden.', code: 'NOT_FOUND' });
            const [lifecycle, paymentRows] = await Promise.all([
                (0, documentLifecycle_1.readInvoiceLifecycle)(prisma_client_1.default, invoice),
                prisma_client_1.default.invoicePayment.findMany({
                    where: { invoiceId: invoice.id },
                    orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }],
                    select: { id: true, amount: true, kind: true, paidAt: true, note: true, createdById: true, createdAt: true },
                }),
            ]);
            const authorIds = [...new Set(paymentRows.map((row) => row.createdById).filter(Boolean))];
            const authors = authorIds.length
                ? await prisma_client_1.default.employee.findMany({ where: { id: { in: authorIds } }, select: { id: true, firstName: true, lastName: true } })
                : [];
            const nameOf = new Map(authors.map((row) => [row.id, `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim()]));
            const payments = paymentRows.map((row) => ({
                id: row.id,
                amount: Number(row.amount),
                kind: row.kind,
                paidAt: row.paidAt,
                note: row.note ?? null,
                createdByName: row.createdById ? nameOf.get(row.createdById) ?? null : null,
                createdAt: row.createdAt,
            }));
            res.status(200).json({ ...invoice, lifecycle, payments });
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    /** Den Entwurf einer Auftragsrechnung neu rechnen (Prozent, Daten, Notiz). */
    async updateDraft(req, res) {
        try {
            const invoice = await this.draftUseCase.updateOrderDraft(String(req.params.id), req.user.tenantId, {
                percent: req.body?.percent == null || req.body?.percent === '' ? null : Number(req.body.percent),
                invoiceDate: req.body?.invoiceDate ?? null,
                dueDate: req.body?.dueDate ?? null,
                salespersonName: req.body?.salespersonName ?? null,
                commissionNumber: req.body?.commissionNumber ?? null,
                notes: req.body?.notes ?? null,
            });
            res.status(200).json({ message: 'Entwurf gespeichert.', invoice });
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    /** Zahlungseingang erfassen (auch in Teilen) — Schritt 7 / G19. */
    async addPayment(req, res) {
        try {
            const raw = req.body?.amount;
            const payment = await prisma_client_1.default.$transaction((tx) => (0, invoicePayments_1.recordPaymentWithin)(tx, {
                invoiceId: String(req.params.id),
                tenantId: req.user.tenantId,
                amount: raw == null || raw === '' ? null : Number(raw),
                paidAt: req.body?.paidAt ?? null,
                note: req.body?.note ? String(req.body.note) : null,
                actor: { employeeId: req.user.id, ip: (0, documentGovernance_1.requestIp)(req) },
            }));
            res.status(201).json({ message: 'Zahlung erfasst.', payment });
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    /** Einen falsch erfassten Eingang entfernen. */
    async removePayment(req, res) {
        try {
            await prisma_client_1.default.$transaction((tx) => (0, invoicePayments_1.removePaymentWithin)(tx, {
                invoiceId: String(req.params.id),
                paymentId: String(req.params.paymentId),
                tenantId: req.user.tenantId,
                actor: { employeeId: req.user.id, ip: (0, documentGovernance_1.requestIp)(req) },
            }));
            res.status(200).json({ message: 'Zahlung entfernt.' });
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    /** Die vier Zahlen, Altersstruktur, offene Rückzahlungen (Buchhaltung). */
    async figures(req, res) {
        try {
            res.json(await (0, accountingOverview_1.loadAccountingFigures)(prisma_client_1.default, req.user.tenantId, String(req.query.today || '')));
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    /** «Zu verrechnen» — Schritt 7 / G14. */
    async toBill(req, res) {
        try {
            res.json(await (0, accountingOverview_1.loadToBill)(prisma_client_1.default, req.user.tenantId, String(req.query.today || '')));
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    /** STORNO: eine offene Rechnung wird durch eine Storno-Rechnung aufgehoben. */
    async storno(req, res) {
        try {
            if (!await (0, RbacMiddleware_1.userHasPermission)(req.user.id, 'invoices.cancel')) {
                return res.status(403).json({ error: 'Ihrer Rolle fehlt das Recht, Rechnungen zu stornieren.', code: 'CANCEL_NOT_PERMITTED' });
            }
            const document = await this.creditUseCase.storno(String(req.params.id), req.user.tenantId, String(req.body?.reason ?? ''), {
                employeeId: req.user.id,
                ip: (0, documentGovernance_1.requestIp)(req),
            });
            res.status(201).json({ message: 'Storno-Rechnung ausgestellt.', document });
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    /** GUTSCHRIFT zu einer bezahlten Rechnung (ganz oder teilweise). */
    async credit(req, res) {
        try {
            if (!await (0, RbacMiddleware_1.userHasPermission)(req.user.id, 'invoices.cancel')) {
                return res.status(403).json({ error: 'Ihrer Rolle fehlt das Recht, Gutschriften auszustellen.', code: 'CREDIT_NOT_PERMITTED' });
            }
            const raw = req.body?.amount;
            const amount = raw == null || raw === '' ? null : Number(raw);
            const document = await this.creditUseCase.credit(String(req.params.id), req.user.tenantId, amount, String(req.body?.reason ?? ''), {
                employeeId: req.user.id,
                ip: (0, documentGovernance_1.requestIp)(req),
            });
            res.status(201).json({ message: 'Gutschrift ausgestellt.', document });
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    /** Ausstellen: der Entwurf bekommt seine RE-Nummer. */
    async issue(req, res) {
        try {
            const invoice = await this.draftUseCase.issue(String(req.params.id), req.user.tenantId, {
                employeeId: req.user.id,
                ip: (0, documentGovernance_1.requestIp)(req),
            });
            res.status(200).json({ message: 'Rechnung ausgestellt.', invoice });
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    async getSummary(req, res) {
        try {
            const salesOrderId = req.query.salesOrderId ? String(req.query.salesOrderId) : null;
            const projectId = req.query.projectId ? String(req.query.projectId) : null;
            const summary = await this.getSummaryUseCase.execute({ tenantId: req.user.tenantId, salesOrderId, projectId });
            res.status(200).json(summary);
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    async list(req, res) {
        try {
            // The project table needs only billing progress, not invoice rows,
            // line items, customer/order labels or PDF metadata. Aggregate active
            // percentages in one statement so this view never executes the full
            // two-query invoice-list path.
            if (String(req.query.view || '') === 'project-list') {
                const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                    SELECT i.projectId, i.salesOrderId, SUM(i.billedPercent) AS billedPercent
                    FROM Invoice i
                    WHERE i.tenantId = ${req.user.tenantId}
                      AND i.status NOT IN ('CANCELLED', 'DRAFT') AND i.kind <> 'STORNO'
                      AND (i.projectId IS NOT NULL OR i.salesOrderId IS NOT NULL)
                    GROUP BY i.projectId, i.salesOrderId
                `);
                return res.status(200).json(rows.map((row) => ({
                    projectId: row.projectId ?? null,
                    salesOrderId: row.salesOrderId ?? null,
                    billedPercent: Number(row.billedPercent || 0),
                    status: 'ISSUED',
                })));
            }
            // Der Rechnungstyp ist abgeleitet; ein unbekannter Wert wird still
            // fallen gelassen statt die Liste leer zu lassen.
            const rawCategory = req.query.category ? String(req.query.category) : '';
            const category = INVOICE_CATEGORIES.includes(rawCategory)
                ? rawCategory
                : undefined;
            const invoices = await this.listInvoicesUseCase.execute({
                tenantId: req.user.tenantId,
                projectId: req.query.projectId ? String(req.query.projectId) : undefined,
                salesOrderId: req.query.salesOrderId ? String(req.query.salesOrderId) : undefined,
                customerId: req.query.customerId ? String(req.query.customerId) : undefined,
                status: req.query.status ? String(req.query.status) : undefined,
                category,
            });
            res.status(200).json(invoices);
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    async create(req, res) {
        try {
            const invoice = await this.createInvoiceUseCase.execute({
                tenantId: req.user.tenantId,
                issuedByEmployeeId: req.user.id,
                salesOrderId: req.body.salesOrderId,
                projectId: req.body.projectId,
                billingType: req.body.billingType === 'PARTIAL' ? 'PARTIAL' : 'FULL',
                kind: req.body.kind ?? null,
                percent: req.body.percent,
                invoiceDate: req.body.invoiceDate ?? null,
                dueDate: req.body.dueDate ?? null,
                salespersonName: req.body.salespersonName ?? null,
                commissionNumber: req.body.commissionNumber ?? null,
                // Fatura kodu sunucuda üretilir (RE-2026-10001); gövdeden gelen
                // `invoiceNumber` artık kabul edilmiyor.
                notes: req.body.notes,
                // Buchhaltung (Schritt 5): zuerst ein Entwurf ohne Nummer.
                draft: req.body.draft === true,
            });
            if (req.body.draft === true)
                await this.logDraftCreated(req, invoice);
            res.status(201).json({ message: 'Fatura oluşturuldu.', invoice });
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    /**
     * Die Nummer, die die NÄCHSTE Rechnung bekäme — für die Vorschau der
     * Erfassungsmaske, damit dort nicht «Entwurf» steht (Vorgabe Samet
     * 05.09.2026). Der Zähler wird dabei NICHT bewegt: vergeben wird die Nummer
     * erst beim Erstellen, und wer in derselben Minute eine Rechnung stellt,
     * bekommt sie. Die Vorschau ist eine Auskunft, keine Reservierung.
     */
    async nextInvoiceNumber(req, res) {
        try {
            const invoiceNumber = await (0, documentNumber_1.peekDocumentNumber)(req.user.tenantId, 'INVOICE');
            res.status(200).json({ invoiceNumber, preview: true });
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    /**
     * Direktrechnung — die selbst ausgefüllte Vorlage: kein Auftrag, kein
     * Projekt, die Positionen sind der Betrag. Die Zeilen kommen so an, wie sie
     * auf dem Beleg stehen; die Reihenfolge ist ihre Reihenfolge im Feld.
     */
    async createDirect(req, res) {
        try {
            const invoice = await this.createDirectInvoiceUseCase.execute({
                tenantId: req.user.tenantId,
                issuedByEmployeeId: req.user.id,
                customerId: req.body.customerId ?? null,
                recipientName: String(req.body.recipientName || ''),
                recipientAddress: req.body.recipientAddress ?? null,
                introText: req.body.introText ?? null,
                invoiceDate: req.body.invoiceDate ?? null,
                dueDate: req.body.dueDate ?? null,
                salespersonName: req.body.salespersonName ?? null,
                commissionNumber: req.body.commissionNumber ?? null,
                vatRate: req.body.vatRate ?? null,
                notes: req.body.notes ?? null,
                lines: Array.isArray(req.body.lines) ? req.body.lines : [],
                // Die drei Abschnitte des Belegs (Positionen · Rabatt ·
                // Schlusstext), der Rabattstapel und die eigene Absenderzeile.
                sections: req.body.sections ?? null,
                discounts: req.body.discounts ?? null,
                closingText: req.body.closingText ?? null,
                senderAddress: req.body.senderAddress ?? null,
                paymentStages: req.body.paymentStages ?? null,
                draft: req.body.draft === true,
            });
            if (req.body.draft === true)
                await this.logDraftCreated(req, invoice);
            res.status(201).json({ message: 'Rechnung erstellt.', invoice });
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    /**
     * Eine Direktrechnung ändern (Vorgabe Samet 05.09.2026: «für die direkt
     * erzeugten Rechnungen ein Bearbeiten-Knopf»). Der Körper ist derselbe wie
     * beim Erstellen — der Beleg wird als GANZES neu geschrieben; Nummer und
     * Zahlungsstand bleiben, siehe `UpdateDirectInvoiceUseCase`.
     */
    async updateDirect(req, res) {
        try {
            const invoice = await this.updateDirectInvoiceUseCase.execute(String(req.params.id), {
                tenantId: req.user.tenantId,
                issuedByEmployeeId: req.user.id,
                customerId: req.body.customerId ?? null,
                recipientName: String(req.body.recipientName || ''),
                recipientAddress: req.body.recipientAddress ?? null,
                introText: req.body.introText ?? null,
                invoiceDate: req.body.invoiceDate ?? null,
                dueDate: req.body.dueDate ?? null,
                salespersonName: req.body.salespersonName ?? null,
                commissionNumber: req.body.commissionNumber ?? null,
                vatRate: req.body.vatRate ?? null,
                notes: req.body.notes ?? null,
                lines: Array.isArray(req.body.lines) ? req.body.lines : [],
                sections: req.body.sections ?? null,
                discounts: req.body.discounts ?? null,
                closingText: req.body.closingText ?? null,
                senderAddress: req.body.senderAddress ?? null,
                paymentStages: req.body.paymentStages ?? null,
            });
            res.status(200).json({ message: 'Rechnung gespeichert.', invoice });
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    /**
     * Rechnungsdatum + Fälligkeit korrigieren — auch nach dem Stellen, für
     * jede Rechnungsart (Vorgabe Samet 16.09.2026). Siehe
     * `UpdateInvoiceDatesUseCase`.
     */
    async updateDates(req, res) {
        try {
            const invoice = await this.updateDatesUseCase.execute(String(req.params.id), req.user.tenantId, {
                invoiceDate: req.body?.invoiceDate,
                dueDate: req.body?.dueDate,
            });
            res.status(200).json({ message: 'Rechnung gespeichert.', invoice });
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    async updateStatus(req, res) {
        try {
            const nextStatus = String(req.body.status || '');
            // Ältere Oberflächen stornieren über den Status: das ist seit
            // Schritt 6 eine Storno-Rechnung (Grund fehlt → «Storno»).
            if (nextStatus === 'CANCELLED') {
                const current = await prisma_client_1.default.invoice.findFirst({
                    where: { id: String(req.params.id), tenantId: req.user.tenantId },
                    select: { status: true, kind: true },
                });
                if (current && current.status === 'ISSUED' && current.kind !== 'STORNO' && current.kind !== 'GUTSCHRIFT') {
                    if (!await (0, RbacMiddleware_1.userHasPermission)(req.user.id, 'invoices.cancel')) {
                        return res.status(403).json({ error: 'Ihrer Rolle fehlt das Recht, Rechnungen zu stornieren.', code: 'CANCEL_NOT_PERMITTED' });
                    }
                    const document = await this.creditUseCase.storno(String(req.params.id), req.user.tenantId, String(req.body?.reason || '').trim() || 'Storno', { employeeId: req.user.id, ip: (0, documentGovernance_1.requestIp)(req) });
                    const [invoice] = await this.listInvoicesUseCase.execute({ tenantId: req.user.tenantId, id: String(req.params.id) });
                    return res.status(200).json({ message: 'Storno-Rechnung ausgestellt.', invoice, document });
                }
            }
            const invoice = await this.updateStatusUseCase.execute(req.params.id, req.user.tenantId, nextStatus, 
            // Zahlungseingang — die Liste schickt ihn beim Markieren als
            // bezahlt mit; fehlt er, nimmt der Server "jetzt".
            req.body.paidAt ? String(req.body.paidAt) : null, 
            // Stornieren ist ein eigenes Recht; jeder Wechsel kommt in den
            // Belegverlauf (16.09.2026, Schritt 4).
            {
                employeeId: req.user.id,
                canCancel: nextStatus !== 'CANCELLED' || await (0, RbacMiddleware_1.userHasPermission)(req.user.id, 'invoices.cancel'),
                ip: (0, documentGovernance_1.requestIp)(req),
                reason: req.body.reason ? String(req.body.reason).slice(0, 500) : null,
            });
            res.status(200).json({ message: 'Fatura durumu güncellendi.', invoice });
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    /**
     * ── PRODUKTBILDER DER DIREKTRECHNUNG ─────────────────────────────────────
     *
     * Die Rechnung druckt DIESELBE Positionstabelle wie das Angebot, also auch
     * dessen Produktbilder. Die Offerte holt sie über `/tenders/:id/
     * product-images` — eine Direktrechnung hat aber keine Offerte, an der ein
     * solcher Weg hängen könnte. Darum hier derselbe Dienst noch einmal, nur
     * über die ARTIKEL-Kennungen: `getArticleThumbnails` liefert die auf den
     * 36 × 20 mm-Rahmen des PDF verkleinerten Bilder (die Originale reisen
     * nie, siehe PdfImageThumbnailService).
     *
     * Wie dort werden Artikel OHNE Bild gar nicht erst gelesen: sie stehen mit
     * leerer Zeichenkette statt NULL in der Spalte, und ohne den `notIn`-Filter
     * kämen sie als Bildzeilen zurück, die das PDF sofort wegwirft.
     */
    async getProductImages(req, res) {
        try {
            const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
            const ids = [...new Set(raw.map((value) => String(value || '').trim()).filter(Boolean))];
            if (ids.length === 0)
                return res.status(200).json([]);
            const tenantId = req.user.tenantId;
            const articles = await prisma_client_1.default.article.findMany({
                where: { tenantId, id: { in: ids }, imageUrl: { not: null, notIn: [''] } },
                select: { id: true, updatedAt: true },
            });
            res.status(200).json(await (0, PdfImageThumbnailService_1.getArticleThumbnails)(tenantId, articles));
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
    /**
     * Gelöscht wird nur ein ENTWURF (Schritt 5). Eine ausgestellte Rechnung
     * bleibt als Beleg stehen — auch nach dem Storno (16.09.2026).
     */
    async delete(req, res) {
        try {
            await this.draftUseCase.discard(req.params.id, req.user.tenantId, {
                employeeId: req.user.id,
                ip: (0, documentGovernance_1.requestIp)(req),
            });
            res.status(200).json({ message: 'Entwurf verworfen.' });
        }
        catch (error) {
            res.status(error?.status || 400).json((0, invoiceErrors_1.invoiceErrorBody)(error));
        }
    }
}
exports.BillingController = BillingController;
//# sourceMappingURL=BillingController.js.map