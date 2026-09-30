import { Router, type Request } from "express";
import { nanoid } from "nanoid";
import nodemailer from "nodemailer";
import { requireAuth } from "../middlewares/AuthMiddleware";
import { requireAnyPermission } from "../middlewares/RbacMiddleware";
import prisma from "../../infrastructure/database/prisma.client";
import { encryptSecret } from "../../infrastructure/services/outlook/mailCrypto";
import { invalidateAddressBook } from "../../infrastructure/services/outlook/mailCustomerMatcher";
import { isValidEmail } from "../../infrastructure/services/outlook/mailText";
import { resetTransporters } from "../../infrastructure/services/NodemailerTransport";
import { mailboxIdentity } from "../../infrastructure/services/mailboxIdentity";
import {
    buildImapClient,
    captureInbox,
    isMailboxCaptureRunning,
    normalizeWindowMonths,
} from "../../infrastructure/services/ImapCaptureService";
import {
    employeeMailboxTable,
    invalidateEmployeeMailbox,
    personalMailSettings,
    type EmployeeMailboxRow,
} from "../../infrastructure/services/employeeMailbox";
import { getCompanyTreeTenantIds, getMailTenantId } from "../controllers/serviceTenantScope";

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

const router = Router();
const MANAGE = requireAnyPermission(["mail.manage", "employees.update"]);

/** Die Person — nur aus dem eigenen Firmenbaum. */
const findEmployee = async (req: Request) => {
    const tenantIds = await getCompanyTreeTenantIds(req.user!.tenantId).catch(() => [req.user!.tenantId]);
    return prisma.employee.findFirst({
        where: { id: String(req.params.employeeId), tenantId: { in: tenantIds.length ? tenantIds : [req.user!.tenantId] }, deletedAt: null },
        select: { id: true, tenantId: true, firstName: true, lastName: true, email: true },
    });
};

const mailboxDto = (row: EmployeeMailboxRow | null) => row ? {
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
    imapWindowMonths: normalizeWindowMonths(row.imapWindowMonths),
} : null;

const statusDto = async (row: EmployeeMailboxRow | null) => {
    if (!row) return null;
    const counts = await prisma.$queryRaw<Array<{ inbox: bigint | number | null; sent: bigint | number | null }>>`
        SELECT SUM(m.direction = 'IN') AS inbox, SUM(m.direction = 'OUT') AS sent
          FROM MailMessage m
         WHERE m.tenantId = ${row.tenantId} AND m.mailboxKey = ${row.id} AND m.deletedAt IS NULL`;
    return {
        running: isMailboxCaptureRunning(row.id),
        lastSyncAt: row.imapLastSyncAt,
        lastSummary: row.imapLastSummary,
        lastError: row.imapLastError,
        inbox: Number(counts[0]?.inbox || 0),
        sent: Number(counts[0]?.sent || 0),
    };
};

/** Die Vorgaben fürs Fenster: Server und Ports des Firmenpostfachs — meist
    liegen alle Konten auf demselben Server, dann fehlt nur das Passwort. */
/* Ohne Firmenpostfach gilt der Server des Hauses (cyon, Vorgabe 29.09.2026):
   im Fenster tippt die Verwaltung dann nur noch Adresse und Passwort. */
const DEFAULT_MAIL_HOST = "mail.cyon.ch";

const companyDefaults = async (tenantId: string) => {
    const settings = await prisma.mailSetting.findUnique({
        where: { tenantId: await getMailTenantId(tenantId).catch(() => tenantId) },
        select: { smtpHost: true, smtpPort: true, smtpSecure: true, imapHost: true, imapPort: true, imapSecure: true },
    });
    return {
        smtpHost: settings?.smtpHost || DEFAULT_MAIL_HOST,
        smtpPort: settings?.smtpPort || 465,
        smtpSecure: settings?.smtpSecure ?? true,
        imapHost: settings?.imapHost || DEFAULT_MAIL_HOST,
        imapPort: settings?.imapPort || 993,
        imapSecure: settings?.imapSecure ?? true,
    };
};

