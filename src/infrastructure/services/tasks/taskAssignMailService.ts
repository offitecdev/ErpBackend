import { Prisma } from "@prisma/client";

import prisma from "../../database/prisma.client";
import { getMailTenantId } from "../../../presentation/controllers/serviceTenantScope";
import { formatInviteDate, inviteWords } from "../calendarInviteMail";
import { brandLogoInline } from "../mailBrand";
import { dispatchMail } from "../outlook/MailDispatchService";
import { TASK_MAIL_BLUE, buildTaskMailHtml, buildTaskMailText, type TaskMailCardInput, type TaskMailRow } from "./taskMailCard";

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

const LANGUAGE = "tr" as const;
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
} as const;

const PRIORITY_TR: Record<string, string> = { LOW: "Düşük", MEDIUM: "Orta", HIGH: "Yüksek" };

const clean = (value: unknown): string => String(value ?? "").replace(/[\r\n]+/g, " ").trim();

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export interface TaskAssignmentMailInput {
    tenantId: string;
    taskId: string;
    /** Wer zugeteilt hat — bekommt selbst nie Post. */
    actorId: string;
    /** Die NEU verantwortlichen Personen. */
    employeeIds: readonly string[];
}

interface MailPerson {
    id: string;
    name: string;
    email: string;
}

