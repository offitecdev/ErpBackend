"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.queueTaskAssignmentMail = exports.taskAssignmentCard = exports.taskAssignmentSubject = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../database/prisma.client"));
const serviceTenantScope_1 = require("../../../presentation/controllers/serviceTenantScope");
const calendarInviteMail_1 = require("../calendarInviteMail");
const mailBrand_1 = require("../mailBrand");
const MailDispatchService_1 = require("../outlook/MailDispatchService");
const taskMailCard_1 = require("./taskMailCard");
/**
 * ── «SİZE GÖREV ATANDI» (16.09.2026, Vorgabe Samet) ─────────────────────────
 *
 * Wer im Modul «Görevler» eine Aufgabe bekommt, bekommt AUCH eine Mail — die
 * schlichte macOS-Karte des Moduls (taskMailCard.ts, seit 16.09.2026 statt der
 * grünen Terminkarte mit Welle). Die Meldung
 * in der Glocke sieht nur, wer gerade angemeldet ist; die Karte liegt am
 * Morgen im Posteingang.
 *
 * WER SIE BEKOMMT: ausschliesslich die Personen, die NEU verantwortlich
 * geworden sind — nie die Person, die zugeteilt hat (sie weiss es), und jede
 * mit ihrer EIGENEN Nachricht und ihrem Namen im An-Feld. Eine Aufgabe im
 * Verteiler liest sich wie «jemand anderes macht das schon».
 *
 * SPRACHE TÜRKISCH: das Modul ist türkisch geführt («Görevler», «Tamamlandı»,
 * «Gecikme açıklaması»), und Samet hat den Satz selbst so vorgegeben. Die
 * Wortliste der Karte kennt Türkisch bereits; die Zeilenbezeichnungen dieses
 * Moduls stehen darum hier.
 *
 * KEIN iCalendar, KEIN ICS: eine Aufgabe ist kein Termin. Sie hat einen Tag,
 * an dem sie fällig ist, sonst nichts, was in einen Kalender gehört.
 *
 * KEIN `MailMessage`-Eintrag: interne Post gehört in keinen Schriftverkehr.
 *
 * FEUERN UND VERGESSEN: ein stummer oder langsamer Mailserver darf das
 * Anlegen oder Zuteilen einer Aufgabe nicht scheitern lassen.
 */
