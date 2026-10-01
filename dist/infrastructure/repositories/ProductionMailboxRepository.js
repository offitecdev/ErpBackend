"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mailSettingsOf = exports.PrismaProductionMailboxRepository = exports.MAILBOX_PURPOSES = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const mailCrypto_1 = require("../services/outlook/mailCrypto");
exports.MAILBOX_PURPOSES = ['RFQ', 'ORDER'];
const table = () => prisma_client_1.default.productionMailbox;
const purposeOf = (value) => (String(value).toUpperCase() === 'ORDER' ? 'ORDER' : 'RFQ');
const rowOf = (row) => ({
    ...row,
    purpose: purposeOf(row.purpose),
});
const secretFor = (next, current) => {
    if (next === undefined || next === '')
        return current;
    if (next === null)
        return null;
    return (0, mailCrypto_1.encryptSecret)(next);
};
class PrismaProductionMailboxRepository {
    async list(tenantId) {
        const rows = await table().findMany({ where: { tenantId } });
        return rows.map((row) => rowOf(row));
    }
    async get(tenantId, purpose) {
        const row = await table().findUnique({ where: { tenantId_purpose: { tenantId, purpose } } });
        return row ? rowOf(row) : null;
    }
    async byId(id) {
        const row = await table().findUnique({ where: { id } });
        return row ? rowOf(row) : null;
    }
    async save(tenantId, purpose, input, userId) {
        const current = await this.get(tenantId, purpose);
        const data = {
            isActive: input.isActive,
            fromName: input.fromName,
            fromEmail: input.fromEmail,
            smtpHost: input.smtpHost,
            smtpPort: input.smtpPort,
            smtpSecure: input.smtpSecure,
            smtpUser: input.smtpUser,
            smtpPassword: secretFor(input.smtpPassword, current?.smtpPassword ?? null),
            imapHost: input.imapHost,
            imapPort: input.imapPort,
            imapSecure: input.imapSecure,
            imapUser: input.imapUser,
            imapPassword: secretFor(input.imapPassword, current?.imapPassword ?? null),
            imapFolder: input.imapFolder,
            updatedById: userId,
        };
        // Ein anderes Konto (Adresse/Server) liest von vorn — der alte Lesestand gehört dem alten.
        const accountChanged = current
            && (current.fromEmail.toLowerCase() !== input.fromEmail.toLowerCase() || (current.imapHost ?? '') !== (input.imapHost ?? ''));
        const row = current
            ? await table().update({
                where: { id: current.id },
                data: { ...data, ...(accountChanged ? { imapUidValidity: null, imapLastUid: null, imapLastError: null, imapLastSummary: null } : {}) },
            })
            : await table().create({ data: { id: (0, nanoid_1.nanoid)(20), tenantId, purpose, ...data } });
        return rowOf(row);
    }
    async remove(tenantId, purpose) {
        const result = await table().deleteMany({ where: { tenantId, purpose } });
        return result.count > 0;
    }
    /** Der Lesestand nach einem Abruf (auch der Fehler — die Seite zeigt ihn). */
    async setCursor(id, patch) {
        await table().update({ where: { id }, data: patch }).catch(() => undefined);
    }
    /** Die Postfächer, deren Antworten der Abruf liest (aktiv, mit IMAP-Server). */
    async forCapture() {
        const rows = await table().findMany({
            where: { isActive: true, NOT: { imapHost: null } },
            orderBy: { imapLastSyncAt: 'asc' },
            take: 50,
        });
        return rows.map((row) => rowOf(row));
    }
}
exports.PrismaProductionMailboxRepository = PrismaProductionMailboxRepository;
/** Die Einstellungen, mit denen SmtpMailService sendet — Passwörter entschlüsselt. */
const mailSettingsOf = (row) => {
    let smtpPassword = null;
    let imapPassword = null;
    try {
        smtpPassword = (0, mailCrypto_1.decryptSecret)(row.smtpPassword);
    }
    catch {
        smtpPassword = null;
    }
    try {
        imapPassword = (0, mailCrypto_1.decryptSecret)(row.imapPassword);
    }
    catch {
        imapPassword = null;
    }
    return {
        fromName: row.fromName,
        fromEmail: row.fromEmail,
        replyTo: null,
        smtpHost: row.smtpHost,
        smtpPort: row.smtpPort,
        smtpSecure: row.smtpSecure,
        smtpUser: row.smtpUser || row.fromEmail,
        smtpPassword,
        imapHost: row.imapHost,
        imapPort: row.imapPort,
        imapSecure: row.imapSecure,
        imapUser: row.imapUser || row.smtpUser || row.fromEmail,
        imapPassword: imapPassword || smtpPassword,
        sentFolder: row.sentFolder,
        saveToSent: row.saveToSent,
    };
};
exports.mailSettingsOf = mailSettingsOf;
//# sourceMappingURL=ProductionMailboxRepository.js.map