import type { BomProcurementRequest, BomPurchaseLink } from '../../../../domain/entities/ProductionBom';
import type {
    IBomProcurementRepository,
    IBomPurchaseRepository,
    IBomStockReader,
} from '../../../../domain/repositories/IProductionBomRepository';
import type { IProcurementJournal } from '../../../../domain/repositories/IProcurementJournal';
import type { ISupplierEmailBook } from '../../../../domain/repositories/ISupplierEmailBook';
import { cardEmailOf } from '../../../../domain/services/supplierEmails';
import type { ProcurementEventAction } from '../../../../domain/services/procurementFlow';
import { BOM_LIMITS, bomError, CONFIRMED_ORDER_STATUSES, PRICE_REQUEST_STATUSES, sameSupplier, supplierKey } from '../../../../domain/services/productionBom';
import type { PrismaProcurementAutomationRepository } from '../../../../infrastructure/repositories/ProcurementAutomationRepository';
import type { PrismaProcurementMailRepository, ProcurementMailKind, ProcurementMailTrigger } from '../../../../infrastructure/repositories/ProcurementMailRepository';
import { mailSettingsOf, type MailboxPurpose, type PrismaProductionMailboxRepository, type ProductionMailboxRow } from '../../../../infrastructure/repositories/ProductionMailboxRepository';
import { buildProcurementMail, procurementMailSubject, type ProcurementMailFacts } from '../../../../infrastructure/services/procurementMailContent';
import { newMessageId, type MailSettings, type SendMailInput } from '../../../../infrastructure/services/SmtpMailService';
import type { SupplierPdfLang } from '../../../../infrastructure/services/supplierPdfRenderer';
import { localizePurchaseCode } from '../../../../shared/purchaseDocumentCode';
import { PRODUCTION_ARTICLE_NO_KEY, PRODUCTION_ORDER_NO_KEY } from '../../../../shared/standardOrderTemplate';
import type { BomProcurementUseCase } from './BomProcurementUseCase';
import type { BomDocumentStore } from './BomPurchasesUseCase';
import type { BomActor } from './BomTemplatesUseCase';
import type { DeviceBomsUseCase } from './DeviceBomsUseCase';

/**
 * ── DIE AUTOMATIK DER PRODUKTION: SENDEN (30.09.2026, Vorgabe Samet) ───────
 *
 * «Fiyat talepleri artık otomatik gönderiliyor … sipariş gönder dediğimizde
 *  bunları hazırlayıp çıkartıyor ve maillerine atıyor … revize edilince de
 *  otomatik.»
 *
 * EIN Weg für alles, was an einen Lieferanten geht — Preisanfrage (RFQ),
 * Bestellung, geänderte Bestellung (Revision):
 *   1. der Beleg, wie die Seite «PDF» ihn sieht (Positionen, Spalten, Projekt, Revision)
 *   2. das PDF, auf dem Server mit DEMSELBEN Code wie im Browser (supplierPdfRenderer)
 *   3. abgelegt (R2) — man sieht später, WAS hinausging
 *   4. die Mail in der Sprache des PDF, aus dem Postfach der Produktion
 *      (RFQ: rfq@…, Bestellung: ORDER-Postfach oder RFQ), mit eigener Message-ID
 *   5. gestempelt (emailSentAt, Stand: Anfrage → PRICE_REQUEST, Bestellung →
 *      ORDERED = «Onay bekliyor») und im Verlauf des Talep festgehalten.
 * Was nicht geht (keine E-Mail, kein Postfach, keine Angebotsnummer), wird
 * übersprungen und SAGT warum — der Einkauf schickt es dann von Hand.
 */

export type DispatchStatus = 'SENT' | 'PREVIEW' | 'FAILED' | 'SKIPPED';
export type DispatchProblem = 'NO_EMAIL' | 'NO_MAILBOX' | 'QUOTE_NUMBER_REQUIRED' | 'PDF_FAILED' | 'MAIL_FAILED' | 'NOT_SENDABLE';

