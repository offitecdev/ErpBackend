"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const nanoid_1 = require("nanoid");
const nodemailer_1 = __importDefault(require("nodemailer"));
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const mailCrypto_1 = require("../../infrastructure/services/outlook/mailCrypto");
const mailCustomerMatcher_1 = require("../../infrastructure/services/outlook/mailCustomerMatcher");
const mailText_1 = require("../../infrastructure/services/outlook/mailText");
const NodemailerTransport_1 = require("../../infrastructure/services/NodemailerTransport");
const mailboxIdentity_1 = require("../../infrastructure/services/mailboxIdentity");
const ImapCaptureService_1 = require("../../infrastructure/services/ImapCaptureService");
const employeeMailbox_1 = require("../../infrastructure/services/employeeMailbox");
const serviceTenantScope_1 = require("../controllers/serviceTenantScope");
/* ── PERSÖNLICHE POSTFÄCHER — Verwaltung (28.09.2026) ──────────────────────────
 *
 * Vorgabe Samet: «her personel için mail ayarları yap, yönetici ekranında bir
 * pop up olarak çıksın, mail yapılandırmasını yap ve mailini yeniden başlattır
 * ve yüklettir, artık kullanıcının maili sadece o olsun her yerde».
 *
 *   GET    /personnel/mailboxes                    wer hat eines (Liste)
 *   GET    /personnel/mailboxes/:employeeId        Einrichtung + Zustand
 *   PUT    /personnel/mailboxes/:employeeId        speichern → neu starten + laden
 *   POST   /personnel/mailboxes/:employeeId/test   SMTP + IMAP prüfen, nichts speichern
 *   POST   /personnel/mailboxes/:employeeId/restart  Lesestand zurück, sofort neu laden
 *   DELETE /personnel/mailboxes/:employeeId        entfernen (zurück zum Firmenpostfach)
 *
 * Unter /personnel eingehängt, damit jedes Speichern den Lesespeicher der
 * Personalliste leert — die Adresse der Person kann sich dabei ändern.
 * Passwörter verlassen den Server nie; gespeichert werden sie verschlüsselt.
 */
const router = (0, express_1.Router)();
const MANAGE = (0, RbacMiddleware_1.requireAnyPermission)(["mail.manage", "employees.update"]);
/** Die Person — nur aus dem eigenen Firmenbaum. */
const findEmployee = async (req) => {
    const tenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(req.user.tenantId).catch(() => [req.user.tenantId]);
    return prisma_client_1.default.employee.findFirst({
        where: { id: String(req.params.employeeId), tenantId: { in: tenantIds.length ? tenantIds : [req.user.tenantId] }, deletedAt: null },
        select: { id: true, tenantId: true, firstName: true, lastName: true, email: true },
    });
};
const mailboxDto = (row) => row ? {
    id: row.id,
    isActive: row.isActive,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpSecure: row.smtpSecure,
    smtpUser: row.smtpUser,
    hasSmtpPassword: Boolean(row.smtpPassword),
    imapHost: row.imapHost,
    imapPort: row.imapPort,
    imapSecure: row.imapSecure,
    imapUser: row.imapUser,
    hasImapPassword: Boolean(row.imapPassword),
    sentFolder: row.sentFolder,
    imapInboxFolder: row.imapInboxFolder,
    imapCaptureEnabled: row.imapCaptureEnabled,
    imapWindowMonths: (0, ImapCaptureService_1.normalizeWindowMonths)(row.imapWindowMonths),
} : null;
const statusDto = async (row) => {
    if (!row)
        return null;
    const counts = await prisma_client_1.default.$queryRaw `
        SELECT SUM(m.direction = 'IN') AS inbox, SUM(m.direction = 'OUT') AS sent
          FROM MailMessage m
         WHERE m.tenantId = ${row.tenantId} AND m.mailboxKey = ${row.id} AND m.deletedAt IS NULL`;
    return {
        running: (0, ImapCaptureService_1.isMailboxCaptureRunning)(row.id),
        lastSyncAt: row.imapLastSyncAt,
        lastSummary: row.imapLastSummary,
        lastError: row.imapLastError,
        inbox: Number(counts[0]?.inbox || 0),
        sent: Number(counts[0]?.sent || 0),
    };
};
/** Die Vorgaben fürs Fenster: Server und Ports des Firmenpostfachs — meist
    liegen alle Konten auf demselben Server, dann fehlt nur das Passwort. */