const LANGUAGE = "tr";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Die Beschreibung ist die Notiz der Karte — eine Karte, kein Aufsatz. */
const NOTES_MAX = 600;
const APP_URL = () => (process.env.OFFITEC_APP_URL || "https://demo.offitec.ch").replace(/\/$/, "");
/** Bezeichnungen der Zeilen (türkisch, nur dieses Modul). */
const ROW = {
    assignedBy: "Atayan",
    due: "Son tarih",
    priority: "Öncelik",
    start: "Başlangıç",
    labels: "Etiketler",
    partners: "Diğer sorumlular",
};
const PRIORITY_TR = { LOW: "Düşük", MEDIUM: "Orta", HIGH: "Yüksek" };
const clean = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();
const clip = (value, max) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
/** Aktive Personen mit brauchbarer Adresse; wer gegangen ist, bekommt nichts. */
const loadPeople = async (employeeIds) => {
    const ids = [...new Set(employeeIds.filter(Boolean))];
    if (!ids.length)
        return new Map();
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT id, firstName, lastName, email
        FROM Employee
        WHERE id IN (${client_1.Prisma.join(ids)}) AND isActive = 1 AND deletedAt IS NULL
    `);
    const people = new Map();
    for (const row of rows) {
        people.set(row.id, {
            id: row.id,
            name: `${clean(row.firstName)} ${clean(row.lastName)}`.trim(),
            email: clean(row.email).toLowerCase(),
        });
    }
    return people;
};
/** Alles, was die Karte einer Aufgabe braucht — in EINER Abfrage. */
const loadTask = (tenantId, taskId) => prisma_client_1.default.task.findFirst({
    where: { id: taskId, tenantId },
    select: {
        id: true,
        tenantId: true,
        title: true,
        description: true,
        priority: true,
        startAt: true,
        dueAt: true,
        assignees: { select: { employeeId: true }, orderBy: { createdAt: "asc" } },
        labelLinks: { select: { label: { select: { name: true } } } },
    },
});
/**
 * Die Zeilen der Karte. «Başlangıç» steht nur da, wenn die Aufgabe erst später
 * anfängt — jede Aufgabe trägt einen Anfang, meist den Augenblick des Anlegens,
 * und «heute» als eigene Zeile sagt nichts.
 */
const detailRows = (task, recipient, actorName, people, now) => {
    const partners = task.assignees
        .map((row) => row.employeeId)
        .filter((id) => id !== recipient.id)
        .map((id) => people.get(id)?.name ?? "")
        .filter(Boolean);
    const labels = task.labelLinks.map((link) => clean(link.label?.name)).filter(Boolean);
    const rows = [
        actorName ? { label: ROW.assignedBy, value: actorName } : null,
        { label: ROW.priority, value: PRIORITY_TR[task.priority] ?? PRIORITY_TR.MEDIUM },
        task.startAt && task.startAt.getTime() > now.getTime()
            ? { label: ROW.start, value: (0, calendarInviteMail_1.formatInviteDate)(task.startAt, LANGUAGE) }
            : null,
        labels.length ? { label: ROW.labels, value: labels.join(", ") } : null,
        partners.length ? { label: ROW.partners, value: partners.join(", ") } : null,
    ];
    return rows.filter((row) => row !== null);
};
/** Betreff und Karte — auch fuer die Vorschau, damit geprueft wird, was wirklich rausgeht. */
const taskAssignmentSubject = (title) => `Yeni görev: ${title}`;
exports.taskAssignmentSubject = taskAssignmentSubject;
const taskAssignmentCard = (task, recipientName, rows) => {
    const words = (0, calendarInviteMail_1.inviteWords)(LANGUAGE);
    return {
        brand: words.brand,
        kicker: "Yeni görev",
        accent: taskMailCard_1.TASK_MAIL_BLUE,
        heading: task.title,
        // Ohne Fälligkeit kein Kalenderblatt: ein erfundener Tag wäre schlimmer als keiner.
        date: task.dueAt ? { at: task.dueAt, label: ROW.due, text: (0, calendarInviteMail_1.formatInviteDate)(task.dueAt, LANGUAGE) } : null,
        // EINE Empfängerin je Nachricht — also darf die Karte sie ansprechen.
        greeting: recipientName ? `${words.greeting} ${recipientName},` : `${words.greeting},`,
        lead: "Bu görev size atandı.",
        quote: task.description ? clip(task.description.trim(), NOTES_MAX) : null,
        rows,
        button: { label: "Görevi aç", href: `${APP_URL()}/tasks/${encodeURIComponent(task.id)}` },
        footer: words.autoNoticeTask,
    };
};
exports.taskAssignmentCard = taskAssignmentCard;
/** Eine Karte an EINE Person. */
const sendOne = async (task, recipient, rows, settings, fromEmail, actorId) => {
    const card = (0, exports.taskAssignmentCard)(task, recipient.name, rows);
    await (0, MailDispatchService_1.dispatchMail)({ tenantId: task.tenantId, employeeId: actorId }, settings, {
        fromEmail,
        fromName: card.brand,
        to: recipient.email,
        cc: [],
        subject: (0, exports.taskAssignmentSubject)(task.title),
        text: (0, taskMailCard_1.buildTaskMailText)(card),
        html: (0, taskMailCard_1.buildTaskMailHtml)(card),
        replyTo: settings.replyTo || null,
        inlineImages: [(0, mailBrand_1.brandLogoInline)()],
    }, { record: null });
};
/**
 * DIE ZUTEILUNGSMAIL (feuern und vergessen). Ruft `taskService` überall dort,
 * wo jemand NEU verantwortlich wird: anlegen, duplizieren, Verantwortliche
 * setzen, «Ortak ekle».
 */
const queueTaskAssignmentMail = (input) => {
    void (async () => {
        const wanted = [...new Set(input.employeeIds)].filter((id) => id && id !== input.actorId);
        if (!wanted.length)
            return;
        const [task, settings] = await Promise.all([
            loadTask(input.tenantId, input.taskId),
            (0, serviceTenantScope_1.getMailTenantId)(input.tenantId).then((tenantId) => prisma_client_1.default.mailSetting.findUnique({ where: { tenantId } })),
        ]);
        if (!task)
            return;
        if (!settings?.smtpHost?.trim() || !settings?.smtpPort)
            return;
        const fromEmail = clean(settings.fromEmail);
        if (!EMAIL_RE.test(fromEmail))
            return;
        // Namen der Zeilen: die Empfängerinnen, die handelnde Person und die übrigen Verantwortlichen.
        const people = await loadPeople([...wanted, input.actorId, ...task.assignees.map((row) => row.employeeId)]);
        const actorName = people.get(input.actorId)?.name ?? "";
        const now = new Date();
        const seen = new Set();
        for (const employeeId of wanted) {
            const recipient = people.get(employeeId);
            if (!recipient?.email || !EMAIL_RE.test(recipient.email))
                continue;
            // Sich selbst schreibt der Server nicht, und niemandem zweimal.
            if (recipient.email === fromEmail.toLowerCase() || seen.has(recipient.email))
                continue;
            seen.add(recipient.email);
            await sendOne(task, recipient, detailRows(task, recipient, actorName, people, now), settings, fromEmail, input.actorId).catch((error) => {
                console.error(`[GÖREV] Mail an ${recipient.email} fehlgeschlagen:`, error?.message || error);
            });
        }
    })().catch((error) => {
        console.error(`[GÖREV] Zuteilungsmail ${input.taskId} fehlgeschlagen:`, error?.message || error);
    });
};
exports.queueTaskAssignmentMail = queueTaskAssignmentMail;
//# sourceMappingURL=taskAssignMailService.js.map