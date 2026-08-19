import prisma from "../database/prisma.client";
import { dispatchMail } from "./outlook/MailDispatchService";
import { buildInviteHtml, buildInviteText, inviteWords, type InviteDetail } from "./calendarInviteMail";
import { brandLogoInline, brandWaveInline } from "./mailBrand";
import { kindIconInline } from "./mailKindIcons";

/**
 * AUFGABE → MAIL AN DIE VERANTWORTLICHE (19.08.2026, Vorgabe Samet).
 *
 * WER SIE BEKOMMT: ausschliesslich die Person, der die Aufgabe zugeteilt ist.
 * NICHT die Person, die sie erfasst hat — wer eine Aufgabe verteilt, weiss,
 * dass er sie verteilt hat; eine Mail an sich selbst ist nur Lärm. Sind mehrere
 * Personen verantwortlich, bekommt JEDE ihre eigene Nachricht mit ihrem Namen
 * im An-Feld: eine Aufgabe im Verteiler liest sich wie "jemand anderes macht
 * das schon".
 *
 * WIE SIE AUSSIEHT: dieselbe Karte wie die Termineinladung, aber in Grün und
 * mit dem Haken im Kreis statt dem Kalenderblatt (`kind: "TASK"`, siehe
 * calendarInviteMail.ts). Beim Überfliegen des Posteingangs entscheiden Farbe
 * und Zeichen, nicht der Betreff.
 *
 * WAS SIE NICHT IST: eine Kalender-Einladung. Eine Aufgabe hat keinen Ort,
 * keine Zeitspanne und nichts anzunehmen — sie reist deshalb OHNE iCalendar,
 * ohne ICS-Anhang und ohne UID. Wäre sie eine Einladung, stünde sie als
 * ganztägiger Termin in Outlook und würde den Kalender zumüllen.
 *
 * FEUERN UND VERGESSEN: ein stummer oder langsamer Mailserver darf das Anlegen
 * einer Aufgabe nicht scheitern lassen.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (value: unknown) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();

interface TaskRecipient { email: string; name: string }

/** Alles, was die Karte einer Aufgabe braucht — in EINER Abfrage geholt. */
const loadTask = (taskId: string) => (prisma as any).crmTask.findUnique({
    where: { id: taskId },
    select: {
        id: true,
        tenantId: true,
        kind: true,
        title: true,
        dueDate: true,
        createdByEmployeeId: true,
        customer: { select: { companyName: true } },
        contact: { select: { firstName: true, lastName: true } },
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        assignees: {
            select: { employee: { select: { id: true, firstName: true, lastName: true, email: true } } },
            orderBy: { createdAt: "asc" as const },
        },
    },
});

type LoadedTask = Awaited<ReturnType<typeof loadTask>>;

/**
 * Die Empfängerinnen: die Verantwortlichen mit brauchbarer Adresse, OHNE die
 * Person, die die Aufgabe verteilt hat. `skipEmployeeIds` sind zusätzlich die
 * Personen, die schon vorher verantwortlich waren — beim Nachtragen einer
 * weiteren Verantwortlichen soll nur diese eine Nachricht bekommen.
 */
const recipientsOf = (task: LoadedTask, skipEmployeeIds: string[]): TaskRecipient[] => {
    const skip = new Set([task.createdByEmployeeId, ...skipEmployeeIds].filter(Boolean));
    const seen = new Set<string>();
    const out: TaskRecipient[] = [];
    for (const row of task.assignees || []) {
        const employee = row.employee;
        if (!employee || skip.has(employee.id)) continue;
        const email = clean(employee.email).toLowerCase();
        if (!email || !EMAIL_RE.test(email) || seen.has(email)) continue;
        seen.add(email);
        out.push({ email, name: `${employee.firstName} ${employee.lastName}`.trim() });
    }
    return out;
};

