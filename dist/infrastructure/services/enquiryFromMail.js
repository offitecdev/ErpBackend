"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEnquiriesFromMails = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
/**
 * MAIL → ANFRAGE (10.09.2026, Vorgabe Samet)
 *
 *   «Und im Postfach gibt es den Bereich Anfragen; was ich dort hineinlege, ist
 *    die Mail eines Kunden, der meistens NOCH NICHT im System steht — das sind
 *    im Allgemeinen Leute, die nicht im System sind und uns erreichen wollen.»
 *
 * Deshalb legt das Zuordnen einer Nachricht zur Kategorie «Anfragen» eine
 * Enquiry an — und zwar OHNE Kunden. Absender, Betreff und Text der Mail sind
 * die Anfrage; `customerId` wird nur mitgenommen, wenn das Postfach die
 * Nachricht ohnehin schon einem Kunden zuordnen konnte.
 *
 * ZWEI REGELN, DIE HIER WICHTIG SIND:
 *
 *  1. NUR EINGEHENDE POST. Eine gesendete Nachricht in der Sammelkategorie ist
 *     unsere eigene Antwort, keine Anfrage.
 *
 *  2. EINE MAIL WIRD NUR EINMAL ZUR ANFRAGE. Wer eine Nachricht herauszieht
 *     und wieder hineinlegt, soll keine zweite Anfrage bekommen — dafür sorgt
 *     der eindeutige Schlüssel (tenantId, mailMessageId). Das Entfernen aus
 *     der Kategorie LÖSCHT die Anfrage bewusst NICHT: sie ist ab dem Anlegen
 *     ein eigener Vorgang mit Stand, verantwortlicher Person und Notizen.
 *
 * Der Aufruf ist ein Nebenzweig des Zuordnens: schlägt er fehl, bleibt die
 * Zuordnung trotzdem stehen (das Postfach ist nicht die Anfragenverwaltung).
 */
/** Was aus dem Absendernamen als Firmenname taugt — sonst bleibt das Feld leer. */
const splitSenderName = (fromName, fromAddress) => {
    const name = (fromName || "").trim();
    if (name && name.toLowerCase() !== (fromAddress || "").toLowerCase())
        return name;
    return "";
};
/** Der Text der Mail als Anfragetext; HTML bleibt aussen vor. */
const messageOf = (bodyText, bodyPreview) => (bodyText || bodyPreview || "").slice(0, 20_000) || null;
/**
 * Legt für jede EINGEHENDE Nachricht der Liste eine Anfrage an, sofern noch
 * keine besteht. Kostet zwei Abfragen für die ganze Menge (vorhandene suchen,
 * fehlende schreiben) — nicht zwei je Nachricht.
 */
const createEnquiriesFromMails = async (tenantId, messageIds, createdByEmployeeId) => {
    if (!messageIds.length)
        return { created: 0, skipped: 0 };
    const [messages, existing] = await Promise.all([
        prisma_client_1.default.mailMessage.findMany({
            where: { id: { in: messageIds }, tenantId, direction: "IN" },
            select: {
                id: true, subject: true, fromName: true, fromAddress: true,
                bodyText: true, bodyPreview: true, sentAt: true,
                customerId: true, contactId: true,
            },
        }),
        prisma_client_1.default.enquiry.findMany({
            where: { tenantId, mailMessageId: { in: messageIds } },
            select: { mailMessageId: true },
        }),
    ]);
    const already = new Set(existing.map((row) => row.mailMessageId));
    const fresh = messages.filter((message) => !already.has(message.id));
    if (!fresh.length)
        return { created: 0, skipped: messages.length };
    await prisma_client_1.default.enquiry.createMany({
        data: fresh.map((message) => ({
            id: (0, nanoid_1.nanoid)(12),
            tenantId,
            source: "MAIL",
            status: "NEW",
            priority: "NORMAL",
            companyName: splitSenderName(message.fromName, message.fromAddress) || null,
            contactName: splitSenderName(message.fromName, message.fromAddress) || null,
            email: message.fromAddress || null,
            subject: (message.subject || "").slice(0, 300) || "(ohne Betreff)",
            message: messageOf(message.bodyText, message.bodyPreview),
            customerId: message.customerId,
            contactId: message.contactId,
            mailMessageId: message.id,
            createdByEmployeeId,
            // Der Eingang der ANFRAGE ist der Empfang der Mail, nicht der
            // Augenblick des Einsortierens — sonst stünde eine Woche alte Post
            // als "gerade eben" in der Liste.
            createdAt: message.sentAt,
        })),
        skipDuplicates: true,
    });
    return { created: fresh.length, skipped: messages.length - fresh.length };
};
exports.createEnquiriesFromMails = createEnquiriesFromMails;
//# sourceMappingURL=enquiryFromMail.js.map