export interface DispatchResultDto {
    purchaseOrderId: string;
    code: string;
    supplierName: string;
    kind: ProcurementMailKind;
    status: DispatchStatus;
    problem: DispatchProblem | null;
    error: string | null;
    to: string[];
    lang: SupplierPdfLang;
    fileName: string | null;
    fileSize: number | null;
    mailId: string | null;
    sentAt: string | null;
}

export interface DispatchDeps {
    purchases: IBomPurchaseRepository;
    requests: IBomProcurementRepository;
    devices: DeviceBomsUseCase;
    procurement: BomProcurementUseCase;
    stock: IBomStockReader;
    journal: IProcurementJournal;
    automation: PrismaProcurementAutomationRepository;
    mails: PrismaProcurementMailRepository;
    mailboxes: PrismaProductionMailboxRepository;
    /** Die Lieferantenliste als Adressbuch (30.09.2026): Adresse nachschlagen, eingetragene merken. */
    emails: ISupplierEmailBook;
    documents: BomDocumentStore;
    /** Der Beleg wie GET /inventory/purchase-orders/:id (inventory.routes `purchaseOrderDocument`). */
    loadDocument: (tenantId: string, purchaseOrderId: string) => Promise<Record<string, any> | null>;
    renderPdf: (kind: 'ORDER' | 'REQUEST', document: unknown, settings: Record<string, unknown>, lang: SupplierPdfLang) => Promise<Buffer>;
    companySettings: (tenantId: string) => Promise<Record<string, unknown>>;
    sendMail: (settings: MailSettings, mail: SendMailInput) => Promise<{ preview: boolean }>;
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
const cleanEmail = (value: unknown): string | null => {
    const text = String(value ?? '').replace(/^mailto:/i, '').trim();
    return EMAIL.test(text) ? text : null;
};

const fold = (value: unknown): string => String(value ?? '').trim().toLocaleLowerCase('tr-TR');

/** Die Automatik handelt im Namen dessen, der sie auslöste — mit den Rechten des Einkaufs. */
export const systemActorOf = (actor: BomActor | null): BomActor => ({
    id: actor?.id ?? 'system',
    name: actor?.name ?? null,
    lang: actor?.lang ?? null,
    isAdmin: true,
    canManage: true,
    canPurchase: true,
    canSeeProcurement: true,
    canProcure: true,
    canSeeCosting: false,
});

/** Der Wert einer eigenen Spalte der Position (`extras[{key, value}]`) — leer = null. */
const extraText = (item: any, key: string): string | null => {
    const entry = Array.isArray(item?.extras) ? item.extras.find((extra: any) => extra?.key === key) : null;
    return String(entry?.value ?? '').trim() || null;
};

const linesOf = (document: Record<string, any>): ProcurementMailFacts['lines'] => (Array.isArray(document.items) ? document.items : [])
    .filter((item: any) => String(item?.name ?? '').trim())
    .map((item: any) => ({
        name: String(item.name).trim(),
        quantity: Number(item.quantity) || 0,
        unit: String(item.unit ?? '').trim() || null,
        lineTotal: Number(item.lineTotal) || null,
        articleNumber: extraText(item, PRODUCTION_ARTICLE_NO_KEY),
        orderNumber: extraText(item, PRODUCTION_ORDER_NO_KEY),
    }));

export class ProcurementDispatchUseCase {
    constructor(private deps: DispatchDeps) {}

    /* ── Das Postfach ──────────────────────────────────────────────────── */

    /** Das Postfach eines Zwecks — eine Bestellung ohne eigenes nimmt das der Preisanfragen. */
    async mailboxFor(tenantId: string, purpose: MailboxPurpose): Promise<ProductionMailboxRow | null> {
        const usable = (row: ProductionMailboxRow | null) => (row && row.isActive && row.smtpHost && row.fromEmail ? row : null);
        if (purpose === 'ORDER') {
            const own = usable(await this.deps.mailboxes.get(tenantId, 'ORDER'));
            if (own) return own;
        }
        return usable(await this.deps.mailboxes.get(tenantId, 'RFQ'));
    }

    /* ── Einen Beleg senden ────────────────────────────────────────────── */