const companyDefaults = async (tenantId) => {
    const settings = await prisma_client_1.default.mailSetting.findUnique({
        where: { tenantId: await (0, serviceTenantScope_1.getMailTenantId)(tenantId).catch(() => tenantId) },
        select: { smtpHost: true, smtpPort: true, smtpSecure: true, imapHost: true, imapPort: true, imapSecure: true },
    });
    return {
        smtpHost: settings?.smtpHost || null,
        smtpPort: settings?.smtpPort || 465,
        smtpSecure: settings?.smtpSecure ?? true,
        imapHost: settings?.imapHost || null,
        imapPort: settings?.imapPort || 993,
        imapSecure: settings?.imapSecure ?? true,
    };
};
const text = (value, max = 255) => {
    const clean = String(value ?? "").trim();
    return clean ? clean.slice(0, max) : null;
};
const port = (value, fallback) => {
    if (value === undefined || value === null || value === "")
        return fallback;
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : "invalid";
};
/** Leer = unverändert lassen, ausdrücklich null = löschen, sonst verschlüsseln. */
const secret = (value, existing) => {
    if (value === null)
        return null;
    const clean = String(value ?? "").trim();
    return clean ? (0, mailCrypto_1.encryptSecret)(clean) : existing ?? null;
};
/** Die Felder aus dem Formular, ergänzt um die gespeicherten. */
const readForm = (body, existing, fallbackName) => {
    const smtpPort = port(body.smtpPort, existing?.smtpPort ?? 465);
    const imapPort = port(body.imapPort, existing?.imapPort ?? 993);
    if (smtpPort === "invalid" || imapPort === "invalid")
        return { error: "Port muss zwischen 1 und 65535 liegen." };
    const fromEmail = text(body.fromEmail)?.toLowerCase() || "";
    if (!(0, mailText_1.isValidEmail)(fromEmail))
        return { error: "Bitte eine gültige E-Mail-Adresse angeben." };
    return {
        data: {
            isActive: body.isActive === undefined ? existing?.isActive ?? true : Boolean(body.isActive),
            fromName: text(body.fromName) || fallbackName,
            fromEmail,
            smtpHost: text(body.smtpHost),
            smtpPort,
            smtpSecure: body.smtpSecure === undefined ? existing?.smtpSecure ?? true : Boolean(body.smtpSecure),
            // Benutzer leer = die Adresse selbst (so melden sich fast alle Server an).
            smtpUser: text(body.smtpUser) || fromEmail,
            smtpPassword: secret(body.smtpPassword, existing?.smtpPassword),
            imapHost: text(body.imapHost),
            imapPort,
            imapSecure: body.imapSecure === undefined ? existing?.imapSecure ?? true : Boolean(body.imapSecure),
            imapUser: text(body.imapUser) || null,
            imapPassword: secret(body.imapPassword, existing?.imapPassword),
            sentFolder: text(body.sentFolder),
            imapInboxFolder: text(body.imapInboxFolder),
            imapCaptureEnabled: body.imapCaptureEnabled === undefined ? existing?.imapCaptureEnabled ?? true : Boolean(body.imapCaptureEnabled),
            imapWindowMonths: (0, ImapCaptureService_1.normalizeWindowMonths)(body.imapWindowMonths ?? existing?.imapWindowMonths),
        },
    };
};
/** Den Abruf von vorn beginnen lassen: Lesestand weg, im Hintergrund laden. */
const restartCapture = async (row, waitMs) => {
    await (0, employeeMailbox_1.employeeMailboxTable)().update({
        where: { id: row.id },
        data: {
            imapUidValidity: null, imapLastUid: 0n,
            imapSentUidValidity: null, imapSentLastUid: 0n,
            imapLastError: null, imapLastSummary: null,
        },
    });
    if (!row.imapHost?.trim() || !row.isActive)
        return null;
    // Bereits gespeicherte Nachrichten werden an ihrer Kennung erkannt und
    // nicht doppelt angelegt — der Neustart füllt nur auf.
    const run = (0, ImapCaptureService_1.captureInbox)(row.tenantId, { mailboxId: row.id }).catch((error) => {
        console.error("[MAIL] Neustart des Postfachs fehlgeschlagen:", error?.message || error);
        return null;
    });
    return Promise.race([run, new Promise((resolve) => setTimeout(() => resolve(null), waitMs))]);
};
router.get("/", AuthMiddleware_1.requireAuth, MANAGE, async (req, res) => {
    try {
        const tenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(req.user.tenantId).catch(() => [req.user.tenantId]);
        const employees = await prisma_client_1.default.employee.findMany({
            where: { tenantId: { in: tenantIds }, deletedAt: null },
            select: { id: true },
        });
        const rows = await (0, employeeMailbox_1.employeeMailboxTable)().findMany({
            where: { employeeId: { in: employees.map((row) => row.id) } },
            select: { employeeId: true, fromEmail: true, isActive: true, imapLastError: true, imapLastSyncAt: true },
        });
        res.json({ mailboxes: rows });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Postfächer konnten nicht geladen werden." });
    }
});
router.get("/:employeeId", AuthMiddleware_1.requireAuth, MANAGE, async (req, res) => {
    try {
        const employee = await findEmployee(req);
        if (!employee)
            return res.status(404).json({ error: "Person nicht gefunden." });
        const row = await (0, employeeMailbox_1.employeeMailboxTable)().findUnique({ where: { employeeId: employee.id } });
        res.json({
            employee,
            mailbox: mailboxDto(row),
            status: await statusDto(row),
            defaults: await companyDefaults(req.user.tenantId),
        });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Postfach konnte nicht geladen werden." });
    }
});
router.put("/:employeeId", AuthMiddleware_1.requireAuth, MANAGE, async (req, res) => {
    try {
        const employee = await findEmployee(req);
        if (!employee)
            return res.status(404).json({ error: "Person nicht gefunden." });
        const body = req.body || {};
        const existing = await (0, employeeMailbox_1.employeeMailboxTable)().findUnique({ where: { employeeId: employee.id } });
        const form = readForm(body, existing, `${employee.firstName} ${employee.lastName}`.trim());
        if ("error" in form)
            return res.status(400).json({ error: form.error });
        const data = form.data;
        if (!data.smtpHost && !data.imapHost)
            return res.status(400).json({ error: "Bitte mindestens den SMTP- oder IMAP-Server angeben." });
        if (!data.smtpPassword && !data.imapPassword)
            return res.status(400).json({ error: "Bitte das Passwort des Postfachs angeben." });
        /* DIE ADRESSE GILT ÜBERALL (Vorgabe: «her yerde sadece o»): auf Wunsch
           wird sie auch die Adresse der Person im System — Personalliste,
           Adressbuch, Anmeldung. Sie ist eindeutig; gehört sie schon jemand
           anderem, wird nichts gespeichert. */
        const useAsAccountEmail = body.useAsAccountEmail !== false;
        if (useAsAccountEmail && data.fromEmail !== employee.email.toLowerCase()) {
            const taken = await prisma_client_1.default.employee.findFirst({
                where: { email: data.fromEmail, NOT: { id: employee.id } },
                select: { id: true },
            });
            if (taken)
                return res.status(409).json({ error: "Diese E-Mail-Adresse gehört bereits einer anderen Person.", code: "email_taken" });
        }
        const mailTenantId = await (0, serviceTenantScope_1.getMailTenantId)(employee.tenantId).catch(() => employee.tenantId);
        /* Ein ANDERES Konto als bisher? Dann gehört die gespeicherte Post zum
           alten und fällt weg — sonst stünde fremde Post im neuen Postfach. */
        const previous = existing ? (0, mailboxIdentity_1.mailboxIdentity)(existing.imapHost, existing.imapUser, existing.smtpUser, existing.fromEmail) : "";
        const next = (0, mailboxIdentity_1.mailboxIdentity)(data.imapHost, data.imapUser, data.smtpUser, data.fromEmail);
        const changed = Boolean(previous) && previous !== next;
        const id = existing?.id || (0, nanoid_1.nanoid)(16);
        let purgedMessages = 0;
        if (changed) {
            const removed = await prisma_client_1.default.mailMessage.deleteMany({ where: { tenantId: existing.tenantId, mailboxKey: id } });
            purgedMessages = removed.count;
        }
        const row = await (0, employeeMailbox_1.employeeMailboxTable)().upsert({
            where: { employeeId: employee.id },
            update: { ...data, tenantId: mailTenantId },
            create: { id, employeeId: employee.id, tenantId: mailTenantId, ...data },
        });
        if (useAsAccountEmail && data.fromEmail !== employee.email.toLowerCase()) {
            await prisma_client_1.default.employee.update({ where: { id: employee.id }, data: { email: data.fromEmail } });
            (0, mailCustomerMatcher_1.invalidateAddressBook)(employee.tenantId);
        }
        // Alte Verbindungen und der Zwischenspeicher dürfen nicht weiterleben.
        (0, employeeMailbox_1.invalidateEmployeeMailbox)(employee.id);
        (0, NodemailerTransport_1.resetTransporters)();
        /* NEU STARTEN UND LADEN: Lesestand zurück, Abruf sofort anstossen.
           Bis zu 20 s wird gewartet — reicht das nicht (Erstabruf über zwei
           Monate), läuft er im Hintergrund weiter; das Fenster fragt nach. */
        const summary = await restartCapture(row, 20_000);
        const fresh = await (0, employeeMailbox_1.employeeMailboxTable)().findUnique({ where: { id: row.id } });
        res.json({
            mailbox: mailboxDto(fresh),
            status: await statusDto(fresh),
            summary,
            purgedMessages,
            accountEmail: useAsAccountEmail ? data.fromEmail : employee.email,
        });
    }
    catch (error) {
        res.status(400).json({ error: error?.message || "Postfach konnte nicht gespeichert werden." });
    }
});
/** Verbindung prüfen, ohne etwas zu speichern — mit den Werten des Formulars
    (leere Passwörter = die gespeicherten). */
