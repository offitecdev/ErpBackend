"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyPersonalSender = exports.personalMailSettings = exports.mailboxKeyOf = exports.getEmployeeMailbox = exports.invalidateEmployeeMailbox = exports.employeeMailboxTable = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const mailCrypto_1 = require("./outlook/mailCrypto");
/* Die neue Tabelle wird untypisiert angesprochen: ts-node-dev hält nach
   `prisma generate` die alten Client-Typen im Speicher (siehe local-dev-runtime). */
const employeeMailboxTable = () => prisma_client_1.default.employeeMailbox;
exports.employeeMailboxTable = employeeMailboxTable;
/* Kurzer Zwischenspeicher: der Versand und jede Postfach-Anfrage fragen
   danach, eine DB-Runde je Klick wäre zu viel. Speichern leert ihn. */
const TTL_MS = 30_000;
const cache = new Map();
const invalidateEmployeeMailbox = (employeeId) => {
    if (employeeId)
        cache.delete(employeeId);
    else
        cache.clear();
};
exports.invalidateEmployeeMailbox = invalidateEmployeeMailbox;
/** Das AKTIVE persönliche Postfach einer Person — oder null (Firmenpostfach gilt). */
const getEmployeeMailbox = async (employeeId) => {
    if (!employeeId)
        return null;
    const hit = cache.get(employeeId);
    if (hit && Date.now() - hit.at < TTL_MS)
        return hit.row;
    const row = await (0, exports.employeeMailboxTable)()
        .findUnique({ where: { employeeId } })
        .catch(() => null);
    const active = row && row.isActive ? row : null;
    cache.set(employeeId, { at: Date.now(), row: active });
    return active;
};
exports.getEmployeeMailbox = getEmployeeMailbox;
/** Der Schlüssel des Postfachs, das diese Person sieht: "" = Firmenpostfach. */
const mailboxKeyOf = async (employeeId) => (await (0, exports.getEmployeeMailbox)(employeeId))?.id || "";
exports.mailboxKeyOf = mailboxKeyOf;
/** Zugangsdaten zum Senden/Lesen — Passwörter entschlüsselt. */
const personalMailSettings = (row) => {
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
        ...row,
        smtpPassword,
        imapPassword,
        replyTo: null,
    };
};
exports.personalMailSettings = personalMailSettings;
/**
 * Stellt eine Sendung auf das persönliche Konto der Person um, sofern es eines
 * mit SMTP gibt. Absender = die Adresse des Kontos; eine Antwortadresse der
 * FIRMA fällt weg (die Antwort soll bei der Person ankommen), eine eigens
 * gesetzte bleibt. Ohne persönliches Konto: unverändert, `mailboxKey` "".
 */
const applyPersonalSender = async (employeeId, companySettings, mail) => {
    const row = await (0, exports.getEmployeeMailbox)(employeeId);
    if (!row || !row.smtpHost?.trim() || !row.smtpPort) {
        return { settings: companySettings || {}, mail, mailboxKey: "" };
    }
    const settings = (0, exports.personalMailSettings)(row);
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
exports.applyPersonalSender = applyPersonalSender;
//# sourceMappingURL=employeeMailbox.js.map