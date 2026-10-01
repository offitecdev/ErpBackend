import prisma from '../database/prisma.client';
import { invalidateEverywhere } from '../cache/cacheStore';
import { buildImapClient } from './ImapCaptureService';
import { mailSettingsOf, type PrismaProductionMailboxRepository, type ProductionMailboxRow } from '../repositories/ProductionMailboxRepository';
import type { PrismaProcurementMailRepository, ProcurementMailRow } from '../repositories/ProcurementMailRepository';
import { canonicalPurchaseCode } from '../../shared/purchaseDocumentCode';

/**
 * ── DIE ANTWORTEN DER LIEFERANTEN LESEN (30.09.2026, Vorgabe Samet) ────────
 *
 * «O mailin altına gelen mailden pdf alınıyor ve direkt tedarikçinin
 *  teklifine işleniyor.» Das RFQ-Postfach (und ein eigenes der Bestellungen)
 * wird alle paar Minuten gelesen — NUR lesend, nichts wird am Server markiert,
 * verschoben oder gelöscht:
 *   · eine Nachricht, deren In-Reply-To / References eine Message-ID nennt,
 *     die WIR verschickt haben (uretim_satinalma_postalari), gehört zu diesem
 *     Beleg; sonst hilft die Nummer im Betreff (PA-/FT-/PR-/BE-/SP-/PO-…);
 *   · ihr (erstes) PDF geht an den Beleg — bei einer Preisanfrage wird es das
 *     Angebot des Lieferanten (Vergleich!), bei einer Bestellung die
 *     Bestätigung;
 *   · jede Nachricht wird genau einmal verarbeitet (Postfach + UID, eindeutig
 *     in uretim_satinalma_yanitlari) — auch wenn zwei Server gleichzeitig lesen.
 * Alles andere im Postfach bleibt unberührt und wird nicht gespeichert.
 */

const TICK_MS = 2 * 60_000;
/** Beim ersten Lauf (oder neuem UIDVALIDITY) so weit zurück. */
const FIRST_RUN_DAYS = 10;
const MAX_PER_RUN = 150;
const PDF_MAX_BYTES = 12 * 1024 * 1024;

export interface IncomingReply {
    mailbox: ProductionMailboxRow;
    mail: ProcurementMailRow;
    providerKey: string;
    internetMessageId: string | null;
    from: { address: string | null; name: string | null };
    subject: string;
    receivedAt: Date;
    /** Das PDF der Antwort — null: die Antwort trägt keines. */
    pdf: { body: Buffer; name: string } | null;
}

/** Was mit einer zugeordneten Antwort geschieht (ProcurementReplyUseCase). */
export type ReplyHandler = (reply: IncomingReply) => Promise<void>;

export interface InboxRunSummary {
    mailboxId: string;
    examined: number;
    matched: number;
    attached: number;
    error: string | null;
}

const messageIds = (value: unknown): string[] => (String(value ?? '').match(/<[^>\s]+>/g) || []).map((id) => id.trim());

const headerOf = (headers: string, name: string): string => {
    const pattern = new RegExp(`^${name}:[ \\t]*([\\s\\S]*?)(?=\\r?\\n[^ \\t]|$)`, 'im');
    const match = pattern.exec(headers);
    return match ? match[1]!.replace(/\r?\n[ \t]+/g, ' ').trim() : '';
};

const CODE_IN_TEXT = /\b(PA|FT|PR|BE|SP|PO)-(\d{4})-(\d{3,6})\b/gi;

/** Die PDF-Teile einer Nachricht (aus der BODYSTRUCTURE, ohne Inhalte). */
const pdfPartsOf = (node: any, out: Array<{ part: string; name: string; size: number }> = []) => {
    if (!node) return out;
    for (const child of node.childNodes || node.children || []) pdfPartsOf(child, out);
    const type = String(node.type || '').toLowerCase();
    const name = String(node.dispositionParameters?.filename || node.parameters?.name || '');
    const isPdf = type === 'application/pdf' || (/\.pdf$/i.test(name) && (type === 'application/octet-stream' || !type));
    if (isPdf && node.part) {
        const encoded = Number(node.size) || 0;
        const size = String(node.encoding || '').toLowerCase() === 'base64' ? Math.floor(encoded * 3 / 4) : encoded;
        out.push({ part: String(node.part), name: name || 'angebot.pdf', size });
    }
    return out;
};

