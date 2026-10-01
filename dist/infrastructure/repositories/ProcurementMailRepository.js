"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaProcurementMailRepository = void 0;
const nanoid_1 = require("nanoid");
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const listOf = (raw) => {
    try {
        const parsed = JSON.parse(String(raw ?? '[]'));
        return Array.isArray(parsed) ? parsed.map(String) : [];
    }
    catch {
        return [];
    }
};
const mailOf = (row) => ({
    ...row,
    toEmails: listOf(row.toEmails),
});
const replyOf = (row) => ({
    ...row,
    facts: row.facts && typeof row.facts === 'object' && !Array.isArray(row.facts) ? row.facts : null,
});
class PrismaProcurementMailRepository {
    async record(tenantId, entry) {
        const row = await prisma_client_1.default.procurementMail.create({
            data: {
                id: (0, nanoid_1.nanoid)(20),
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
        return mailOf(row);
    }
    /** Alle Sendungen der Belege, neueste zuerst. */
    async forOrders(tenantId, purchaseOrderIds) {
        const ids = [...new Set(purchaseOrderIds.filter(Boolean))];
        const map = new Map();
        if (!ids.length)
            return map;
        const rows = await prisma_client_1.default.procurementMail.findMany({
            where: { tenantId, purchaseOrderId: { in: ids } },
            orderBy: { createdAt: 'desc' },
            take: 2000,
        }).catch(() => []);
        for (const raw of rows) {
            const row = mailOf(raw);
            map.set(row.purchaseOrderId, [...(map.get(row.purchaseOrderId) ?? []), row]);
        }
        return map;
    }
    async get(tenantId, id) {
        const row = await prisma_client_1.default.procurementMail.findFirst({ where: { id, tenantId } });
        return row ? mailOf(row) : null;
    }
    /** Die Sendungen mit diesen Message-IDs (In-Reply-To / References einer Antwort). */
    async byMessageIds(tenantId, messageIds) {
        const ids = [...new Set(messageIds.map((id) => id.trim()).filter(Boolean))].slice(0, 40);
        if (!ids.length)
            return [];
        const rows = await prisma_client_1.default.procurementMail.findMany({
            where: { tenantId, messageId: { in: ids }, status: 'SENT' },
            orderBy: { createdAt: 'desc' },
        });
        return rows.map((row) => mailOf(row));
    }
    /** Die letzte echte Sendung an einen Beleg (für den Abgleich über die Nummer im Betreff). */
    async latestSentFor(tenantId, purchaseOrderIds) {
        if (!purchaseOrderIds.length)
            return null;
        const row = await prisma_client_1.default.procurementMail.findFirst({
            where: { tenantId, purchaseOrderId: { in: purchaseOrderIds }, status: 'SENT' },
            orderBy: { createdAt: 'desc' },
        });
        return row ? mailOf(row) : null;
    }
    /* ── Antworten ─────────────────────────────────────────────────────── */
    async replyKnown(tenantId, mailboxId, providerKey) {
        const row = await prisma_client_1.default.procurementReply.findUnique({
            where: { tenantId_mailboxId_providerKey: { tenantId, mailboxId, providerKey } },
            select: { id: true },
        }).catch(() => null);
        return Boolean(row);
    }
    /** Eine gelesene Antwort festhalten — zweimal dieselbe Nachricht = `null` (schon da). */
    async recordReply(tenantId, entry) {
        try {
            const row = await prisma_client_1.default.procurementReply.create({
                data: {
                    id: (0, nanoid_1.nanoid)(20),
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
                    facts: (entry.facts ?? client_1.Prisma.JsonNull),
                    error: entry.error ? entry.error.slice(0, 4000) : null,
                },
            });
            return replyOf(row);
        }
        catch (error) {
            if (error?.code === 'P2002')
                return null;
            throw error;
        }
    }
    async updateReply(id, patch) {
        await prisma_client_1.default.procurementReply.update({
            where: { id },
            data: {
                ...(patch.status ? { status: patch.status } : {}),
                ...(patch.purchaseOrderId !== undefined ? { purchaseOrderId: patch.purchaseOrderId } : {}),
                ...(patch.error !== undefined ? { error: patch.error ? patch.error.slice(0, 4000) : null } : {}),
                ...(patch.facts !== undefined ? { facts: (patch.facts ?? client_1.Prisma.JsonNull) } : {}),
            },
        }).catch(() => undefined);
    }
    /** Die Antworten der Belege, neueste zuerst. */
    async repliesFor(tenantId, purchaseOrderIds) {
        const ids = [...new Set(purchaseOrderIds.filter(Boolean))];
        const map = new Map();
        if (!ids.length)
            return map;
        const rows = await prisma_client_1.default.procurementReply.findMany({
            where: { tenantId, purchaseOrderId: { in: ids } },
            orderBy: { createdAt: 'desc' },
            take: 2000,
        }).catch(() => []);
        for (const raw of rows) {
            const row = replyOf(raw);
            if (!row.purchaseOrderId)
                continue;
            map.set(row.purchaseOrderId, [...(map.get(row.purchaseOrderId) ?? []), row]);
        }
        return map;
    }
    async getReply(tenantId, id) {
        const row = await prisma_client_1.default.procurementReply.findFirst({ where: { id, tenantId } });
        return row ? replyOf(row) : null;
    }
}
exports.PrismaProcurementMailRepository = PrismaProcurementMailRepository;
//# sourceMappingURL=ProcurementMailRepository.js.map