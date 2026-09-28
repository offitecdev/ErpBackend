import prisma from "../database/prisma.client";
import { decryptSecret } from "./outlook/mailCrypto";
import type { MailSettings, SendMailInput } from "./SmtpMailService";

/* ── PERSÖNLICHES POSTFACH JE PERSON (28.09.2026) ──────────────────────────────
 *
 * Vorgabe Samet: «her personel için mail ayarları … artık kullanıcının maili
 * sadece o olsun her yerde». Die Verwaltung richtet einer Person ein eigenes
 * Konto ein (EmployeeMailbox, Fenster «Mail» in der Personalliste). Von da an
 * gilt für diese Person NUR noch dieses Konto:
 *
 *   Versand  — alles, was sie aus dem ERP verschickt, geht über SEIN SMTP mit
 *              SEINER Absenderadresse (`applyPersonalSender`).
 *   Postfach — /crm/mail zeigt nur dessen Post (`mailboxKeyOf` → Spalte
 *              `MailMessage.mailboxKey`); gelesen wird per IMAP von demselben
 *              Konto (ImapCaptureService mit `mailboxId`).
 *
 * Ohne eigenes Postfach bleibt alles, wie es war: das Firmenpostfach
 * (MailSetting am Stamm), `mailboxKey` = "".
 *
 * Die Zeile trägt die Spaltennamen von MailSetting, darum lesen Abruf und
 * Versand sie mit demselben Code — nur die Passwörter werden hier entschlüsselt.
 */

export type EmployeeMailboxRow = {
    id: string;
    tenantId: string;
    employeeId: string;
    isActive: boolean;
    fromName: string | null;
    fromEmail: string;
    smtpHost: string | null;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser: string | null;
    smtpPassword: string | null;
    imapHost: string | null;
    imapPort: number;
    imapSecure: boolean;
    imapUser: string | null;
    imapPassword: string | null;
    sentFolder: string | null;
    saveToSent: boolean;
    imapInboxFolder: string | null;
    imapCaptureEnabled: boolean;
    imapWindowMonths: number;
    imapLastSyncAt: Date | null;
    imapLastError: string | null;
    imapLastSummary: string | null;
};

/* Die neue Tabelle wird untypisiert angesprochen: ts-node-dev hält nach
   `prisma generate` die alten Client-Typen im Speicher (siehe local-dev-runtime). */
export const employeeMailboxTable = (): any => (prisma as any).employeeMailbox;

/* Kurzer Zwischenspeicher: der Versand und jede Postfach-Anfrage fragen
   danach, eine DB-Runde je Klick wäre zu viel. Speichern leert ihn. */
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; row: EmployeeMailboxRow | null }>();

export const invalidateEmployeeMailbox = (employeeId?: string): void => {
    if (employeeId) cache.delete(employeeId);
    else cache.clear();
};

/** Das AKTIVE persönliche Postfach einer Person — oder null (Firmenpostfach gilt). */
export const getEmployeeMailbox = async (employeeId: string | null | undefined): Promise<EmployeeMailboxRow | null> => {
    if (!employeeId) return null;
    const hit = cache.get(employeeId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.row;
    const row = await employeeMailboxTable()
        .findUnique({ where: { employeeId } })
        .catch(() => null) as EmployeeMailboxRow | null;
    const active = row && row.isActive ? row : null;
    cache.set(employeeId, { at: Date.now(), row: active });
    return active;
};

/** Der Schlüssel des Postfachs, das diese Person sieht: "" = Firmenpostfach. */
export const mailboxKeyOf = async (employeeId: string | null | undefined): Promise<string> =>
    (await getEmployeeMailbox(employeeId))?.id || "";

/** Zugangsdaten zum Senden/Lesen — Passwörter entschlüsselt. */
export const personalMailSettings = (row: EmployeeMailboxRow): MailSettings & Record<string, any> => {
    let smtpPassword: string | null = null;
    let imapPassword: string | null = null;
    try { smtpPassword = decryptSecret(row.smtpPassword); } catch { smtpPassword = null; }
    try { imapPassword = decryptSecret(row.imapPassword); } catch { imapPassword = null; }
    return {
        ...row,
        smtpPassword,
        imapPassword,
        replyTo: null,
    };
};

export interface PersonalSender {
    settings: MailSettings;
    mail: SendMailInput;
    mailboxKey: string;
}

/**
 * Stellt eine Sendung auf das persönliche Konto der Person um, sofern es eines
 * mit SMTP gibt. Absender = die Adresse des Kontos; eine Antwortadresse der
 * FIRMA fällt weg (die Antwort soll bei der Person ankommen), eine eigens
 * gesetzte bleibt. Ohne persönliches Konto: unverändert, `mailboxKey` "".
 */
export const applyPersonalSender = async (
    employeeId: string | null | undefined,
    companySettings: MailSettings | null | undefined,
    mail: SendMailInput,
): Promise<PersonalSender> => {
    const row = await getEmployeeMailbox(employeeId);
    if (!row || !row.smtpHost?.trim() || !row.smtpPort) {
        return { settings: companySettings || {}, mail, mailboxKey: "" };
    }
    const settings = personalMailSettings(row);
    const companyReplyTo = String(companySettings?.replyTo || "").trim().toLowerCase();
    const ownReplyTo = String(mail.replyTo || "").trim();
    return {
        settings,
        mailboxKey: row.id,
        mail: {
            ...mail,
            fromEmail: row.fromEmail,
            fromName: row.fromName || mail.fromName || null,
            replyTo: ownReplyTo && ownReplyTo.toLowerCase() !== companyReplyTo ? ownReplyTo : null,
        },
    };
};