    async sendDocument(
        tenantId: string,
        actor: BomActor | null,
        purchaseOrderId: string,
        options: { trigger: ProcurementMailTrigger; lang?: SupplierPdfLang | null; to?: string | null } = { trigger: 'MANUAL' },
    ): Promise<DispatchResultDto> {
        const { deps } = this;
        const link = await deps.purchases.linkForOrder(tenantId, purchaseOrderId);
        const document = link ? await deps.loadDocument(tenantId, purchaseOrderId) : null;
        if (!link || !document) throw bomError('PURCHASE_NOT_FOUND', 'Dieser Beleg stammt aus keiner BOM.', { status: 404 });

        const isRequest = link.kind === 'REQUEST';
        const status = String(document.status ?? '').toUpperCase();
        const revisionNumber = Number(document.bomOrigin?.revision?.number) || 0;
        const kind: ProcurementMailKind = isRequest
            ? 'RFQ'
            : options.trigger === 'REVISION' || (revisionNumber > 0 && link.orderRevision > 0) ? 'REVISION' : 'ORDER';
        const meta = (await deps.automation.linkMeta(tenantId, [purchaseOrderId])).get(purchaseOrderId) ?? null;
        // Die Sprache der Oberfläche dessen, der sendet, geht vor (30.09.2026) — sonst die des Angebots.
        const lang: SupplierPdfLang = options.lang ?? actor?.lang ?? meta?.documentLanguage ?? 'de';
        const base: DispatchResultDto = {
            purchaseOrderId,
            code: String(document.referenceNumber ?? ''),
            supplierName: String(document.supplierName ?? ''),
            kind,
            status: 'SKIPPED',
            problem: null,
            error: null,
            to: [],
            lang,
            fileName: null,
            fileSize: null,
            mailId: null,
            sentAt: null,
        };

        if (isRequest ? !PRICE_REQUEST_STATUSES.has(status) : status === 'COMPLETED' || status === 'CANCELLED') {
            return { ...base, problem: 'NOT_SENDABLE' };
        }
        // «Tedarikçi sipariş numarasını yazmadan asla PDF gönderemeyiz» (27.09.2026) — gilt weiter.
        if (!isRequest && !String(document.quoteNumber ?? '').trim()) return { ...base, problem: 'QUOTE_NUMBER_REQUIRED' };

        /* An wen: ausdrücklich · der Ansprechpartner aus dem Angebot (Bestellung) · die Adresse des Belegs ·
           die Adresse, die man anderswo kennt (Karten der Zeilen, Lieferantenliste — 30.09.2026). */
        const explicit = cleanEmail(options.to);
        const stored = cleanEmail(document.supplierEmail);
        let to = [explicit, isRequest ? null : cleanEmail(meta?.supplierContact?.email), stored]
            .find((email): email is string => Boolean(email)) ?? null;
        if (!to) to = await this.knownEmailOf(tenantId, link, document);
        if (!to) return { ...base, problem: 'NO_EMAIL' };
        // Eine eingetippte oder anderswo gefundene Adresse bleibt am Beleg — und eine eingetippte
        // wird die des Lieferanten («direkt tedarikçi e-postası olarak kaydetmeli», 30.09.2026).
        if (explicit || (!stored && to !== cleanEmail(meta?.supplierContact?.email))) {
            await deps.automation.setSupplierEmail(tenantId, purchaseOrderId, to).catch(() => undefined);
        }
        if (explicit) {
            await deps.emails.remember(tenantId, [{ supplierId: document.supplierId ?? null, name: document.supplierName ?? null, email: explicit }])
                .catch(() => 0);
        }

        const box = await this.mailboxFor(tenantId, isRequest ? 'RFQ' : 'ORDER');
        if (!box) return { ...base, to: [to], problem: 'NO_MAILBOX' };

        const request = await this.requestOf(tenantId, link);
        const settings = await deps.companySettings(tenantId);
        const companyName = String(settings.companyName ?? '').trim();
        const fileName = `${localizePurchaseCode(base.code, lang)}.pdf`;

        let pdf: Buffer;
        try {
            pdf = await deps.renderPdf(isRequest ? 'REQUEST' : 'ORDER', document, settings, lang);
        } catch (error) {
            const message = (error as Error)?.message || 'PDF';
            console.warn('[satın alma] PDF nicht erzeugt:', base.code, message);
            await deps.mails.record(tenantId, {
                purchaseOrderId, requestId: request?.id ?? null, kind, status: 'FAILED', trigger: options.trigger, mailboxId: box.id,
                fromEmail: box.fromEmail, toEmails: [to], subject: null, messageId: null, lang, revision: revisionNumber,
                fileRef: null, fileName, fileSize: null, error: `PDF: ${message}`, sentById: actor?.id ?? null, sentByName: actor?.name ?? null,
            }).catch(() => undefined);
            return { ...base, to: [to], status: 'FAILED', problem: 'PDF_FAILED', error: message };
        }
        // Was hinausging, bleibt nachzulesen (R2 — «tüm dosyalar Cloudflare'e»).
        const fileRef = await deps.documents.store(tenantId, pdf, 'application/pdf').catch(() => null);

        const facts: ProcurementMailFacts = {
            type: kind,
            lang,
            code: base.code,
            projectNumber: document.project?.number ?? document.bomOrigin?.projectNumber ?? null,
            projectName: document.project?.name ?? document.bomOrigin?.projectName ?? null,
            quoteNumber: document.quoteNumber ?? null,
            recipientName: String(document.recipientName ?? '').trim() || null,
            orderedByName: document.orderedByName ?? null,
            currency: String(document.currency || 'CHF'),
            total: (Number(document.totalNet) || 0) + (Number(document.totalFees) || 0) + (Number(document.totalVat) || 0),
            revision: revisionNumber,
            firstSentAt: null,
            lines: linesOf(document),
            senderName: box.fromName || companyName,
            senderEmail: box.fromEmail,
            companyName,
            attachment: { name: fileName, bytes: pdf.length },
        };
        if (kind === 'REVISION') {
            const earlier = (await deps.mails.forOrders(tenantId, [purchaseOrderId])).get(purchaseOrderId) ?? [];
            const first = earlier.filter((row) => row.status === 'SENT').pop();
            facts.firstSentAt = first?.createdAt ?? (document.emailSentAt ? new Date(document.emailSentAt) : null);
        }
        const mail = buildProcurementMail(facts);
        const subject = procurementMailSubject(facts);
        const messageId = newMessageId(box.fromEmail);

        let sent: DispatchStatus = 'FAILED';
        let error: string | null = null;
        try {
            const result = await deps.sendMail(mailSettingsOf(box), {
                fromEmail: box.fromEmail,
                fromName: box.fromName || companyName || 'Offitec Control Center',
                to,
                subject,
                text: mail.text,
                html: mail.html,
                replyTo: null,
                attachments: [{ filename: fileName, contentType: 'application/pdf', contentBase64: pdf.toString('base64') }],
                inlineImages: mail.inlineImages,
                messageId,
            });
            sent = result.preview ? 'PREVIEW' : 'SENT';
        } catch (failure) {
            error = (failure as Error)?.message || 'SMTP';
            console.warn('[satın alma] Mail nicht gesendet:', base.code, error);
        }

        const record = await deps.mails.record(tenantId, {
            purchaseOrderId,
            requestId: request?.id ?? null,
            kind,
            status: sent === 'SENT' || sent === 'PREVIEW' ? sent : 'FAILED',
            trigger: options.trigger,
            mailboxId: box.id,
            fromEmail: box.fromEmail,
            toEmails: [to],
            subject,
            messageId,
            lang,
            revision: revisionNumber,
            fileRef,
            fileName,
            fileSize: pdf.length,
            error,
            sentById: actor?.id ?? null,
            sentByName: actor?.name ?? null,
        });

        if (sent === 'SENT') {
            const statusAfter = isRequest
                ? (status === 'DRAFT' ? 'PRICE_REQUEST' : null)
                : CONFIRMED_ORDER_STATUSES.has(status) && kind !== 'REVISION' ? null : 'ORDERED';
            await deps.automation.markSent(tenantId, purchaseOrderId, { to, statusAfter, userId: actor?.id ?? null });
        }
        if (request) {
            const action: ProcurementEventAction = sent !== 'SENT'
                ? 'SEND_FAILED'
                : kind === 'RFQ' ? 'PRICE_REQUESTS_SENT' : kind === 'REVISION' ? 'REVISION_SENT' : 'ORDER_SENT';
            await deps.journal.record(tenantId, {
                requestId: request.id,
                requestNumber: request.requestNumber,
                action,
                actorId: actor?.id ?? null,
                actorName: actor?.name ?? null,
                data: {
                    code: base.code,
                    codes: [base.code],
                    supplier: base.supplierName,
                    suppliers: [base.supplierName],
                    to,
                    revision: revisionNumber,
                    automatic: options.trigger === 'AUTO' || options.trigger === 'REVISION',
                    ...(sent !== 'SENT' ? { error: error ?? sent } : {}),
                },
            }).catch(() => undefined);
        }
        return {
            ...base,
            to: [to],
            status: sent,
            problem: sent === 'FAILED' ? 'MAIL_FAILED' : null,
            error,
            fileName,
            fileSize: pdf.length,
            mailId: record.id,
            sentAt: sent === 'SENT' ? record.createdAt.toISOString() : null,
        };
    }

