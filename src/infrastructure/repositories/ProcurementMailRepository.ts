import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';

import prisma from '../database/prisma.client';

/**
 * ── WAS DIE PRODUKTION VERSCHICKT HAT UND WAS ZURÜCKKAM (30.09.2026) ───────
 *
 * Jede Sendung (Preisanfrage, Bestellung, Revision) steht mit IHRER Message-ID
 * in `uretim_satinalma_postalari` — daran erkennt der Abruf die Antwort des
 * Lieferanten («o mailin altına gelen mailden pdf alınıyor»). Jede gelesene
 * Antwort steht einmal in `uretim_satinalma_yanitlari` (Postfach + UID), so
 * wird keine zweimal verarbeitet.
 */

export type ProcurementMailKind = 'RFQ' | 'ORDER' | 'REVISION';
export type ProcurementMailStatus = 'SENT' | 'PREVIEW' | 'FAILED';
export type ProcurementMailTrigger = 'AUTO' | 'MANUAL' | 'RESEND' | 'REVISION';
export type ProcurementReplyStatus = 'ATTACHED' | 'NO_PDF' | 'UNMATCHED' | 'FAILED';

export interface ProcurementMailRow {
    id: string;
    tenantId: string;
    purchaseOrderId: string;
    requestId: string | null;
    kind: ProcurementMailKind;
    status: ProcurementMailStatus;
    trigger: ProcurementMailTrigger | null;
    mailboxId: string | null;
    fromEmail: string | null;
    toEmails: string[];
    subject: string | null;
    messageId: string | null;
    lang: string | null;
    revision: number;
    fileRef: string | null;
    fileName: string | null;
    fileSize: number | null;
    error: string | null;
    sentById: string | null;
    sentByName: string | null;
    createdAt: Date;
}

export interface ProcurementReplyRow {
    id: string;
    tenantId: string;
    mailboxId: string;
    providerKey: string;
    purchaseOrderId: string | null;
    mailId: string | null;
    kind: string | null;
    status: ProcurementReplyStatus;
    fromEmail: string | null;
    fromName: string | null;
    subject: string | null;
    receivedAt: Date | null;
    fileRef: string | null;
    fileName: string | null;
    fileType: string | null;
    fileSize: number | null;
    facts: Record<string, unknown> | null;
    error: string | null;
    createdAt: Date;
}

const listOf = (raw: unknown): string[] => {
    try {
        const parsed = JSON.parse(String(raw ?? '[]'));
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return [];
    }
};

const mailOf = (row: Record<string, unknown>): ProcurementMailRow => ({
    ...(row as unknown as ProcurementMailRow),
    toEmails: listOf(row.toEmails),
});

const replyOf = (row: Record<string, unknown>): ProcurementReplyRow => ({
    ...(row as unknown as ProcurementReplyRow),
    facts: row.facts && typeof row.facts === 'object' && !Array.isArray(row.facts) ? row.facts as Record<string, unknown> : null,
});

export class PrismaProcurementMailRepository {
    async record(tenantId: string, entry: Omit<ProcurementMailRow, 'id' | 'tenantId' | 'createdAt'>): Promise<ProcurementMailRow> {
        const row = await prisma.procurementMail.create({
            data: {
                id: nanoid(20),
                tenantId,
                purchaseOrderId: entry.purchaseOrderId,
                requestId: entry.requestId,
                kind: entry.kind,
                status: entry.status,
                trigger: entry.trigger,
                mailboxId: entry.mailboxId,
                fromEmail: entry.fromEmail?.slice(0, 255) ?? null,
                toEmails: JSON.stringify(entry.toEmails.slice(0, 20)),
                subject: entry.subject?.slice(0, 255) ?? null,
                messageId: entry.messageId?.slice(0, 255) ?? null,
                lang: entry.lang,
                revision: entry.revision,
                fileRef: entry.fileRef,
                fileName: entry.fileName?.slice(0, 255) ?? null,
                fileSize: entry.fileSize,
                error: entry.error ? entry.error.slice(0, 4000) : null,
                sentById: entry.sentById,
                sentByName: entry.sentByName?.slice(0, 191) ?? null,
            },
        });
        return mailOf(row as unknown as Record<string, unknown>);
    }

    /** Alle Sendungen der Belege, neueste zuerst. */
    async forOrders(tenantId: string, purchaseOrderIds: string[]): Promise<Map<string, ProcurementMailRow[]>> {
        const ids = [...new Set(purchaseOrderIds.filter(Boolean))];
        const map = new Map<string, ProcurementMailRow[]>();
        if (!ids.length) return map;
        const rows = await prisma.procurementMail.findMany({
            where: { tenantId, purchaseOrderId: { in: ids } },
            orderBy: { createdAt: 'desc' },
            take: 2000,
        }).catch(() => []);
        for (const raw of rows) {
            const row = mailOf(raw as unknown as Record<string, unknown>);
            map.set(row.purchaseOrderId, [...(map.get(row.purchaseOrderId) ?? []), row]);
        }
        return map;
    }

    async get(tenantId: string, id: string): Promise<ProcurementMailRow | null> {
        const row = await prisma.procurementMail.findFirst({ where: { id, tenantId } });
        return row ? mailOf(row as unknown as Record<string, unknown>) : null;
    }