/** Eine Aufgabenmail an EINE Person. */
const sendOne = async (
    task: LoadedTask,
    recipient: TaskRecipient,
    employeeId: string,
): Promise<boolean> => {
    const settings = await prisma.mailSetting.findUnique({ where: { tenantId: task.tenantId } });
    if (!settings?.smtpHost?.trim() || !settings?.smtpPort) return false;
    const fromEmail = clean(settings.fromEmail);
    if (!EMAIL_RE.test(fromEmail)) return false;
    // Sich selbst schreibt der Server nicht.
    if (recipient.email.toLowerCase() === fromEmail.toLowerCase()) return false;

    /* ABSENDERNAME: dasselbe wie bei der Termineinladung (siehe
       calendarMailService.ts) — im Postfach steht das System, nicht die
       Person aus den Mail-Einstellungen. Die Aufgabenmail geht ans eigene
       Haus, also in der Haussprache Deutsch, wie die Karte selbst. */
    const fromName = inviteWords("de").brand;
    const assignedBy = task.createdBy
        ? `${task.createdBy.firstName} ${task.createdBy.lastName}`.trim()
        : "";
    const contactName = task.contact
        ? `${task.contact.firstName ?? ""} ${task.contact.lastName ?? ""}`.trim()
        : "";
    const details: InviteDetail[] = [
        task.customer?.companyName ? { label: "Kunde", value: task.customer.companyName } : null,
        contactName ? { label: "Ansprechpartner", value: contactName } : null,
        assignedBy ? { label: "Zugeteilt von", value: assignedBy } : null,
    ].filter((row): row is InviteDetail => row !== null);

    const due = task.dueDate ? new Date(task.dueDate) : null;
    const card = {
        kind: "TASK" as const,
        method: "REQUEST" as const,
        /* Jede dieser Mails ist für IHRE Empfängerin eine neue Zuteilung —
           auch die, die beim Nachtragen einer weiteren Verantwortlichen an
           einer längst bestehenden Aufgabe rausgeht. "Geändert" stünde da
           falsch: für diese Person ist nichts geändert worden, sie hat die
           Aufgabe eben erst bekommen. */
        sequence: 0,
        audience: "TEAM" as const,
        start: due ?? new Date(),
        end: due ?? new Date(),
        hideDate: !due,
        summary: task.title,
        location: null,
        details,
        notes: null,
        message: null,
        senderName: fromName,
        // EINE Empfängerin je Nachricht — also darf die Karte sie ansprechen.
        greetingName: recipient.name || null,
    };

    await dispatchMail(
        { tenantId: task.tenantId, employeeId },
        settings,
        {
            fromEmail,
            fromName,
            to: recipient.email,
            cc: [],
            subject: `Neue Aufgabe: ${task.title}`,
            text: buildInviteText(card),
            html: buildInviteHtml(card),
            replyTo: settings.replyTo || null,
            inlineImages: [brandLogoInline(), brandWaveInline(), kindIconInline("TASK")],
            // KEIN iCalendar und KEIN ICS-Anhang: eine Aufgabe ist kein Termin.
        },
        /* Interne Post — sie gehört nicht in den Schriftverkehr des Kunden,
           auch wenn die Aufgabe an einem Kunden hängt. */
        { record: null },
    );
    return true;
};

/**
 * DIE ZUTEILUNGSMAIL (feuern und vergessen).
 *
 * @param skipEmployeeIds Verantwortliche, die schon vorher an der Aufgabe
 *   hingen — beim Nachtragen bekommt nur die neue Person Post.
 */
export const queueTaskAssignmentMail = (
    taskId: string,
    employeeId: string,
    options: { skipEmployeeIds?: string[] } = {},
): void => {
    void (async () => {
        const task = await loadTask(taskId);
        // Erinnerungen sind keine Aufgaben — sie poppen im ERP auf, sie schreiben nicht.
        if (!task || task.kind !== "TASK") return;
        /* Übersprungen wird auch die HANDELNDE Person: verteilt jemand eine
           Aufgabe an sich selbst mit, weiss er das bereits. */
        const recipients = recipientsOf(task, [employeeId, ...(options.skipEmployeeIds ?? [])]);
        if (!recipients.length) return;
        for (const recipient of recipients) {
            await sendOne(task, recipient, employeeId)
                .catch((error: any) => {
                    console.error(`[AUFGABE] Mail an ${recipient.email} fehlgeschlagen:`, error?.message || error);
                    return false;
                });
        }
    })().catch((error: any) => console.error(`[AUFGABE] Mail ${taskId} fehlgeschlagen:`, error?.message || error));
};
