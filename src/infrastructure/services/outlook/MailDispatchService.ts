import { nanoid } from "nanoid";
import { Prisma } from "@prisma/client";
import prisma from "../../database/prisma.client";
import {
    MailSettings,
    SendMailInput,
    SmtpMailService,
    newMessageId,
} from "../SmtpMailService";
import type { SentCopyResult } from "../ImapMailService";
import { clampBody, htmlToText, previewOf } from "./mailText";
import { normalizeAddress } from "./mailCustomerMatcher";

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
const smtp = new SmtpMailService();

export interface DispatchContext {
    tenantId: string;
    employeeId: string;
}

export interface DispatchRecord {
    customerId?: string | null;
    contactId?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    entityLabel?: string | null;
    activityId?: string | null;
}

export interface DispatchOptions {
    /** Nur der Mail-Einstellungen-Test wartet auf die IMAP-Kopie. */
    waitForSentCopy?: boolean;
    /** Kunden-/Belegbezug → Zeile in MailMessage. Ohne: kein Eintrag. */
    record?: DispatchRecord | null;
    /** Historisch: es gibt nur noch den SMTP-Weg. Wird ignoriert. */
    smtpOnly?: boolean;
}

export type MailTransport = "SMTP" | "PREVIEW";

export interface DispatchResult {
    accepted: string[];
    preview: boolean;
    transport: MailTransport;
    sentCopy?: SentCopyResult | undefined;
    messageId: string;
    mailMessageId?: string | undefined;
    /** Absender, der tatsächlich verwendet wurde (bei Graph das Postfach). */
    fromEmail: string;
}

const attachmentMeta = (mail: SendMailInput) =>
    (mail.attachments || []).map((a) => ({
        name: a.filename,
        contentType: a.contentType,
        size: Math.floor(String(a.contentBase64 || "").replace(/\s+/g, "").length * 3 / 4),
    }));

const recordMessage = async (
    ctx: DispatchContext,
    mail: SendMailInput,
    ccList: string[],
    result: { transport: MailTransport; messageId: string; accountId: string | null; fromEmail: string; fromName: string | null },
    record: DispatchRecord,
): Promise<string> => {
    // Die Mandantensignatur (buildSignatureParts hängt sie als "\n\n-- \n…" an)
    // gehört nicht in die Grunddaten — das ERP kennt seine eigene Signatur.
    const rawText = mail.text || (mail.html ? htmlToText(mail.html) : "");
    const signatureAt = rawText.indexOf("\n-- \n");
    const text = (signatureAt > 0 ? rawText.slice(0, signatureAt) : rawText).trim();
    // Kontakt: explizit, sonst der Empfänger unter den Ansprechpartnern des Kunden.
    let contactId = record.contactId || null;
    if (!contactId && record.customerId) {
        const contact = await prisma.customerContact.findFirst({
            where: { customerId: record.customerId, email: { in: [mail.to, mail.to.toLowerCase()] } },
            select: { id: true },
        }).catch(() => null);
        contactId = contact?.id || null;
    }
    const attachments = attachmentMeta(mail);
    const row = await prisma.mailMessage.create({
        data: {
            id: nanoid(12),
            tenantId: ctx.tenantId,
            accountId: result.accountId,
            employeeId: ctx.employeeId,
            direction: "OUT",
            origin: "ERP",
            internetMessageId: result.messageId.slice(0, 255),
            subject: mail.subject.slice(0, 500),
            fromName: result.fromName?.slice(0, 255) || null,
            fromAddress: normalizeAddress(result.fromEmail).slice(0, 255),
            toRecipients: [{ name: null, address: normalizeAddress(mail.to) }] as unknown as Prisma.InputJsonValue,
            ccRecipients: ccList.length
                ? (ccList.map((address) => ({ name: null, address: normalizeAddress(address) })) as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
            bodyPreview: previewOf(text, 500),
            bodyText: clampBody(text),
            sentAt: new Date(),
            hasAttachments: attachments.length > 0,
            attachments: attachments.length ? (attachments as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
            isRead: true,
            customerId: record.customerId || null,
            contactId,
            matchSource: record.customerId ? "ERP" : null,
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
export const dispatchMail = async (
    ctx: DispatchContext,
    settings: MailSettings | null | undefined,
    mail: SendMailInput,
    options: DispatchOptions = {},
): Promise<DispatchResult> => {
    const ccList = (mail.cc || []).map((value) => String(value || "").trim()).filter(Boolean);
    // Die Message-ID wird HIER vergeben und mitgeschrieben: an ihr erkennt der
    // IMAP-Abruf die Antwort des Kunden (In-Reply-To/References) wieder.
    const messageId = mail.messageId || newMessageId(mail.fromEmail);
    const prepared: SendMailInput = { ...mail, messageId };

    const smtpResult = await smtp.send(settings || {}, prepared, options.waitForSentCopy ? { waitForSentCopy: true } : {});
    const result: DispatchResult = {
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
