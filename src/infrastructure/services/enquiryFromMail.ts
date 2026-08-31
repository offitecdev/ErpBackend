import { nanoid } from "nanoid";
import prisma from "../database/prisma.client";

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
 *
 * ZWEI MANDANTEN (13.09.2026): die MAIL liegt im Postfach am Stamm des
 * Firmenbaums, die ANFRAGE entsteht in der Firma, in der gerade gearbeitet
 * wird. Beides in einen Topf zu werfen hiesse: entweder findet die Suche die
 * Nachricht nicht mehr, oder die Anfrage landet in einer Firma, in der sie
 * niemand bearbeitet.
 */

/** Was aus dem Absendernamen als Firmenname taugt — sonst bleibt das Feld leer. */
const splitSenderName = (fromName: string | null, fromAddress: string | null) => {
    const name = (fromName || "").trim();
    if (name && name.toLowerCase() !== (fromAddress || "").toLowerCase()) return name;
    return "";
};

/** Der Text der Mail als Anfragetext; HTML bleibt aussen vor. */
const messageOf = (bodyText: string | null, bodyPreview: string | null) =>
    (bodyText || bodyPreview || "").slice(0, 20_000) || null;

export interface EnquiryFromMailResult {
    created: number;
    /** Ids der Nachrichten, für die schon eine Anfrage bestand. */
    skipped: number;
}

/**
 * Legt für jede EINGEHENDE Nachricht der Liste eine Anfrage an, sofern noch
 * keine besteht. Kostet zwei Abfragen für die ganze Menge (vorhandene suchen,
 * fehlende schreiben) — nicht zwei je Nachricht.
 */
export const createEnquiriesFromMails = async (
    mailTenantId: string,
    messageIds: string[],
    createdByEmployeeId: string | null,
    enquiryTenantId: string = mailTenantId,
): Promise<EnquiryFromMailResult> => {
    if (!messageIds.length) return { created: 0, skipped: 0 };

    const [messages, existing] = await Promise.all([
        prisma.mailMessage.findMany({
            where: { id: { in: messageIds }, tenantId: mailTenantId, direction: "IN" },
            select: {
                id: true, subject: true, fromName: true, fromAddress: true,
                bodyText: true, bodyPreview: true, sentAt: true,
                customerId: true, contactId: true,
            },
        }),
        prisma.enquiry.findMany({
            where: { tenantId: enquiryTenantId, mailMessageId: { in: messageIds } },
            select: { mailMessageId: true },
        }),
    ]);

    const already = new Set(existing.map((row) => row.mailMessageId));
    const fresh = messages.filter((message) => !already.has(message.id));
    if (!fresh.length) return { created: 0, skipped: messages.length };

    await prisma.enquiry.createMany({
        data: fresh.map((message) => ({
            id: nanoid(12),
            tenantId: enquiryTenantId,
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