const text = (value: unknown, max = 255): string | null => {
    const clean = String(value ?? "").trim();
    return clean ? clean.slice(0, max) : null;
};
const port = (value: unknown, fallback: number): number | "invalid" => {
    if (value === undefined || value === null || value === "") return fallback;
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : "invalid";
};
/** Leer = unverändert lassen, ausdrücklich null = löschen, sonst verschlüsseln. */
const secret = (value: unknown, existing: string | null | undefined): string | null => {
    if (value === null) return null;
    const clean = String(value ?? "").trim();
    return clean ? encryptSecret(clean) : existing ?? null;
};

/** Die Felder aus dem Formular, ergänzt um die gespeicherten. */
const readForm = (body: any, existing: EmployeeMailboxRow | null, fallbackName: string) => {
    const smtpPort = port(body.smtpPort, existing?.smtpPort ?? 465);
    const imapPort = port(body.imapPort, existing?.imapPort ?? 993);
    if (smtpPort === "invalid" || imapPort === "invalid") return { error: "Port muss zwischen 1 und 65535 liegen." } as const;
    const fromEmail = text(body.fromEmail)?.toLowerCase() || "";
    if (!isValidEmail(fromEmail)) return { error: "Bitte eine gültige E-Mail-Adresse angeben." } as const;
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
            imapWindowMonths: normalizeWindowMonths(body.imapWindowMonths ?? existing?.imapWindowMonths),
        },
    } as const;
};

/** Den Abruf von vorn beginnen lassen: Lesestand weg, im Hintergrund laden. */
const restartCapture = async (row: EmployeeMailboxRow, waitMs: number) => {
    await employeeMailboxTable().update({
        where: { id: row.id },
        data: {
            imapUidValidity: null, imapLastUid: 0n,
            imapSentUidValidity: null, imapSentLastUid: 0n,
            imapLastError: null, imapLastSummary: null,
        },
    });
    if (!row.imapHost?.trim() || !row.isActive) return null;
    // Bereits gespeicherte Nachrichten werden an ihrer Kennung erkannt und
    // nicht doppelt angelegt — der Neustart füllt nur auf.
    const run = captureInbox(row.tenantId, { mailboxId: row.id }).catch((error: any) => {
        console.error("[MAIL] Neustart des Postfachs fehlgeschlagen:", error?.message || error);
        return null;
    });
    return Promise.race([run, new Promise<null>((resolve) => setTimeout(() => resolve(null), waitMs))]);
};

router.get("/", requireAuth, MANAGE, async (req, res) => {
    try {
        const tenantIds = await getCompanyTreeTenantIds(req.user!.tenantId).catch(() => [req.user!.tenantId]);
        const employees = await prisma.employee.findMany({
            where: { tenantId: { in: tenantIds }, deletedAt: null },
            select: { id: true },
        });
        const rows = await employeeMailboxTable().findMany({
            where: { employeeId: { in: employees.map((row) => row.id) } },
            select: { employeeId: true, fromEmail: true, isActive: true, imapLastError: true, imapLastSyncAt: true },
        });
        res.json({ mailboxes: rows });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || "Postfächer konnten nicht geladen werden." });
    }
});

router.get("/:employeeId", requireAuth, MANAGE, async (req, res) => {
    try {
        const employee = await findEmployee(req);
        if (!employee) return res.status(404).json({ error: "Person nicht gefunden." });
        const row = await employeeMailboxTable().findUnique({ where: { employeeId: employee.id } }) as EmployeeMailboxRow | null;
        res.json({
            employee,
            mailbox: mailboxDto(row),
            status: await statusDto(row),
            defaults: await companyDefaults(req.user!.tenantId),
        });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || "Postfach konnte nicht geladen werden." });
    }
});

