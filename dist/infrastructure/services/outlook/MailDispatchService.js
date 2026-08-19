"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.dispatchMail = void 0;
const nanoid_1 = require("nanoid");
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../database/prisma.client"));
const SmtpMailService_1 = require("../SmtpMailService");
const mailText_1 = require("./mailText");
const mailCustomerMatcher_1 = require("./mailCustomerMatcher");
/**
 * EIN Versandweg für alles, was das ERP an Kunden schickt (Angebot, Auftrag,
 * Rechnung, freie Mail): der EIGENE MAILSERVER des Betriebs über SMTP
 * (nodemailer, Zugangsdaten aus `MailSetting`).
 *
 * Ausdrücklich NICHT über Outlook Online / Microsoft Graph (Vorgabe
 * 18.08.2026): jenes Postfach ist mit dem Postfach auf dem eigenen Server
 * nicht abgeglichen, ein Versand von dort landete in einem anderen
 * "Gesendet" als dem, das die Mitarbeitenden in Outlook sehen — und die
 * Antwort des Kunden käme in einem Postfach an, das das ERP nicht liest.
 * Eingehende Mail holt `ImapCaptureService` von demselben Server.
 *
 * Unabhängig davon wird die Sendung als `MailMessage` (OUT, Herkunft ERP)
 * festgehalten, sobald ein Kunden-/Belegbezug mitgegeben wird — und ihre
 * Message-ID ist der Faden, an dem der IMAP-Abruf später die ANTWORT des
 * Kunden erkennt und demselben Kunden zuordnet.
 */
const smtp = new SmtpMailService_1.SmtpMailService();
const attachmentMeta = (mail) => (mail.attachments || []).map((a) => ({
    name: a.filename,
    contentType: a.contentType,
    size: Math.floor(String(a.contentBase64 || "").replace(/\s+/g, "").length * 3 / 4),
}));
const recordMessage = async (ctx, mail, ccList, result, record) => {
    // Die Mandantensignatur (buildSignatureParts hängt sie als "\n\n-- \n…" an)
    // gehört nicht in die Grunddaten — das ERP kennt seine eigene Signatur.
    const rawText = mail.text || (mail.html ? (0, mailText_1.htmlToText)(mail.html) : "");
    const signatureAt = rawText.indexOf("\n-- \n");
    const text = (signatureAt > 0 ? rawText.slice(0, signatureAt) : rawText).trim();
    // Kontakt: explizit, sonst der Empfänger unter den Ansprechpartnern des Kunden.
    let contactId = record.contactId || null;
    if (!contactId && record.customerId) {
        const contact = await prisma_client_1.default.customerContact.findFirst({
            where: { customerId: record.customerId, email: { in: [mail.to, mail.to.toLowerCase()] } },
            select: { id: true },
        }).catch(() => null);
        contactId = contact?.id || null;
    }
    const attachments = attachmentMeta(mail);
    const row = await prisma_client_1.default.mailMessage.create({
        data: {
            id: (0, nanoid_1.nanoid)(12),
            tenantId: ctx.tenantId,
            accountId: result.accountId,
            employeeId: ctx.employeeId,
            direction: "OUT",
            origin: "ERP",
            internetMessageId: result.messageId.slice(0, 255),
            subject: mail.subject.slice(0, 500),
            fromName: result.fromName?.slice(0, 255) || null,
            fromAddress: (0, mailCustomerMatcher_1.normalizeAddress)(result.fromEmail).slice(0, 255),
            toRecipients: [{ name: null, address: (0, mailCustomerMatcher_1.normalizeAddress)(mail.to) }],
            ccRecipients: ccList.length
                ? ccList.map((address) => ({ name: null, address: (0, mailCustomerMatcher_1.normalizeAddress)(address) }))
                : client_1.Prisma.JsonNull,
            bodyPreview: (0, mailText_1.previewOf)(text, 500),
            bodyText: (0, mailText_1.clampBody)(text),
            sentAt: new Date(),
            hasAttachments: attachments.length > 0,
            attachments: attachments.length ? attachments : client_1.Prisma.JsonNull,
            isRead: true,
            customerId: record.customerId || null,
            contactId,
            matchSource: record.matchSource ?? (record.customerId ? "ERP" : null),
            entityType: record.entityType || null,
            entityId: record.entityId || null,
            entityLabel: record.entityLabel?.slice(0, 64) || null,
            activityId: record.activityId || null,
        },
        select: { id: true },
    });
    return row.id;
};
/**
 * Versendet über den eigenen Mailserver und protokolliert. Wirft bei
 * Transportfehlern (wie `smtp.send`); ohne konfigurierten SMTP-Server bleibt
 * der bisherige Vorschau-Vertrag erhalten (`preview: true`, kein Protokoll).
 */
const dispatchMail = async (ctx, settings, mail, options = {}) => {
    const ccList = (mail.cc || []).map((value) => String(value || "").trim()).filter(Boolean);
    // Die Message-ID wird HIER vergeben und mitgeschrieben: an ihr erkennt der
    // IMAP-Abruf die Antwort des Kunden (In-Reply-To/References) wieder.
    const messageId = mail.messageId || (0, SmtpMailService_1.newMessageId)(mail.fromEmail);
    const prepared = { ...mail, messageId };
    const smtpResult = await smtp.send(settings || {}, prepared, options.waitForSentCopy ? { waitForSentCopy: true } : {});
    const result = {
        accepted: smtpResult.accepted,
        preview: smtpResult.preview,
        transport: smtpResult.preview ? "PREVIEW" : "SMTP",
        sentCopy: smtpResult.sentCopy,
        messageId,
        fromEmail: mail.fromEmail,
    };
    if (!smtpResult.preview && options.record) {
        result.mailMessageId = await recordMessage(ctx, prepared, ccList, {
            transport: "SMTP", messageId, accountId: null, fromEmail: mail.fromEmail, fromName: mail.fromName || null,
        }, options.record).catch((error) => {
            console.error("[MAIL] Protokollzeile konnte nicht geschrieben werden:", error?.message || error);
            return undefined;
        });
    }
    return result;
};
exports.dispatchMail = dispatchMail;
//# sourceMappingURL=MailDispatchService.js.map