    /** Die Sendungen mit diesen Message-IDs (In-Reply-To / References einer Antwort). */
    async byMessageIds(tenantId: string, messageIds: string[]): Promise<ProcurementMailRow[]> {
        const ids = [...new Set(messageIds.map((id) => id.trim()).filter(Boolean))].slice(0, 40);
        if (!ids.length) return [];
        const rows = await prisma.procurementMail.findMany({
            where: { tenantId, messageId: { in: ids }, status: 'SENT' },
            orderBy: { createdAt: 'desc' },
        });
        return rows.map((row) => mailOf(row as unknown as Record<string, unknown>));
    }

    /** Die letzte echte Sendung an einen Beleg (für den Abgleich über die Nummer im Betreff). */
    async latestSentFor(tenantId: string, purchaseOrderIds: string[]): Promise<ProcurementMailRow | null> {
        if (!purchaseOrderIds.length) return null;
        const row = await prisma.procurementMail.findFirst({
            where: { tenantId, purchaseOrderId: { in: purchaseOrderIds }, status: 'SENT' },
            orderBy: { createdAt: 'desc' },
        });
        return row ? mailOf(row as unknown as Record<string, unknown>) : null;
    }

    /* ── Antworten ─────────────────────────────────────────────────────── */

    async replyKnown(tenantId: string, mailboxId: string, providerKey: string): Promise<boolean> {
        const row = await prisma.procurementReply.findUnique({
            where: { tenantId_mailboxId_providerKey: { tenantId, mailboxId, providerKey } },
            select: { id: true },
        }).catch(() => null);
        return Boolean(row);
    }

    /** Eine gelesene Antwort festhalten — zweimal dieselbe Nachricht = `null` (schon da). */
    async recordReply(tenantId: string, entry: Omit<ProcurementReplyRow, 'id' | 'tenantId' | 'createdAt'> & { internetMessageId?: string | null }): Promise<ProcurementReplyRow | null> {
        try {
            const row = await prisma.procurementReply.create({
                data: {
                    id: nanoid(20),
                    tenantId,
                    mailboxId: entry.mailboxId,
                    providerKey: entry.providerKey.slice(0, 191),
                    internetMessageId: entry.internetMessageId?.slice(0, 255) ?? null,
                    purchaseOrderId: entry.purchaseOrderId,
                    mailId: entry.mailId,
                    kind: entry.kind,
                    status: entry.status,
                    fromEmail: entry.fromEmail?.slice(0, 255) ?? null,
                    fromName: entry.fromName?.slice(0, 255) ?? null,
                    subject: entry.subject?.slice(0, 255) ?? null,
                    receivedAt: entry.receivedAt,
                    fileRef: entry.fileRef,
                    fileName: entry.fileName?.slice(0, 255) ?? null,
                    fileType: entry.fileType?.slice(0, 100) ?? null,
                    fileSize: entry.fileSize,
                    facts: (entry.facts ?? Prisma.JsonNull) as Prisma.InputJsonValue,
                    error: entry.error ? entry.error.slice(0, 4000) : null,
                },
            });
            return replyOf(row as unknown as Record<string, unknown>);
        } catch (error) {
            if ((error as { code?: string })?.code === 'P2002') return null;
            throw error;
        }
    }

    async updateReply(id: string, patch: Partial<Pick<ProcurementReplyRow, 'status' | 'facts' | 'error' | 'purchaseOrderId'>>): Promise<void> {
        await prisma.procurementReply.update({
            where: { id },
            data: {
                ...(patch.status ? { status: patch.status } : {}),
                ...(patch.purchaseOrderId !== undefined ? { purchaseOrderId: patch.purchaseOrderId } : {}),
                ...(patch.error !== undefined ? { error: patch.error ? patch.error.slice(0, 4000) : null } : {}),
                ...(patch.facts !== undefined ? { facts: (patch.facts ?? Prisma.JsonNull) as Prisma.InputJsonValue } : {}),
            },
        }).catch(() => undefined);
    }

    /** Die Antworten der Belege, neueste zuerst. */
    async repliesFor(tenantId: string, purchaseOrderIds: string[]): Promise<Map<string, ProcurementReplyRow[]>> {
        const ids = [...new Set(purchaseOrderIds.filter(Boolean))];
        const map = new Map<string, ProcurementReplyRow[]>();
        if (!ids.length) return map;
        const rows = await prisma.procurementReply.findMany({
            where: { tenantId, purchaseOrderId: { in: ids } },
            orderBy: { createdAt: 'desc' },
            take: 2000,
        }).catch(() => []);
        for (const raw of rows) {
            const row = replyOf(raw as unknown as Record<string, unknown>);
            if (!row.purchaseOrderId) continue;
            map.set(row.purchaseOrderId, [...(map.get(row.purchaseOrderId) ?? []), row]);
        }
        return map;
    }

    async getReply(tenantId: string, id: string): Promise<ProcurementReplyRow | null> {
        const row = await prisma.procurementReply.findFirst({ where: { id, tenantId } });
        return row ? replyOf(row as unknown as Record<string, unknown>) : null;
    }
}