router.put("/:employeeId", requireAuth, MANAGE, async (req, res) => {
    try {
        const employee = await findEmployee(req);
        if (!employee) return res.status(404).json({ error: "Person nicht gefunden." });
        const body = req.body || {};
        const existing = await employeeMailboxTable().findUnique({ where: { employeeId: employee.id } }) as EmployeeMailboxRow | null;
        const form = readForm(body, existing, `${employee.firstName} ${employee.lastName}`.trim());
        if ("error" in form) return res.status(400).json({ error: form.error });
        const data = form.data;
        if (!data.smtpHost && !data.imapHost) return res.status(400).json({ error: "Bitte mindestens den SMTP- oder IMAP-Server angeben." });
        if (!data.smtpPassword && !data.imapPassword) return res.status(400).json({ error: "Bitte das Passwort des Postfachs angeben." });

        /* DIE ADRESSE GILT ÜBERALL (Vorgabe: «her yerde sadece o»): auf Wunsch
           wird sie auch die Adresse der Person im System — Personalliste,
           Adressbuch, Anmeldung. Sie ist eindeutig; gehört sie schon jemand
           anderem, wird nichts gespeichert. */
        const useAsAccountEmail = body.useAsAccountEmail !== false;
        if (useAsAccountEmail && data.fromEmail !== employee.email.toLowerCase()) {
            const taken = await prisma.employee.findFirst({
                where: { email: data.fromEmail, NOT: { id: employee.id } },
                select: { id: true },
            });
            if (taken) return res.status(409).json({ error: "Diese E-Mail-Adresse gehört bereits einer anderen Person.", code: "email_taken" });
        }

        const mailTenantId = await getMailTenantId(employee.tenantId).catch(() => employee.tenantId);
        /* Ein ANDERES Konto als bisher? Dann gehört die gespeicherte Post zum
           alten und fällt weg — sonst stünde fremde Post im neuen Postfach. */
        const previous = existing ? mailboxIdentity(existing.imapHost, existing.imapUser, existing.smtpUser, existing.fromEmail) : "";
        const next = mailboxIdentity(data.imapHost, data.imapUser, data.smtpUser, data.fromEmail);
        const changed = Boolean(previous) && previous !== next;

        const id = existing?.id || nanoid(16);
        let purgedMessages = 0;
        if (changed) {
            const removed = await prisma.mailMessage.deleteMany({ where: { tenantId: existing!.tenantId, mailboxKey: id } as any });
            purgedMessages = removed.count;
        }
        const row = await employeeMailboxTable().upsert({
            where: { employeeId: employee.id },
            update: { ...data, tenantId: mailTenantId },
            create: { id, employeeId: employee.id, tenantId: mailTenantId, ...data },
        }) as EmployeeMailboxRow;

        if (useAsAccountEmail && data.fromEmail !== employee.email.toLowerCase()) {
            await prisma.employee.update({ where: { id: employee.id }, data: { email: data.fromEmail } });
            invalidateAddressBook(employee.tenantId);
        }

        // Alte Verbindungen und der Zwischenspeicher dürfen nicht weiterleben.
        invalidateEmployeeMailbox(employee.id);
        resetTransporters();

        /* NEU STARTEN UND LADEN: Lesestand zurück, Abruf sofort anstossen.
           Bis zu 20 s wird gewartet — reicht das nicht (Erstabruf über zwei
           Monate), läuft er im Hintergrund weiter; das Fenster fragt nach. */
        const summary = await restartCapture(row, 20_000);
        const fresh = await employeeMailboxTable().findUnique({ where: { id: row.id } }) as EmployeeMailboxRow;
        res.json({
            mailbox: mailboxDto(fresh),
            status: await statusDto(fresh),
            summary,
            purgedMessages,
            accountEmail: useAsAccountEmail ? data.fromEmail : employee.email,
        });
    } catch (error: any) {
        res.status(400).json({ error: error?.message || "Postfach konnte nicht gespeichert werden." });
    }
});