router.post("/:employeeId/test", AuthMiddleware_1.requireAuth, MANAGE, async (req, res) => {
    try {
        const employee = await findEmployee(req);
        if (!employee)
            return res.status(404).json({ error: "Person nicht gefunden." });
        const existing = await (0, employeeMailbox_1.employeeMailboxTable)().findUnique({ where: { employeeId: employee.id } });
        const form = readForm(req.body || {}, existing, `${employee.firstName} ${employee.lastName}`.trim());
        if ("error" in form)
            return res.status(400).json({ error: form.error });
        const settings = (0, employeeMailbox_1.personalMailSettings)({ ...(existing || {}), ...form.data });
        const result = { smtp: null, imap: null };
        if (settings.smtpHost) {
            const transporter = nodemailer_1.default.createTransport({
                host: settings.smtpHost,
                port: Number(settings.smtpPort),
                secure: Boolean(settings.smtpSecure) || Number(settings.smtpPort) === 465,
                auth: { user: String(settings.smtpUser || settings.fromEmail), pass: String(settings.smtpPassword || "") },
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
                const box = await client.status(settings.imapInboxFolder || "INBOX", { messages: true });
                result.imap = { ok: true, messages: Number(box?.messages || 0) };
            }
            catch (error) {
                result.imap = { ok: false, error: String(error?.responseText || error?.message || error).slice(0, 300) };
            }
            finally {
                try {
                    await client.logout();
                }
                catch { /* egal */ }
            }
        }
        res.json(result);
    }
    catch (error) {
        res.status(400).json({ error: error?.message || "Test fehlgeschlagen." });
    }
});
router.post("/:employeeId/restart", AuthMiddleware_1.requireAuth, MANAGE, async (req, res) => {
    try {
        const employee = await findEmployee(req);
        if (!employee)
            return res.status(404).json({ error: "Person nicht gefunden." });
        const row = await (0, employeeMailbox_1.employeeMailboxTable)().findUnique({ where: { employeeId: employee.id } });
        if (!row)
            return res.status(404).json({ error: "Für diese Person ist kein Postfach eingerichtet." });
        if ((0, ImapCaptureService_1.isMailboxCaptureRunning)(row.id)) {
            return res.json({ mailbox: mailboxDto(row), status: await statusDto(row), summary: null });
        }
        (0, employeeMailbox_1.invalidateEmployeeMailbox)(employee.id);
        (0, NodemailerTransport_1.resetTransporters)();
        const summary = await restartCapture(row, 20_000);
        const fresh = await (0, employeeMailbox_1.employeeMailboxTable)().findUnique({ where: { id: row.id } });
        res.json({ mailbox: mailboxDto(fresh), status: await statusDto(fresh), summary });
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Neustart fehlgeschlagen." });
    }
});
router.delete("/:employeeId", AuthMiddleware_1.requireAuth, MANAGE, async (req, res) => {
    try {
        const employee = await findEmployee(req);
        if (!employee)
            return res.status(404).json({ error: "Person nicht gefunden." });
        const row = await (0, employeeMailbox_1.employeeMailboxTable)().findUnique({ where: { employeeId: employee.id } });
        if (!row)
            return res.status(204).send();
        // Die Post dieses Kontos gehört niemandem mehr — sie fällt mit.
        await prisma_client_1.default.mailMessage.deleteMany({ where: { tenantId: row.tenantId, mailboxKey: row.id } });
        await (0, employeeMailbox_1.employeeMailboxTable)().delete({ where: { id: row.id } });
        (0, employeeMailbox_1.invalidateEmployeeMailbox)(employee.id);
        (0, NodemailerTransport_1.resetTransporters)();
        res.status(204).send();
    }
    catch (error) {
        res.status(500).json({ error: error?.message || "Postfach konnte nicht entfernt werden." });
    }
});
exports.default = router;
//# sourceMappingURL=employeeMailbox.routes.js.map