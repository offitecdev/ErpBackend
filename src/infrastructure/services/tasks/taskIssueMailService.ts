import prisma from "../../database/prisma.client";
import { dispatchMail } from "../outlook/MailDispatchService";
import { inviteWords } from "../calendarInviteMail";
import { brandLogoInline } from "../mailBrand";
import { TASK_MAIL_BLUE, TASK_MAIL_RED, buildTaskMailHtml, buildTaskMailText, type TaskMailCardInput } from "./taskMailCard";
import { getMailTenantId } from "../../../presentation/controllers/serviceTenantScope";

/**
 * SORU / SORUN → MAIL ALS OCC-KARTE (16.09.2026, Vorgabe Samet).
 *
 *   «mail olarak da etiketlenen kişi ve kişiler ilk kişi normal diğer kişi cc
 *    olarak gider … mailde bir kart olması lazım, OCC kart içinde soru
 *    yazacak, üstünde label olacak … bir de ünlem belirteci koyarsanız önemli
 *    olur ve önemli mail olarak gider, ünlem işareti olur mailde»
 *
 * EINE Nachricht je Faden, nicht eine je Person: die ERSTE markierte Person
 * steht im An-Feld, alle weiteren in Kopie. Anders als bei der Aufgabenmail
 * (taskMailService: je Verantwortliche eine eigene Nachricht) ist das hier
 * richtig — eine Frage ist ein GESPRÄCH. Wer in Kopie steht, soll sehen, wen
 * sie angeht und wer sonst noch mitliest; die Antwort geht denselben Weg
 * zurück.
 *
 * DIE KARTE: die schlichte macOS-Karte des Moduls (taskMailCard.ts), dieselbe
 * wie bei «Yeni görev» — oben das Stichwort («Soru»/«Sorun») in Farbe,
 * darunter die Überschrift und die Frage selbst im grauen Kasten. Blau fragt,
 * Rot meldet ein Problem.
 *
 * WICHTIG: rotes Ausrufezeichen auf der Karte, «❗» im Betreff UND die drei
 * Prioritätsköpfe (SmtpMailService `importance: "high"`) — erst die machen im
 * Posteingang das rote Zeichen, das Samet meint.
 *
 * DIE SPRACHE: TÜRKISCH. Anders als Termin- und Antragsmail (Haussprache
 * Deutsch) gehört diese Karte zum Görevler-Modul, dessen Oberfläche durchweg
 * türkisch ist — und ihr Inhalt, die Frage selbst, ist es auch. Eine deutsche
 * Hülle um eine türkische Frage läse sich falsch. Marken- und Grussworte kommen
 * aus `inviteWords("tr")`, damit die Karte dieselben Worte trägt wie die
 * Aufgabenmail des Moduls.
 *
 * FEUERN UND VERGESSEN: ein stummer Mailserver darf eine Frage nicht scheitern
 * lassen; geschrieben ist sie längst, die Meldung in der Glocke steht auch.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (value: unknown) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();
const APP_URL = () => (process.env.OFFITEC_APP_URL || "https://demo.offitec.ch").replace(/\/$/, "");

export type IssueMailStage = "ASK" | "REPLY";

export interface TaskIssueMailInput {
    tenantId: string;
    /** Wer fragt bzw. antwortet — sie bekommt nie ihre eigene Post. */
    actorEmployeeId: string;
    issueId: string;
    taskId: string;
    kind: "QUESTION" | "ISSUE";
    /** Das Etikett über der Sprechblase. */
    title: string;
    /** Die Frage bzw. die Antwort im Klartext. */
    text: string;
    important: boolean;
    taskTitle: string;
    /** An-Feld: die erste markierte Person (beim Antworten: wem geantwortet wird). */
    toEmployeeId: string;
    /** Kopie: alle weiteren Beteiligten. */
    ccEmployeeIds: readonly string[];
    stage: IssueMailStage;
}

interface Person { id: string; name: string; email: string }

