"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductionMailboxUseCase = exports.DEFAULT_MAIL_HOST = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
const productionBom_1 = require("../../../../domain/services/productionBom");
const ProductionMailboxRepository_1 = require("../../../../infrastructure/repositories/ProductionMailboxRepository");
const ImapCaptureService_1 = require("../../../../infrastructure/services/ImapCaptureService");
const NodemailerTransport_1 = require("../../../../infrastructure/services/NodemailerTransport");
/**
 * ── ÜRETİM AYARLARI › E-POSTA (30.09.2026, Vorgabe Samet) ──────────────────
 *
 * «Ayarlarda da üretim modülü ayarlarında o mailleri girelim, mail ayarlarını
 *  yapalım — şifresi şu bu.» Zwei Postfächer: RFQ (rfq@offitec.ch —
 * Preisanfragen hinaus, Antworten herein) und freiwillig eines für die
 * Bestellungen. Die Server stehen vor (mail.cyon.ch 465/993 SSL, wie das
 * persönliche Postfach); die Seite fragt nur Adresse und Passwort. Passwörter
 * gehen nie zurück an die Seite (`hasPassword`). Ändern darf die
 * Administratorrolle; lesen und «Şimdi kontrol et» auch der Einkauf.
 */
exports.DEFAULT_MAIL_HOST = 'mail.cyon.ch';
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;
const text = (value, max) => {
    const clean = String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
    return clean || null;
};
const port = (value, fallback) => {
    const number = Math.trunc(Number(value));
    return number > 0 && number < 65536 ? number : fallback;
};
const dtoOf = (row) => ({
    purpose: row.purpose,
    isActive: row.isActive,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecure: row.smtpSecure,
    smtpUser: row.smtpUser,
    hasPassword: Boolean(row.smtpPassword),
    imapHost: row.imapHost,
    imapPort: row.imapPort,
    imapSecure: row.imapSecure,
    imapUser: row.imapUser,
    hasImapPassword: Boolean(row.imapPassword),
    imapFolder: row.imapFolder,
    lastCheckAt: row.imapLastSyncAt ? row.imapLastSyncAt.toISOString() : null,
    lastError: row.imapLastError,
    lastSummary: row.imapLastSummary,
    updatedAt: row.updatedAt.toISOString(),
});
const purposeFrom = (value) => {
    const raw = String(value ?? '').toUpperCase();
    if (raw === 'RFQ' || raw === 'ORDER')
        return raw;
    throw (0, productionBom_1.bomError)('NOT_FOUND', 'Unbekanntes Postfach.', { status: 404 });
};
/** Die Eingabe der Seite — Adresse Pflicht, Server mit Vorgabe, Passwort: leer = behalten, null = löschen. */
const writeOf = (body, current) => {
    const input = (body && typeof body === 'object' ? body : {});
    const fromEmail = text(input.fromEmail, 255)?.toLowerCase() ?? '';
    if (!EMAIL.test(fromEmail))
        throw (0, productionBom_1.bomError)('MAILBOX_INVALID', 'Die E-Mail-Adresse ist ungültig.', { params: { field: 'fromEmail' } });
    const smtpHost = text(input.smtpHost, 255) ?? current?.smtpHost ?? exports.DEFAULT_MAIL_HOST;
    const imapHost = input.imapHost === '' ? null : (text(input.imapHost, 255) ?? current?.imapHost ?? exports.DEFAULT_MAIL_HOST);
    const secret = (value) => {
        if (value === null)
            return null;
        if (value === undefined)
            return undefined;
        const clean = String(value);
        return clean.length ? clean.slice(0, 500) : undefined;
    };
    return {
        isActive: input.isActive === undefined ? (current?.isActive ?? true) : input.isActive !== false,
        fromName: text(input.fromName, 255),
        fromEmail,
        smtpHost,
        smtpPort: port(input.smtpPort, current?.smtpPort ?? 465),
        smtpSecure: input.smtpSecure === undefined ? (current?.smtpSecure ?? true) : input.smtpSecure !== false,
        smtpUser: text(input.smtpUser, 255),
        imapHost,
        imapPort: port(input.imapPort, current?.imapPort ?? 993),
        imapSecure: input.imapSecure === undefined ? (current?.imapSecure ?? true) : input.imapSecure !== false,
        imapUser: text(input.imapUser, 255),
        imapFolder: text(input.imapFolder, 255),
        smtpPassword: secret(input.password ?? input.smtpPassword),
        imapPassword: secret(input.imapPassword),
    };
};
class ProductionMailboxUseCase {
    mailboxes;
    inbox;
    constructor(mailboxes, inbox) {
        this.mailboxes = mailboxes;
        this.inbox = inbox;
    }
    assertAdmin(actor) {
        if (!actor.isAdmin)
            throw (0, productionBom_1.bomError)('FORBIDDEN', 'Die Postfächer richtet die Administratorrolle ein.', { status: 403 });
    }
    assertCanSee(actor) {
        if (actor.isAdmin || actor.canSeeProcurement)
            return;
        throw (0, productionBom_1.bomError)('FORBIDDEN', 'Die Postfächer sehen Einkauf und Administratorrolle.', { status: 403 });
    }
    async list(tenantId, actor) {
        this.assertCanSee(actor);
        const rows = await this.mailboxes.list(tenantId);
        const rfq = rows.find((row) => row.purpose === 'RFQ') ?? null;
        const order = rows.find((row) => row.purpose === 'ORDER') ?? null;
        return {
            rfq: rfq ? dtoOf(rfq) : null,
            order: order ? dtoOf(order) : null,
            defaults: { host: exports.DEFAULT_MAIL_HOST, smtpPort: 465, imapPort: 993 },
            canEdit: actor.isAdmin,
        };
    }
    async save(tenantId, actor, rawPurpose, body) {
        this.assertAdmin(actor);
        const purpose = purposeFrom(rawPurpose);
        const current = await this.mailboxes.get(tenantId, purpose);
        const input = writeOf(body, current);
        if (!current && !input.smtpPassword) {
            throw (0, productionBom_1.bomError)('MAILBOX_INVALID', 'Für ein neues Postfach fehlt das Passwort.', { params: { field: 'password' } });
        }
        const row = await this.mailboxes.save(tenantId, purpose, input, actor.id);
        // Ein geändertes Konto: der Versand öffnet eine neue Verbindung.
        (0, NodemailerTransport_1.resetTransporters)();
        return dtoOf(row);
    }
    async remove(tenantId, actor, rawPurpose) {
        this.assertAdmin(actor);
        const removed = await this.mailboxes.remove(tenantId, purposeFrom(rawPurpose));
        (0, NodemailerTransport_1.resetTransporters)();
        return { removed };
    }
    /** SMTP-Anmeldung und IMAP-Postfach prüfen — mit den GESPEICHERTEN Angaben (und neuen aus dem Formular). */
    async test(tenantId, actor, rawPurpose, body) {
        this.assertAdmin(actor);
        const purpose = purposeFrom(rawPurpose);
        const current = await this.mailboxes.get(tenantId, purpose);
        const input = body && typeof body === 'object' && Object.keys(body).length ? writeOf(body, current) : null;
        const row = current
            ? { ...current, ...(input ? { ...input, smtpPassword: current.smtpPassword, imapPassword: current.imapPassword } : {}) }
            : null;
        if (!row)
            throw (0, productionBom_1.bomError)('MAILBOX_MISSING', 'Dieses Postfach ist noch nicht eingerichtet.', { status: 404 });
        const settings = (0, ProductionMailboxRepository_1.mailSettingsOf)(row);
        // Ein neues Passwort im Formular gilt für den Test, gespeichert wird es erst mit «Kaydet».
        if (input?.smtpPassword)
            settings.smtpPassword = input.smtpPassword;
        if (input?.imapPassword || input?.smtpPassword)
            settings.imapPassword = input.imapPassword || input.smtpPassword || settings.imapPassword || null;
        const result = { smtp: null, imap: null };
        if (settings.smtpHost) {
            const transporter = nodemailer_1.default.createTransport({
                host: settings.smtpHost,
                port: Number(settings.smtpPort),
                secure: Boolean(settings.smtpSecure) || Number(settings.smtpPort) === 465,
                auth: { user: String(settings.smtpUser || settings.fromEmail), pass: String(settings.smtpPassword || '') },
                connectionTimeout: 15_000,
                greetingTimeout: 15_000,
                socketTimeout: 20_000,
                tls: { rejectUnauthorized: false },
            });
            try {
                await transporter.verify();
                result.smtp = { ok: true };
            }
            catch (error) {
                result.smtp = { ok: false, error: String(error?.message || error).slice(0, 300) };
            }
            finally {
                transporter.close();
            }
        }
        if (settings.imapHost) {
            const client = (0, ImapCaptureService_1.buildImapClient)(settings);
            try {
                await client.connect();
                const box = await client.status(row.imapFolder || 'INBOX', { messages: true });
                result.imap = { ok: true, messages: Number(box?.messages || 0) };
            }
            catch (error) {
                const failure = error;
                result.imap = { ok: false, error: String(failure?.responseText || failure?.message || error).slice(0, 300) };
            }
            finally {
                await client.logout().catch(() => undefined);
            }
        }
        return result;
    }
    /** «Şimdi kontrol et» — die Antworten sofort lesen, nicht erst in zwei Minuten. */
    async check(tenantId, actor) {
        this.assertCanSee(actor);
        return { runs: await this.inbox.runTenant(tenantId) };
    }
}
exports.ProductionMailboxUseCase = ProductionMailboxUseCase;
//# sourceMappingURL=ProductionMailboxUseCase.js.map