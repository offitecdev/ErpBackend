import prisma from "../database/prisma.client";
import { getMailTenantId } from "../../presentation/controllers/serviceTenantScope";

/* ── WELCHES POSTFACH IST DAS? ───────────────────────────────────────────────
 *
 * Server plus Postfachadresse, kleingeschrieben: `mail.cyon.ch|sck@offitec.eu`.
 * Ändert sich diese Zeichenkette, ist es ein ANDERES Konto — und alles, was das
 * alte hereingeholt hat (Nachrichten wie Kalendertermine), gehört nicht mehr
 * hierher.
 *
 * Die Kennung stand bis zum 31.08.2026 als private Hilfsfunktion im
 * `MailController` und wurde nur beim Speichern der Einstellungen benutzt. Das
 * war zu wenig: der KALENDER braucht dieselbe Kennung, um einen übernommenen
 * Termin einem Konto zuordnen zu können. Zwei Fassungen derselben Regel wären
 * genau die Art Abweichung, die man erst am falschen Termin im Kalender merkt —
 * darum steht sie hier einmal und wird überall importiert.
 *
 * Die Adresse ist der IMAP-Benutzer, sonst der SMTP-Benutzer, sonst die
 * Absenderadresse — dieselbe Reihenfolge wie in `inboxStatus`. Ist keine davon
 * gesetzt, gibt es kein Postfach und die Kennung ist leer; leer heisst überall
 * "gehört niemandem".
 *
 * ⚠ Die MIGRATION `20260917090000_calendar_mailbox_ownership` bildet dieselbe
 * Zeichenkette in SQL nach. Wer hier etwas ändert, ändert sie dort mit, sonst
 * verlieren die nachgetragenen Zeilen ihre Zuordnung.
 */

export interface MailboxIdentityFields {
    imapHost?: string | null;
    imapUser?: string | null;
    smtpUser?: string | null;
    fromEmail?: string | null;
}

const clean = (value: unknown) => String(value || "").trim().toLowerCase();

export const mailboxIdentity = (
    host: unknown,
    imapUser: unknown,
    smtpUser: unknown,
    fromEmail: unknown,
): string => {
    const box = clean(imapUser) || clean(smtpUser) || clean(fromEmail);
    return box ? `${clean(host)}|${box}` : "";
};

/** Dieselbe Kennung aus einer bereits geladenen `MailSetting`-Zeile. */
export const mailboxIdentityOf = (settings: MailboxIdentityFields | null | undefined): string =>
    mailboxIdentity(settings?.imapHost, settings?.imapUser, settings?.smtpUser, settings?.fromEmail);

/**
 * Die Kennung des Postfachs, das für diesen Mandanten gilt — aufgelöst über den
 * Stamm des Firmenbaums, denn dort steht die eine Einrichtung des Hauses.
 *
 * Leere Zeichenkette = kein Postfach eingerichtet. Aufrufer müssen das als
 * "zeige nichts Übernommenes" behandeln und nicht als "zeige alles": ohne Konto
 * ist kein Termin von aussen der unsere.
 */
export const currentMailboxIdentity = async (selectedTenantId: string): Promise<string> => {
    const tenantId = await getMailTenantId(selectedTenantId).catch(() => selectedTenantId);
    const settings = await prisma.mailSetting.findUnique({
        where: { tenantId },
        select: { imapHost: true, imapUser: true, smtpUser: true, fromEmail: true },
    });
    return mailboxIdentityOf(settings);
};