/** Aktive Personen mit brauchbarer Adresse; wer gegangen ist, bekommt nichts. */
const loadPeople = async (employeeIds: readonly string[]): Promise<Map<string, MailPerson>> => {
    const ids = [...new Set(employeeIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const rows = await prisma.$queryRaw<Array<{ id: string; firstName: string | null; lastName: string | null; email: string | null }>>(Prisma.sql`
        SELECT id, firstName, lastName, email
        FROM Employee
        WHERE id IN (${Prisma.join(ids)}) AND isActive = 1 AND deletedAt IS NULL
    `);
    const people = new Map<string, MailPerson>();
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
const loadTask = (tenantId: string, taskId: string) => prisma.task.findFirst({
    where: { id: taskId, tenantId },
    select: {
        id: true,
        tenantId: true,
        title: true,
        description: true,
        priority: true,
        startAt: true,
        dueAt: true,
        assignees: { select: { employeeId: true }, orderBy: { createdAt: "asc" as const } },
        labelLinks: { select: { label: { select: { name: true } } } },
    },
});

type LoadedTask = NonNullable<Awaited<ReturnType<typeof loadTask>>>;

/** Die Zeile aus `MailSetting`, so wie `dispatchMail` sie erwartet. */
type MailSettingsRow = NonNullable<Awaited<ReturnType<typeof prisma.mailSetting.findUnique>>>;

/**
 * Die Zeilen der Karte. «Başlangıç» steht nur da, wenn die Aufgabe erst später
 * anfängt — jede Aufgabe trägt einen Anfang, meist den Augenblick des Anlegens,
 * und «heute» als eigene Zeile sagt nichts.
 */
const detailRows = (
    task: LoadedTask,
    recipient: MailPerson,
    actorName: string,
    people: Map<string, MailPerson>,
    now: Date,
): TaskMailRow[] => {
    const partners = task.assignees
        .map((row) => row.employeeId)
        .filter((id) => id !== recipient.id)
        .map((id) => people.get(id)?.name ?? "")
        .filter(Boolean);
    const labels = task.labelLinks.map((link) => clean(link.label?.name)).filter(Boolean);
    const rows: Array<TaskMailRow | null> = [
        actorName ? { label: ROW.assignedBy, value: actorName } : null,
        { label: ROW.priority, value: PRIORITY_TR[task.priority] ?? PRIORITY_TR.MEDIUM! },
        task.startAt && task.startAt.getTime() > now.getTime()
            ? { label: ROW.start, value: formatInviteDate(task.startAt, LANGUAGE) }
            : null,
        labels.length ? { label: ROW.labels, value: labels.join(", ") } : null,
        partners.length ? { label: ROW.partners, value: partners.join(", ") } : null,
    ];
    return rows.filter((row): row is TaskMailRow => row !== null);
};

/** Betreff und Karte — auch fuer die Vorschau, damit geprueft wird, was wirklich rausgeht. */
export const taskAssignmentSubject = (title: string): string => `Yeni görev: ${title}`;

export const taskAssignmentCard = (
    task: Pick<LoadedTask, 'id' | 'title' | 'description' | 'dueAt'>,
    recipientName: string,
    rows: TaskMailRow[],
): TaskMailCardInput => {
    const words = inviteWords(LANGUAGE);
    return {
        brand: words.brand,
        kicker: "Yeni görev",
        accent: TASK_MAIL_BLUE,
        heading: task.title,
        // Ohne Fälligkeit kein Kalenderblatt: ein erfundener Tag wäre schlimmer als keiner.
        date: task.dueAt ? { at: task.dueAt, label: ROW.due, text: formatInviteDate(task.dueAt, LANGUAGE) } : null,
        // EINE Empfängerin je Nachricht — also darf die Karte sie ansprechen.
        greeting: recipientName ? `${words.greeting} ${recipientName},` : `${words.greeting},`,
        lead: "Bu görev size atandı.",
        quote: task.description ? clip(task.description.trim(), NOTES_MAX) : null,
        rows,
        button: { label: "Görevi aç", href: `${APP_URL()}/tasks/${encodeURIComponent(task.id)}` },
        footer: words.autoNoticeTask,
    };
};

/** Eine Karte an EINE Person. */
const sendOne = async (
    task: LoadedTask,
    recipient: MailPerson,
    rows: TaskMailRow[],
    settings: MailSettingsRow,
    fromEmail: string,
    actorId: string,
): Promise<void> => {
    const card = taskAssignmentCard(task, recipient.name, rows);
    await dispatchMail(
        { tenantId: task.tenantId, employeeId: actorId },
        settings,
        {
            fromEmail,
            fromName: card.brand,
            to: recipient.email,
            cc: [],
            subject: taskAssignmentSubject(task.title),
            text: buildTaskMailText(card),
            html: buildTaskMailHtml(card),
            replyTo: settings.replyTo || null,
            inlineImages: [brandLogoInline()],
        },
        { record: null },
    );
};

/**
 * DIE ZUTEILUNGSMAIL (feuern und vergessen). Ruft `taskService` überall dort,
 * wo jemand NEU verantwortlich wird: anlegen, duplizieren, Verantwortliche
 * setzen, «Ortak ekle».
 */
export const queueTaskAssignmentMail = (input: TaskAssignmentMailInput): void => {
    void (async () => {
        const wanted = [...new Set(input.employeeIds)].filter((id) => id && id !== input.actorId);
        if (!wanted.length) return;

        const [task, settings] = await Promise.all([
            loadTask(input.tenantId, input.taskId),
            getMailTenantId(input.tenantId).then((tenantId) => prisma.mailSetting.findUnique({ where: { tenantId } })),
        ]);
        if (!task) return;
        if (!settings?.smtpHost?.trim() || !settings?.smtpPort) return;
        const fromEmail = clean(settings.fromEmail);
        if (!EMAIL_RE.test(fromEmail)) return;

        // Namen der Zeilen: die Empfängerinnen, die handelnde Person und die übrigen Verantwortlichen.
        const people = await loadPeople([...wanted, input.actorId, ...task.assignees.map((row) => row.employeeId)]);
        const actorName = people.get(input.actorId)?.name ?? "";
        const now = new Date();
        const seen = new Set<string>();

        for (const employeeId of wanted) {
            const recipient = people.get(employeeId);
            if (!recipient?.email || !EMAIL_RE.test(recipient.email)) continue;
            // Sich selbst schreibt der Server nicht, und niemandem zweimal.
            if (recipient.email === fromEmail.toLowerCase() || seen.has(recipient.email)) continue;
            seen.add(recipient.email);
            await sendOne(
                task,
                recipient,
                detailRows(task, recipient, actorName, people, now),
                settings,
                fromEmail,
                input.actorId,
            ).catch((error: unknown) => {
                console.error(`[GÖREV] Mail an ${recipient.email} fehlgeschlagen:`, (error as Error)?.message || error);
            });
        }
    })().catch((error: unknown) => {
        console.error(`[GÖREV] Zuteilungsmail ${input.taskId} fehlgeschlagen:`, (error as Error)?.message || error);
    });
};