    /* ── Die Preisanfragen eines Talep: anlegen und senden ────────────── */

    /**
     * «BOM'da ürünler seçilip fiyat talebi yapılır … fiyat talepleri artık
     * otomatik gönderiliyor»: je Lieferant, den die Karten der Zeilen nennen,
     * EINE Preisanfrage mit SEINEN Zeilen (A: X,Y · B: X,Y,Z,T → X fragt A+B …),
     * Empfänger = die E-Mail des Lieferanten auf der Karte. Danach geht jede
     * noch nicht gesendete Anfrage des Talep hinaus. Lieferanten, die schon
     * gefragt sind, fragt die Automatik kein zweites Mal.
     */
    async dispatchRequest(tenantId: string, actor: BomActor | null, requestId: string): Promise<DispatchResultDto[]> {
        const waiting = await this.prepareRequest(tenantId, actor, requestId);
        const results: DispatchResultDto[] = [];
        for (const entry of waiting) {
            try {
                results.push(await this.sendDocument(tenantId, actor, entry.purchaseOrderId, { trigger: 'AUTO' }));
            } catch (error) {
                console.warn('[satın alma] Preisanfrage nicht gesendet:', entry.purchaseOrderId, (error as Error)?.message);
            }
        }
        return results;
    }

    /**
     * Legt an, was die Karten an Lieferanten nennen und noch nicht gefragt
     * sind, und nennt jede Preisanfrage des Talep, die noch nicht hinausging
     * (Nummer, Lieferant, Adresse) — die Seite sendet sie dann eine nach der
     * anderen und zeigt jeden Schritt.
     */
    async prepareRequest(tenantId: string, actor: BomActor | null, requestId: string): Promise<Array<{
        purchaseOrderId: string;
        code: string;
        supplierName: string;
        email: string | null;
        lineCount: number;
    }>> {
        const { deps } = this;
        const request = await deps.requests.get(tenantId, requestId);
        if (!request || request.kind !== 'PRICE' || request.status === 'CANCELLED') return [];
        const bom = await deps.devices.requireBom(tenantId, request.bomId);
        const products = await deps.stock.products(tenantId, request.lines.map((line) => line.productId));
        const mine = (await deps.devices.purchasesOf(tenantId, [bom.id]))
            .filter(({ link, order }) => link.kind === 'REQUEST' && request.purchaseOrderIds.includes(order.id));
        const asked = new Set(mine.map(({ order }) => supplierKey(order.supplierId, order.supplierName)));

        const lines = request.lines.map((line) => {
            const suppliers = (products.get(line.productId)?.suppliers ?? [])
                .filter((supplier) => !asked.has(supplierKey(supplier.supplierId, supplier.name)))
                .slice(0, BOM_LIMITS.requestSuppliers);
            return { lineId: line.bomLineId, quantity: line.quantity, suppliers: suppliers.map((supplier) => ({ supplierId: supplier.supplierId, supplierName: supplier.name })) };
        }).filter((line) => line.suppliers.length > 0);

        const fresh: string[] = [];
        if (lines.length) {
            const result = await deps.devices.createRequests(tenantId, systemActorOf(actor), bom.id, { procurementRequestId: request.id, lines });
            fresh.push(...result.created.map((entry) => entry.purchaseOrderId));
            // Die Adresse aus der Karte (je Lieferant die erste, die eine Karte der Zeilen nennt).
            const orders = await deps.purchases.orders(tenantId, fresh);
            for (const order of orders) {
                const email = cardEmailOf(order, request.lines.map((line) => line.productId), products);
                if (!email) continue;
                await deps.automation.setSupplierEmail(tenantId, order.id, email).catch(() => undefined);
                // Ein Lieferant, den die Karte nur beim Namen kannte, steht jetzt in der Liste — mit seiner Adresse.
                await deps.emails.remember(tenantId, [{ supplierId: order.supplierId, name: order.supplierName, email }]).catch(() => 0);
            }
        }
        const waiting = [...new Set([
            ...fresh,
            ...mine.filter(({ order }) => String(order.status).toUpperCase() === 'DRAFT' && !order.emailSentAt).map(({ order }) => order.id),
        ])];
        if (!waiting.length) return [];
        const [orders, raw] = await Promise.all([
            deps.purchases.orders(tenantId, waiting),
            Promise.all(waiting.map((id) => deps.automation.order(tenantId, id))),
        ]);
        const emails = new Map(raw.flatMap((row) => (row ? [[row.id, cleanEmail(row.supplierEmail)] as const] : [])));
        return waiting.flatMap((id) => {
            const order = orders.find((entry) => entry.id === id);
            return order
                ? [{ purchaseOrderId: id, code: order.referenceNumber, supplierName: order.supplierName, email: emails.get(id) ?? null, lineCount: order.items.length }]
                : [];
        });
    }

