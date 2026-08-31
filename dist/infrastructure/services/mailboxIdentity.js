"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.currentMailboxIdentity = exports.mailboxIdentityOf = exports.mailboxIdentity = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const serviceTenantScope_1 = require("../../presentation/controllers/serviceTenantScope");
const clean = (value) => String(value || "").trim().toLowerCase();
const mailboxIdentity = (host, imapUser, smtpUser, fromEmail) => {
    const box = clean(imapUser) || clean(smtpUser) || clean(fromEmail);
    return box ? `${clean(host)}|${box}` : "";
};
exports.mailboxIdentity = mailboxIdentity;
/** Dieselbe Kennung aus einer bereits geladenen `MailSetting`-Zeile. */
const mailboxIdentityOf = (settings) => (0, exports.mailboxIdentity)(settings?.imapHost, settings?.imapUser, settings?.smtpUser, settings?.fromEmail);
exports.mailboxIdentityOf = mailboxIdentityOf;
/**
 * Die Kennung des Postfachs, das für diesen Mandanten gilt — aufgelöst über den
 * Stamm des Firmenbaums, denn dort steht die eine Einrichtung des Hauses.
 *
 * Leere Zeichenkette = kein Postfach eingerichtet. Aufrufer müssen das als
 * "zeige nichts Übernommenes" behandeln und nicht als "zeige alles": ohne Konto
 * ist kein Termin von aussen der unsere.
 */
const currentMailboxIdentity = async (selectedTenantId) => {
    const tenantId = await (0, serviceTenantScope_1.getMailTenantId)(selectedTenantId).catch(() => selectedTenantId);
    const settings = await prisma_client_1.default.mailSetting.findUnique({
        where: { tenantId },
        select: { imapHost: true, imapUser: true, smtpUser: true, fromEmail: true },
    });
    return (0, exports.mailboxIdentityOf)(settings);
};
exports.currentMailboxIdentity = currentMailboxIdentity;
//# sourceMappingURL=mailboxIdentity.js.map