const loadPeople = async (ids: readonly string[]): Promise<Map<string, Person>> => {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await prisma.employee.findMany({
        where: { id: { in: unique } },
        select: { id: true, firstName: true, lastName: true, email: true },
    });
    const out = new Map<string, Person>();
    for (const row of rows) {
        out.set(row.id, {
            id: row.id,
            name: `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim(),
            email: clean(row.email).toLowerCase(),
        });
    }
    return out;
};

/** Die Worte der Karte — türkisch, wie das Modul. */
const WORDS = {
    QUESTION: { kicker: "SORU", label: "Soru", subject: "Soru", asked: "Soran" },
    ISSUE: { kicker: "SORUN", label: "Sorun", subject: "Sorun", asked: "Bildiren" },
} as const;

const CARD = {
    important: "Önemli",
    task: "Görev",
    repliedBy: "Yanıtlayan",
    button: "OCC'de yanıtla",
    reply: "Yanıt",
    footer: (task: string) =>
        `Bu mesaj «${task}» görevine aittir. Yanıtınızı OCC'de yazın, böylece tüm ilgililere ulaşır.`,
    leadReply: (actor: string, title: string) => `${actor}, «${title}» başlıklı konuya yanıt verdi.`,
    leadAsk: (actor: string, task: string, issue: boolean) => (issue
        ? `${actor}, «${task}» görevinde bir sorun bildirdi.`
        : `${actor}, «${task}» görevinde size bir soru sordu.`),
} as const;

/** Die Karte — Aufbau und Stil stehen in taskMailCard.ts. */
const issueCard = (input: TaskIssueMailInput, greetingName: string, askedBy: string, link: string): TaskMailCardInput => {
    const words = WORDS[input.kind];
    const speech = inviteWords("tr");
    const reply = input.stage === "REPLY";
    return {
        brand: speech.brand,
        kicker: reply ? `${CARD.reply} · ${words.label}` : words.label,
        accent: input.kind === "ISSUE" ? TASK_MAIL_RED : TASK_MAIL_BLUE,
        badge: input.important ? CARD.important : null,
        heading: input.title,
        greeting: greetingName ? `${speech.greeting} ${greetingName},` : `${speech.greeting},`,
        lead: reply
            ? CARD.leadReply(askedBy, input.title)
            : CARD.leadAsk(askedBy, input.taskTitle, input.kind === "ISSUE"),
        quote: input.text,
        rows: [
            { label: CARD.task, value: input.taskTitle },
            { label: reply ? CARD.repliedBy : words.asked, value: askedBy },
        ],
        button: { label: CARD.button, href: link },
        footer: CARD.footer(input.taskTitle),
    };
};

/**
 * @param input Ein Faden, EINE Nachricht: `toEmployeeId` ins An-Feld,
 *   `ccEmployeeIds` in Kopie.
 */
export const queueTaskIssueMail = (input: TaskIssueMailInput): void => {
    void (async () => {
        const people = await loadPeople([input.actorEmployeeId, input.toEmployeeId, ...input.ccEmployeeIds]);

        const settings = await prisma.mailSetting.findUnique({
            where: { tenantId: await getMailTenantId(input.tenantId) },
        });
        if (!settings?.smtpHost?.trim() || !settings?.smtpPort) return;
        const fromEmail = clean(settings.fromEmail);
        if (!EMAIL_RE.test(fromEmail)) return;

        /* DIE EMPFÄNGERREIHE, in der Reihenfolge der Markierung: zuerst die
           An-Person, dann die Kopie. Wer keine brauchbare Adresse hat, fällt
           heraus — und ebenso, WESSEN ADRESSE DAS POSTFACH SELBST IST: das
           Haus schreibt sich nicht selbst (bei der Zweitfirma ist die
           Absenderadresse die einer Person aus dem Team).

           Anders als bei der Aufgabenmail darf das aber nicht die ganze
           Sendung fallen lassen: eine Frage ist ein Gespräch mit mehreren.
           Fällt die An-Person weg, RÜCKT DIE ERSTE KOPIE NACH — sonst bekäme
           niemand die Frage, nur weil die zuerst markierte Person zufällig
           das Postfach ist. */
        const self = fromEmail.toLowerCase();
        const seen = new Set<string>();
        const line: Person[] = [];
        for (const id of [input.toEmployeeId, ...input.ccEmployeeIds]) {
            const person = people.get(id);
            const email = person?.email ?? "";
            if (!person || !EMAIL_RE.test(email) || email === self || seen.has(email)) continue;
            seen.add(email);
            line.push(person);
        }
        const to = line[0];
        if (!to) return;
        const cc = line.slice(1).map((person) => person.email);

        const askedBy = people.get(input.actorEmployeeId)?.name ?? "";
        const words = WORDS[input.kind];
        const link = `${APP_URL()}/tasks/${input.taskId}?issue=${encodeURIComponent(input.issueId)}`;
        /* Im Postfach entscheidet die erste Zeile. Das «❗» steht deshalb im
           Betreff und nicht nur auf der Karte — zusammen mit den
           Prioritätsköpfen ist es das, was beim Überfliegen auffällt. */
        const subject = `${input.important ? "❗ " : ""}${input.stage === "REPLY" ? CARD.reply : words.subject}: ${input.title}`;
        const fromName = inviteWords("tr").brand;

        await dispatchMail(
            { tenantId: input.tenantId, employeeId: input.actorEmployeeId },
            settings,
            {
                fromEmail,
                fromName,
                to: to.email,
                cc,
                subject,
                text: buildTaskMailText(issueCard(input, to.name, askedBy, link)),
                html: buildTaskMailHtml(issueCard(input, to.name, askedBy, link)),
                replyTo: settings.replyTo || null,
                inlineImages: [brandLogoInline()],
                importance: input.important ? "high" : null,
            },
            // Interne Post — sie gehört nicht in den Schriftverkehr eines Kunden.
            { record: null },
        );
    })().catch((error: any) =>
        console.error(`[SORU] Mail ${input.issueId} fehlgeschlagen:`, error?.message || error));
};