    /**
     * Die Adresse, die man anderswo kennt, wenn der Beleg keine trägt
     * (30.09.2026): die Karten der Zeilen des Talep (Preisanfrage), dann die
     * Lieferantenliste — z. B. ein von Hand hinzugefügter Lieferant («Ekle»).
     */
    private async knownEmailOf(tenantId: string, link: BomPurchaseLink, document: Record<string, any>): Promise<string | null> {
        const supplier = { supplierId: document.supplierId ?? null, supplierName: String(document.supplierName ?? '') };
        if (link.kind === 'REQUEST') {
            const request = await this.requestOf(tenantId, link).catch(() => null);
            if (request) {
                const products = await this.deps.stock.products(tenantId, request.lines.map((line) => line.productId)).catch(() => null);
                const card = products ? cardEmailOf(supplier, request.lines.map((line) => line.productId), products) : null;
                if (card) return card;
            }
        }
        return this.deps.emails.emailOf(tenantId, { supplierId: supplier.supplierId, name: supplier.supplierName }).catch(() => null);
    }

    /** Nach der Freigabe einer Revision: jede Bestellung, die beim Lieferanten war, geht geändert hinaus. */
    async dispatchRevision(tenantId: string, actor: BomActor | null, purchaseOrderIds: string[]): Promise<DispatchResultDto[]> {
        const results: DispatchResultDto[] = [];
        for (const purchaseOrderId of purchaseOrderIds) {
            try {
                results.push(await this.sendDocument(tenantId, actor, purchaseOrderId, { trigger: 'REVISION' }));
            } catch (error) {
                console.warn('[satın alma] Revision nicht gesendet:', purchaseOrderId, (error as Error)?.message);
            }
        }
        return results;
    }