/** Verbindung prüfen, ohne etwas zu speichern — mit den Werten des Formulars
    (leere Passwörter = die gespeicherten). */
router.post("/:employeeId/test", requireAuth, MANAGE, async (req, res) => {
    try {
        const employee = await findEmployee(req);
        if (!employee) return res.status(404).json({ error: "Person nicht gefunden." });
        const existing = await employeeMailboxTable().findUnique({ where: { employeeId: employee.id } }) as EmployeeMailboxRow | null;
        const form = readForm(req.body || {}, existing, `${employee.firstName} ${employee.lastName}`.trim());
        if ("error" in form) return res.status(400).json({ error: form.error });
        const settings = personalMailSettings({ ...(existing || {} as EmployeeMailboxRow), ...form.data } as EmployeeMailboxRow);

        const result: { smtp: { ok: boolean; error?: string } | null; imap: { ok: boolean; error?: string; messages?: number } | null } = { smtp: null, imap: null };
        if (settings.smtpHost) {
            const transporter = nodemailer.createTransport({
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
            } catch (error: any) {
                result.smtp = { ok: false, error: String(error?.message || error).slice(0, 300) };
            } finally {
                transporter.close();
            }
        }
        if (settings.imapHost) {
            const client = buildImapClient(settings as any);
            try {
                await client.connect();
                const box: any = await client.status(settings.imapInboxFolder || "INBOX", { messages: true });
                result.imap = { ok: true, messages: Number(box?.messages || 0) };
            } catch (error: any) {
                result.imap = { ok: false, error: String(error?.responseText || error?.message || error).slice(0, 300) };
            } finally {
                try { await client.logout(); } catch { /* egal */ }
            }
        }
        res.json(result);
    } catch (error: any) {
        res.status(400).json({ error: error?.message || "Test fehlgeschlagen." });
    }
});

router.post("/:employeeId/restart", requireAuth, MANAGE, async (req, res) => {
    try {
        const employee = await findEmployee(req);
        if (!employee) return res.status(404).json({ error: "Person nicht gefunden." });
        const row = await employeeMailboxTable().findUnique({ where: { employeeId: employee.id } }) as EmployeeMailboxRow | null;
        if (!row) return res.status(404).json({ error: "Für diese Person ist kein Postfach eingerichtet." });
        if (isMailboxCaptureRunning(row.id)) {
            return res.json({ mailbox: mailboxDto(row), status: await statusDto(row), summary: null });
        }
        invalidateEmployeeMailbox(employee.id);
        resetTransporters();
        const summary = await restartCapture(row, 20_000);
        const fresh = await employeeMailboxTable().findUnique({ where: { id: row.id } }) as EmployeeMailboxRow;
        res.json({ mailbox: mailboxDto(fresh), status: await statusDto(fresh), summary });
    } catch (error: any) {
        res.status(500).json({ error: error?.message || "Neustart fehlgeschlagen." });
    }
});

router.delete("/:employeeId", requireAuth, MANAGE, async (req, res) => {
    try {
        const employee = await findEmployee(req);
        if (!employee) return res.status(404).json({ error: "Person nicht gefunden." });
        const row = await employeeMailboxTable().findUnique({ where: { employeeId: employee.id } }) as EmployeeMailboxRow | null;
        if (!row) return res.status(204).send();
        // Die Post dieses Kontos gehört niemandem mehr — sie fällt mit.
        await prisma.mailMessage.deleteMany({ where: { tenantId: row.tenantId, mailboxKey: row.id } as any });
        await employeeMailboxTable().delete({ where: { id: row.id } });
        invalidateEmployeeMailbox(employee.id);
        resetTransporters();
        res.status(204).send();
    } catch (error: any) {
        res.status(500).json({ error: error?.message || "Postfach konnte nicht entfernt werden." });
    }
});

export default router;
