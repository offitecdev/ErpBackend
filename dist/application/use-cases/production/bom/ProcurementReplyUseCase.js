"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProcurementReplyUseCase = void 0;
/**
 * ── EINE ANTWORT DES LIEFERANTEN AN DEN BELEG (30.09.2026) ─────────────────
 *
 * «O mailin altına gelen mailden pdf alınıyor ve direkt tedarikçinin
 *  teklifine işleniyor … eğer pdf de varsa yapay zekâ onu da tedarikçi
 *  numarasına çekiyor.»
 *
 *   Preisanfrage  das PDF wird das Angebot des Lieferanten (die Zeile zeigt
 *                 es, der Vergleich liest es); die KI (gpt-5.4-mini) liest
 *                 Angebotsnummer, Ansprechpartner und Sprache — die spätere
 *                 Bestellung übernimmt sie («z. Hd.», Sprache von PDF und Mail)
 *   Bestellung    das PDF ist die Antwort auf die Bestellung (meist die
 *                 Auftragsbestätigung) — die Seite der Bestellung zeigt sie
 *                 neben «Tedarikçi onayladı»
 * Die Antwort wird ZUERST festgehalten (eindeutig je Postfach + UID); nur wer
 * sie so beansprucht hat, schreibt an den Beleg.
 */
class ProcurementReplyUseCase {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    handle = async (reply) => {
        const { deps } = this;
        const tenantId = reply.mailbox.tenantId;
        const purchaseOrderId = reply.mail.purchaseOrderId;
        const isRequest = reply.mail.kind === 'RFQ';
        const archived = reply.pdf ? await deps.documents.store(tenantId, reply.pdf.body, 'application/pdf').catch(() => null) : null;
        const row = await deps.mails.recordReply(tenantId, {
            mailboxId: reply.mailbox.id,
            providerKey: reply.providerKey,
            internetMessageId: reply.internetMessageId,
            purchaseOrderId,
            mailId: reply.mail.id,
            kind: isRequest ? 'RFQ' : 'ORDER',
            status: reply.pdf ? 'ATTACHED' : 'NO_PDF',
            fromEmail: reply.from.address,
            fromName: reply.from.name,
            subject: reply.subject,
            receivedAt: reply.receivedAt,
            fileRef: archived,
            fileName: reply.pdf?.name ?? null,
            fileType: reply.pdf ? 'application/pdf' : null,
            fileSize: reply.pdf?.body.length ?? null,
            facts: null,
            error: null,
        });
        if (!row) {
            // Schon verarbeitet (ein anderer Lauf war schneller).
            if (archived)
                await deps.documents.remove(archived).catch(() => undefined);
            return;
        }
        let facts = null;
        if (reply.pdf && isRequest) {
            const link = await deps.purchases.linkForOrder(tenantId, purchaseOrderId);
            if (link) {
                // Das Angebot des Lieferanten: eine eigene Ablage (die Antwort behält ihre).
                const ref = await deps.documents.store(tenantId, reply.pdf.body, 'application/pdf');
                await deps.purchases.setQuoteFile(tenantId, purchaseOrderId, {
                    ref,
                    name: reply.pdf.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'angebot.pdf',
                    type: 'application/pdf',
                    size: reply.pdf.body.length,
                }, reply.mail.sentById ?? 'system');
                if (link.quoteFileRef && link.quoteFileRef !== ref)
                    void deps.documents.remove(link.quoteFileRef).catch(() => undefined);
            }
            facts = await deps.readOffer(reply.pdf.body, reply.pdf.name).catch((error) => {
                console.warn('[satın alma] Angebot nicht gelesen:', error?.message);
                return null;
            });
            const order = await deps.automation.order(tenantId, purchaseOrderId);
            if (facts?.offerNumber && !String(order?.quoteNumber ?? '').trim()) {
                await deps.writer.setQuoteNumber(tenantId, purchaseOrderId, facts.offerNumber).catch(() => undefined);
            }
            const contact = {
                name: facts?.contactName || reply.from.name || null,
                email: facts?.contactEmail || reply.from.address || null,
            };
            await deps.automation.setLinkMeta(tenantId, purchaseOrderId, {
                ...(facts?.language ? { documentLanguage: facts.language } : {}),
                supplierContact: contact.name || contact.email ? contact : null,
            });
        }
        if (facts)
            await deps.mails.updateReply(row.id, { facts: { ...facts } });
        const link = await deps.purchases.linkForOrder(tenantId, purchaseOrderId);
        const request = link ? await deps.dispatch.requestOf(tenantId, link) : null;
        if (request) {
            const order = await deps.automation.order(tenantId, purchaseOrderId);
            await deps.journal.record(tenantId, {
                requestId: request.id,
                requestNumber: request.requestNumber,
                action: 'REPLY_RECEIVED',
                actorId: null,
                actorName: null,
                data: {
                    code: order?.referenceNumber ?? '',
                    supplier: order?.supplierName ?? '',
                    kind: isRequest ? 'RFQ' : 'ORDER',
                    file: reply.pdf?.name ?? null,
                    offerNumber: facts?.offerNumber ?? null,
                },
            }).catch(() => undefined);
        }
    };
}
exports.ProcurementReplyUseCase = ProcurementReplyUseCase;
//# sourceMappingURL=ProcurementReplyUseCase.js.map