    /* ── Der Stand der Sendungen (für die Seiten) ──────────────────────── */

    async status(tenantId: string, purchaseOrderIds: string[]): Promise<Record<string, {
        mails: Array<{ id: string; kind: string; status: string; trigger: string | null; to: string[]; at: string; error: string | null; fileName: string | null; hasFile: boolean; byName: string | null; lang: string | null }>;
        replies: Array<{ id: string; status: string; at: string; fromEmail: string | null; fromName: string | null; subject: string | null; fileName: string | null; hasFile: boolean; kind: string | null }>;
    }>> {
        const [mails, replies] = await Promise.all([
            this.deps.mails.forOrders(tenantId, purchaseOrderIds),
            this.deps.mails.repliesFor(tenantId, purchaseOrderIds),
        ]);
        const result: Awaited<ReturnType<ProcurementDispatchUseCase['status']>> = {};
        for (const id of purchaseOrderIds) {
            result[id] = {
                mails: (mails.get(id) ?? []).slice(0, 20).map((row) => ({
                    id: row.id,
                    kind: row.kind,
                    status: row.status,
                    trigger: row.trigger,
                    to: row.toEmails,
                    at: row.createdAt.toISOString(),
                    error: row.error,
                    fileName: row.fileName,
                    hasFile: Boolean(row.fileRef),
                    byName: row.sentByName,
                    lang: row.lang,
                })),
                replies: (replies.get(id) ?? []).slice(0, 20).map((row) => ({
                    id: row.id,
                    status: row.status,
                    at: (row.receivedAt ?? row.createdAt).toISOString(),
                    fromEmail: row.fromEmail,
                    fromName: row.fromName,
                    subject: row.subject,
                    fileName: row.fileName,
                    hasFile: Boolean(row.fileRef),
                    kind: row.kind,
                })),
            };
        }
        return result;
    }