export class ProcurementInbox {
    private running = new Set<string>();

    constructor(
        private mailboxes: PrismaProductionMailboxRepository,
        private mails: PrismaProcurementMailRepository,
        private handle: ReplyHandler,
    ) {}

    /** Die Sendung, auf die eine Nachricht antwortet — Message-ID zuerst, dann die Nummer im Betreff. */
    private async sentMailOf(tenantId: string, headers: string, subject: string): Promise<ProcurementMailRow | null> {
        const ids = [...messageIds(headerOf(headers, 'In-Reply-To')), ...messageIds(headerOf(headers, 'References'))];
        const byId = ids.length ? await this.mails.byMessageIds(tenantId, ids) : [];
        if (byId.length) return byId[0]!;
        const codes = [...new Set([...subject.matchAll(CODE_IN_TEXT)].map((match) => canonicalPurchaseCode(match[0].toUpperCase())))];
        if (!codes.length) return null;
        const orders = await prisma.purchaseOrder.findMany({
            where: { tenantId, referenceNumber: { in: codes } },
            select: { id: true },
            take: 5,
        });
        return this.mails.latestSentFor(tenantId, orders.map((order) => order.id));
    }

    /** Ein Durchgang für EIN Postfach. Wirft nicht — der Fehler steht am Postfach. */
    async run(mailbox: ProductionMailboxRow): Promise<InboxRunSummary> {
        const summary: InboxRunSummary = { mailboxId: mailbox.id, examined: 0, matched: 0, attached: 0, error: null };
        if (this.running.has(mailbox.id) || !mailbox.imapHost) return summary;
        this.running.add(mailbox.id);
        const settings = mailSettingsOf(mailbox);
        const client = buildImapClient(settings as never);
        const folder = mailbox.imapFolder?.trim() || 'INBOX';
        let lastUid = mailbox.imapLastUid ? Number(mailbox.imapLastUid) : 0;
        let uidValidity: bigint | null = mailbox.imapUidValidity ?? null;
        try {
            await client.connect();
            const lock = await client.getMailboxLock(folder, { readOnly: true });
            try {
                const box = client.mailbox as { uidValidity?: bigint | number; uidNext?: number } | false;
                const currentValidity = box && box.uidValidity !== undefined ? BigInt(box.uidValidity) : null;
                if (currentValidity !== null && uidValidity !== null && currentValidity !== uidValidity) lastUid = 0;
                uidValidity = currentValidity;
                const range = lastUid > 0
                    ? `${lastUid + 1}:*`
                    : await client.search({ since: new Date(Date.now() - FIRST_RUN_DAYS * 86_400_000) }, { uid: true })
                        .then((uids) => (Array.isArray(uids) && uids.length ? uids.join(',') : null))
                        .catch(() => null);
                if (range) {
                    const candidates: Array<{ uid: number; envelope: any; bodyStructure: any; headers: string; internalDate: Date }> = [];
                    for await (const message of client.fetch(range, {
                        uid: true,
                        envelope: true,
                        bodyStructure: true,
                        internalDate: true,
                        headers: ['in-reply-to', 'references', 'message-id', 'subject'],
                    }, { uid: true })) {
                        if (!message.uid || message.uid <= lastUid) continue;
                        candidates.push({
                            uid: message.uid,
                            envelope: message.envelope,
                            bodyStructure: message.bodyStructure,
                            headers: message.headers ? message.headers.toString('utf8') : '',
                            internalDate: message.internalDate instanceof Date ? message.internalDate : new Date(),
                        });
                        if (candidates.length >= MAX_PER_RUN) break;
                    }
                    candidates.sort((a, b) => a.uid - b.uid);
                    for (const candidate of candidates) {
                        summary.examined += 1;
                        const providerKey = `${folder}:${uidValidity ?? 0}:${candidate.uid}`;
                        const subject = String(candidate.envelope?.subject ?? headerOf(candidate.headers, 'Subject') ?? '');
                        const mail = await this.sentMailOf(mailbox.tenantId, candidate.headers, subject);
                        lastUid = Math.max(lastUid, candidate.uid);
                        if (!mail) continue;
                        if (await this.mails.replyKnown(mailbox.tenantId, mailbox.id, providerKey)) continue;
                        summary.matched += 1;
                        const pdfs = pdfPartsOf(candidate.bodyStructure).filter((part) => part.size <= PDF_MAX_BYTES);
                        let pdf: IncomingReply['pdf'] = null;
                        const first = pdfs.sort((a, b) => b.size - a.size)[0];
                        if (first) {
                            const download = await client.download(String(candidate.uid), first.part, { uid: true, maxBytes: PDF_MAX_BYTES });
                            const chunks: Buffer[] = [];
                            for await (const chunk of download.content) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                            const body = Buffer.concat(chunks);
                            if (body.length && body.subarray(0, 5).toString('latin1').startsWith('%PDF')) pdf = { body, name: first.name };
                        }
                        const fromEntry = Array.isArray(candidate.envelope?.from) ? candidate.envelope.from[0] : null;
                        try {
                            await this.handle({
                                mailbox,
                                mail,
                                providerKey,
                                internetMessageId: messageIds(headerOf(candidate.headers, 'Message-ID'))[0] ?? null,
                                from: { address: fromEntry?.address ? String(fromEntry.address).toLowerCase() : null, name: fromEntry?.name ? String(fromEntry.name) : null },
                                subject,
                                receivedAt: candidate.internalDate,
                                pdf,
                            });
                            if (pdf) summary.attached += 1;
                        } catch (error) {
                            console.warn('[satın alma] Antwort nicht verarbeitet:', providerKey, (error as Error)?.message);
                        }
                    }
                } else if (box && typeof box.uidNext === 'number' && box.uidNext > 1) {
                    // Nichts in der Frist — ab jetzt zählt, was neu kommt.
                    lastUid = Math.max(lastUid, box.uidNext - 1);
                }
            } finally {
                lock.release();
            }
        } catch (error) {
            summary.error = (error as Error)?.message || 'IMAP';
        } finally {
            await client.logout().catch(() => undefined);
            this.running.delete(mailbox.id);
            await this.mailboxes.setCursor(mailbox.id, {
                imapUidValidity: uidValidity,
                imapLastUid: lastUid > 0 ? BigInt(lastUid) : null,
                imapLastSyncAt: new Date(),
                imapLastError: summary.error,
                imapLastSummary: `${summary.examined}/${summary.matched}/${summary.attached}`,
            });
            // Ohne Anfrage geschrieben (Antwort am Beleg): die Lesespeicher der Produktion gelten nicht mehr.
            if (summary.matched) void invalidateEverywhere(['production', 'warehouse', 'catalog']).catch(() => undefined);
        }
        return summary;
    }

    /** Alle Postfächer einer Firma — «Şimdi kontrol et». */
    async runTenant(tenantId: string): Promise<InboxRunSummary[]> {
        const boxes = (await this.mailboxes.list(tenantId)).filter((box) => box.isActive && box.imapHost);
        const results: InboxRunSummary[] = [];
        for (const box of boxes) results.push(await this.run(box));
        return results;
    }

    private started = false;

    start(): void {
        if (this.started || process.env.OFFITEC_DISABLE_MAIL_SYNC === 'true') return;
        this.started = true;
        const tick = async () => {
            const boxes = await this.mailboxes.forCapture().catch(() => []);
            for (const box of boxes) await this.run(box).catch(() => undefined);
        };
        setTimeout(() => void tick(), 40_000);
        setInterval(() => void tick(), TICK_MS);
    }
}