    /** Das verschickte PDF bzw. die Datei einer Antwort. */
    async file(tenantId: string, source: 'mail' | 'reply', id: string): Promise<{ body: Buffer; fileName: string; contentType: string }> {
        const row = source === 'mail' ? await this.deps.mails.get(tenantId, id) : await this.deps.mails.getReply(tenantId, id);
        const ref = row?.fileRef ?? null;
        if (!row || !ref) throw bomError('FILE_REQUIRED', 'Die Datei gibt es nicht.', { status: 404 });
        return {
            body: await this.deps.documents.read(ref),
            fileName: row.fileName || 'document.pdf',
            contentType: 'fileType' in row && row.fileType ? String(row.fileType) : 'application/pdf',
        };
    }

    /**
     * Das PDF des Belegs, wie es JETZT hinausginge (30.09.2026, Samet: «gönderilen PDF
     * yerine sipariş PDF'i olsun») — derselbe Code und dieselbe Sprache wie beim
     * Senden, nichts wird gesendet oder gespeichert.
     */
    async documentPdf(tenantId: string, purchaseOrderId: string, uiLang: SupplierPdfLang | null = null): Promise<{ body: Buffer; fileName: string; contentType: string }> {
        const { deps } = this;
        const link = await deps.purchases.linkForOrder(tenantId, purchaseOrderId);
        const document = link ? await deps.loadDocument(tenantId, purchaseOrderId) : null;
        if (!link || !document) throw bomError('PURCHASE_NOT_FOUND', 'Dieser Beleg stammt aus keiner BOM.', { status: 404 });
        const meta = (await deps.automation.linkMeta(tenantId, [purchaseOrderId])).get(purchaseOrderId) ?? null;
        const lang: SupplierPdfLang = uiLang ?? meta?.documentLanguage ?? 'de';
        const settings = await deps.companySettings(tenantId);
        let body: Buffer;
        try {
            body = await deps.renderPdf(link.kind === 'REQUEST' ? 'REQUEST' : 'ORDER', document, settings, lang);
        } catch (error) {
            throw bomError('PDF_RENDER_FAILED', (error as Error)?.message || 'PDF', { status: 500 });
        }
        return { body, fileName: `${localizePurchaseCode(String(document.referenceNumber ?? ''), lang)}.pdf`, contentType: 'application/pdf' };
    }

    /** Der Talep, an dem ein Beleg hängt. */
    async requestOf(tenantId: string, link: Pick<BomPurchaseLink, 'bomId' | 'purchaseOrderId'>): Promise<BomProcurementRequest | null> {
        const requests = await this.deps.requests.list(tenantId, { bomIds: [link.bomId] }).catch(() => []);
        return requests.find((entry) => entry.purchaseOrderIds.includes(link.purchaseOrderId)) ?? null;
    }
}
