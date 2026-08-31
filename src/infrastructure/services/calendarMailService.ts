import prisma from "../database/prisma.client";
import { dispatchMail } from "./outlook/MailDispatchService";
import { buildInvite, newIcalUid, type CalendarMethod, type InviteOccurrence } from "./calendarInvite";
import {
    buildInviteHtml,
    buildInviteText,
    inviteWords,
    normalizeInviteLanguage,
    type InviteAudience,
    type InviteDetail,
    type InviteKind,
    type InviteLanguage,
} from "./calendarInviteMail";
import { brandLogoInline, brandWaveInline } from "./mailBrand";
import { kindIconInline } from "./mailKindIcons";
import { getMailTenantId } from "../../presentation/controllers/serviceTenantScope";

/**
 * TERMIN → EINLADUNGSMAIL (18.08.2026, Versand auf Befehl seit 19.08.2026).
 *
 * Die Einladung ist eine echte Kalender-Einladung (iCalendar REQUEST), sodass
 * der Termin in Outlook landet und dort mit dem ERP übereinstimmt.
 *
 * WANN sie rausgeht — Vorgabe 19.08.2026: NICHT von selbst beim Anlegen oder
 * Ändern eines Termins. Sie geht erst, wenn jemand im ERP «Termin an Kunden
 * senden» auslöst (`sendAppointmentInvite` / `sendMeetingInvite` mit den im
 * Versandfenster bestätigten Adressen). Bis dahin weiss der Kunde nichts von
 * dem Termin, und die Mitarbeitenden bekommen ihn nur über dieselbe Sendung.
 *
 * DIE TEAMMAIL GEHT BEIM ANLEGEN VON SELBST RAUS (19.08.2026, Vorgabe Samet:
 * «beim Anlegen eines Termins wird keine Mail verschickt — sie soll automatisch
 * an die erstellende Person, die Technikerin und die CC-Liste gehen»). Das
 * betrifft NUR die interne Aufbietung: der Kunde erfährt weiterhin erst dann
 * von dem Termin, wenn jemand «Termin senden» drückt. `queueAppointmentTeamInvite`
 * feuert und vergisst — ein stummer Mailserver darf das Anlegen nicht scheitern
 * lassen.
 *
 * ZWEI SENDUNGEN AUS EINEM KLICK (19.08.2026, Vorgabe Samet). «Senden» im
 * Versandfenster löst aus:
 *   1. die KUNDENMAIL  — An: der Kunde (Adresse im Fenster änderbar). Sie ist
 *      die von Hand verfasste Einladung; Betreff und Nachricht kommen aus dem
 *      Fenster.
 *   2. die TEAMMAIL    — automatisch, ohne eigenes Fenster, An: das zugeteilte
 *      Montageteam, CC: die CC-Liste des Termins UND die Person, die den Termin
 *      angelegt hat (`createdByEmployeeId`). Nur an dieser Mail hängen die
 *      Checklisten des Projekts/Auftrags als PDF — sie sind das Arbeitspapier
 *      der Monteurin, nicht Kundenunterlagen.
 *
 * Warum zwei Nachrichten statt einer mit CC: eine Einladung, die jemand nur in
 * Kopie erhält, wird von manchen Postfächern nicht als Termin verarbeitet. Als
 * eigene Nachricht MIT eigener An-Zeile landet sie überall im Kalender. Beide
 * tragen dieselbe UID und dieselbe SEQUENCE — für Outlook ist es EIN Termin.
 * Ist die Teammail eingeschaltet, stehen die Mitarbeitenden deshalb NICHT mehr
 * zusätzlich im CC der Kundenmail (sonst käme alles doppelt).
 *
 * Einzige Ausnahme vom «nur auf Befehl»: die ABSAGE. Wurde ein Termin schon
 * verschickt (icalUid gesetzt) und wird dann gelöscht, geht ein CANCEL an
 * dieselben Beteiligten — sonst bliebe der Termin als Geist in deren Outlook.
 * Nie verschickte Termine erzeugen auch keine Absage.
 *
 * Absage = FEUERN UND VERGESSEN (hängt nicht im Antwortweg des Löschens); der
 * ausdrückliche Versand dagegen wird abgewartet, damit das Fenster ein echtes
 * Ergebnis zeigen kann (gesendet / kein Mailserver / keine Adresse).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (value: unknown) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();

interface Recipient { email: string; name?: string | null; optional?: boolean }

const dedupe = (recipients: Recipient[], skip: string[] = []): Recipient[] => {
    const seen = new Set(skip.map((address) => address.toLowerCase()));
    const out: Recipient[] = [];
    for (const recipient of recipients) {
        const email = clean(recipient.email).toLowerCase();
        if (!email || !EMAIL_RE.test(email) || seen.has(email)) continue;
        seen.add(email);
        out.push({ ...recipient, email });
    }
    return out;
};

const ccList = (raw: unknown): string[] => {
    const values = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
    return values.map((value) => clean(value)).filter((value) => EMAIL_RE.test(value));
};

/**
 * Eine Checkliste als PDF. Gezeichnet wird sie im Browser (dort liegen jsPDF,
 * die Schriften und die Firmenangaben) und als Base64 mitgeschickt — derselbe
 * Weg, den das Angebots- und das Rechnungs-PDF schon gehen.
 */
export interface InviteAttachment {
    filename: string;
    contentType: string;
    contentBase64: string;
}

/** Wie beim Angebotsversand: nur PDF, und zusammen höchstens 5 MB. */
const ATTACHMENT_TYPES = new Set(["application/pdf"]);
const ATTACHMENT_LIMIT = 5 * 1024 * 1024;

const base64Bytes = (value: string) => Math.floor(String(value || "").replace(/\s+/g, "").length * 3 / 4);

export const sanitizeInviteAttachments = (raw: unknown): InviteAttachment[] => {
    if (!Array.isArray(raw)) return [];
    const out: InviteAttachment[] = [];
    let total = 0;
    for (const item of raw) {
        const contentBase64 = typeof (item as any)?.contentBase64 === "string" ? (item as any).contentBase64 : "";
        const contentType = String((item as any)?.contentType || "").trim().toLowerCase();
        const rawName = String((item as any)?.filename || "").trim();
        if (!rawName || !contentBase64) {
            throw Object.assign(new Error("Anhang braucht Dateiname und Inhalt."), { status: 400 });
        }
        if (!ATTACHMENT_TYPES.has(contentType)) {
            throw Object.assign(new Error("Als Anhang sind nur PDF-Dateien möglich."), { status: 400 });
        }
        total += base64Bytes(contentBase64);
        if (total > ATTACHMENT_LIMIT) {
            throw Object.assign(new Error("Die Anhänge überschreiten 5 MB."), { status: 400 });
        }
        // Zeilenumbrüche und Pfadtrenner im Dateinamen zerlegen den MIME-Kopf.
        out.push({ filename: rawName.replace(/[\\/\r\n"]+/g, "_").slice(0, 120), contentType, contentBase64 });
    }
    return out;
};

interface InviteContext {
    tenantId: string;
    employeeId: string;
    uid: string;
    sequence: number;
    method: CalendarMethod;
    start: Date;
    end: Date;
    /**
     * MEHRTÄGIGER EINSATZ (24.08.2026): jeder Tag mit eigener UID und eigenen
     * Zeiten. Die Karte zeigt daraus den Einsatzplan, das Kalenderobjekt je Tag
     * einen Eintrag. Ein Tag ⇒ leer, und alles bleibt, wie es war.
     */
    occurrences?: InviteOccurrence[];
    summary: string;
    /** Für den Kalendereintrag (DESCRIPTION im VEVENT) — alle Angaben als Text. */
    description: string;
    location?: string | null;
    /** Für die Mail: die Angaben als Zeilen der Karte (Projekt, Kunde, Team …). */
    details: InviteDetail[];
    /** Für die Mail: Notizen als Freitext unter den Zeilen. */
    notes?: string | null;
    /** Persönliche Nachricht aus dem Versandfenster (steht auf der Karte). */
    message?: string | null;
    /** Betreff aus dem Versandfenster; ohne: "<Termin>" bzw. "Geändert: …". */
    subject?: string | null;
    /** Kundenfassung oder Teamfassung der Karte. Ohne Angabe: Kunde. */
    audience?: InviteAudience;
    /**
     * Projekttermin (Vorgabe) oder Besprechung. Beide tragen dasselbe Blau und
     * dasselbe Kalenderblatt, aber nicht dieselben Worte — zu einer Besprechung
     * wird eingeladen, ein Termin wird eingeplant.
     */
    kind?: InviteKind;
    /**
     * Sprache der Nachricht. Es gilt die Regel der Hausdokumente: die
     * Korrespondenzsprache der EMPFAENGERIN, nicht die Bediensprache der
     * absendenden Person. Kundenmail = `Customer.language`, Teammail = Deutsch
     * (fuer Mitarbeitende gibt es kein Sprachfeld).
     */
    language?: InviteLanguage;
    /** Checklisten-PDFs. Reisen nur mit der Teammail. */
    attachments?: InviteAttachment[];
    /** Wer die Nachricht bekommt (erster = An, Rest = CC). */
    recipients: Recipient[];
    /**
     * Wer im KALENDEREINTRAG als Teilnehmende steht. Ohne Angabe sind das die
     * Empfaenger dieser Nachricht. Kunden- und Teammail sind zwei Sendungen
     * DESSELBEN Termins — beide fuehren deshalb dieselbe Teilnehmerliste, auch
     * wenn die eine nur an den Kunden und die andere nur ans Team geht.
     */
    attendees?: Recipient[];
    customerId?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    entityLabel?: string | null;
}

/**
 * Baut die Einladung und verschickt sie. Der ERSTE Empfänger steht im An-Feld,
 * alle weiteren in CC — eine Einladung geht als EINE Nachricht raus, damit alle
 * Beteiligten denselben Termin (dieselbe UID) sehen.
 */
export type InviteSendResult =
    | { sent: true; recipients: string[] }
    | { sent: false; reason: "NO_SMTP" | "NO_SENDER" | "NO_RECIPIENT" };

const sendInvite = async (context: InviteContext): Promise<InviteSendResult> => {
    const settings = await prisma.mailSetting.findUnique({ where: { tenantId: await getMailTenantId(context.tenantId) } });
    if (!settings?.smtpHost?.trim() || !settings?.smtpPort) {
        console.log(`[KALENDER] ${context.uid}: kein SMTP-Server eingerichtet, keine Einladung verschickt.`);
        return { sent: false, reason: "NO_SMTP" };
    }
    const fromEmail = clean(settings.fromEmail);
    if (!EMAIL_RE.test(fromEmail)) {
        console.log(`[KALENDER] ${context.uid}: keine Absenderadresse hinterlegt, keine Einladung verschickt.`);
        return { sent: false, reason: "NO_SENDER" };
    }
    const recipients = dedupe(context.recipients, [fromEmail]);
    if (!recipients.length) {
        console.log(`[KALENDER] ${context.uid}: keine Empfängeradresse, keine Einladung verschickt.`);
        return { sent: false, reason: "NO_RECIPIENT" };
    }

    /* ABSENDERNAME (19.08.2026, Vorgabe Samet: "statt des Namens soll dort
       Offitec Verwaltungspanel stehen, in der Sprache der Nachricht").
       Im Postfach steht bei diesen Karten das SYSTEM, nicht eine Person:
       in den Mail-Einstellungen ist ein Menschenname hinterlegt, gemeint
       ist aber das Programm, das die Karte verschickt. Es ist derselbe
       Name wie im Kopf der Karte und in der Grussformel (`words.brand`)
       und er traegt auch als ORGANIZER in die Kalender-Einladung; Outlook
       erkennt den Veranstalter an der ADRESSE, der angezeigte Name ist
       frei. Der eingestellte Name gilt weiterhin fuer die Post, die eine
       Person selbst schreibt (/crm/mail). */
    const words = inviteWords(context.language);
    const fromName = words.brand;
    const ics = buildInvite({
        uid: context.uid,
        sequence: context.sequence,
        method: context.method,
        start: context.start,
        end: context.end,
        summary: context.summary,
        description: context.description,
        location: context.location ?? null,
        organizer: { email: fromEmail, name: fromName },
        attendees: dedupe(context.attendees ?? context.recipients, [fromEmail]),
        cancelled: context.method === "CANCEL",
        // Mehrtägiger Einsatz: ein VEVENT je Tag, jedes mit eigener UID.
        ...(context.occurrences?.length ? { occurrences: context.occurrences } : {}),
    });

    const prefix = context.method === "CANCEL" ? words.cancelledPrefix : context.sequence > 0 ? words.changedPrefix : "";
    const subject = clean(context.subject) || `${prefix}${context.summary}`;
    // Die Mail selbst: Karte mit Logo und Absender im Kopf, Termin und Angaben
    // auf der Karte (calendarInviteMail.ts); dazu dieselben Angaben als Klartext.
    const extra = context.attachments ?? [];
    const card = {
        kind: context.kind ?? "APPOINTMENT",
        method: context.method,
        sequence: context.sequence,
        audience: context.audience ?? "CUSTOMER",
        language: context.language ?? "de",
        start: context.start,
        end: context.end,
        // Aus den Tagen des Einsatzes wird auf der Karte der Einsatzplan.
        ...(context.occurrences?.length ? { schedule: context.occurrences.map((day) => ({ start: day.start, end: day.end })) } : {}),
        summary: context.summary,
        location: context.location ?? null,
        details: context.details,
        notes: context.notes ?? null,
        message: context.message ?? null,
        senderName: fromName,
        // Ohne den Namen auf der Karte wäre "3 Anhänge" im Postfach eine Rätselfrage.
        attachmentNames: extra.map((file) => file.filename),
    };
    const text = buildInviteText(card);
    const html = buildInviteHtml(card);

    const [primary, ...others] = recipients;
    await dispatchMail(
        { tenantId: context.tenantId, employeeId: context.employeeId },
        settings,
        {
            fromEmail,
            fromName,
            to: primary!.email,
            cc: others.map((recipient) => recipient.email),
            subject,
            text,
            html,
            replyTo: settings.replyTo || null,
            // Logo, Welle und das Zeichen der Karte (Kalenderblatt bzw. Haken)
            // im Briefkopf — als Inline-Bilder, nicht als Anhang.
            inlineImages: [brandLogoInline(), brandWaveInline(), kindIconInline("APPOINTMENT")],
            calendar: { method: context.method, content: ics },
            // Zusätzlich als Datei — Programme, die den Alternativteil ignorieren,
            // können den Termin so trotzdem übernehmen. Danach die Checklisten,
            // damit die Terminanfrage der erste Anhang bleibt.
            attachments: [
                {
                    filename: "invite.ics",
                    contentType: "text/calendar",
                    contentBase64: Buffer.from(ics, "utf8").toString("base64"),
                },
                ...extra,
            ],
        },
        {
            /* JEDE Kalendermeldung wird im Postfach festgehalten — auch die
               automatische Aufbietung des Teams (Vorgabe 19.08.2026: die
               Terminmeldungen sollen im Postfach auffindbar sein). Bis dahin
               ging sie spurlos raus, und der Filter «automatische
               Terminmeldungen» hätte auf eine ewig leere Liste gezeigt.

               Der KUNDE hängt nur an der Kundenmail: die Teammail ist interne
               Post und gehört nicht in den Schriftverkehr des Kunden — daran
               unterscheidet die Postfach-Seite die beiden auch. `CALENDAR` sagt
               ihr, dass die Zeile zugeordnet ist, obwohl kein Kunde dransteht. */
            record: {
                customerId: context.audience === "TEAM" ? null : context.customerId ?? null,
                entityType: context.entityType ?? null,
                entityId: context.entityId ?? null,
                entityLabel: context.entityLabel ?? null,
                matchSource: context.audience === "TEAM" ? "CALENDAR" : null,
            },
        },
    );
    console.log(`[KALENDER] ${context.method} ${context.uid} an ${recipients.map((r) => r.email).join(", ")}`);
    return { sent: true, recipients: recipients.map((recipient) => recipient.email) };
};

/* ── Der ausdrückliche Versand: Adressen aus dem Versandfenster ─────────── */

export interface InviteSendOptions {
    /**
     * An-Adresse (der Kunde). Darf leer bleiben, WENN die Teammail läuft —
     * dann ist die Sendung eine reine Aufbietung des eigenen Teams.
     */
    to: string;
    /** CC-Adressen — Mitarbeitende (Team + CC-Liste), im Fenster bestätigt. */
    cc?: string[] | null;
    subject?: string | null;
    message?: string | null;
    /**
     * Die AUTOMATISCHE Teammail (Vorgabe 19.08.2026, standardmässig an): eine
     * zweite, eigene Nachricht an das Montageteam, die CC-Liste und die Person,
     * die den Termin angelegt hat. Sie wird nicht verfasst — sie geht mit
     * demselben Klick raus wie die Kundenmail.
     */
    teamMail?: boolean;
    /** Checklisten als PDF. Hängen NUR an der Teammail. */
    attachments?: InviteAttachment[] | null;
}

/**
 * Ergebnis einer Sendung, aufgeschlüsselt nach den beiden Nachrichten. Das
 * Versandfenster zeigt beide Zeilen — «an den Kunden» und «ans Team» sind für
 * die Anwenderin zwei verschiedene Zusagen.
 */
export interface InviteDualResult {
    sentAt: string;
    customer: InviteSendResult | null;
    team: InviteSendResult | null;
    recipients: string[];
    teamRecipients: string[];
}

/**
 * Ersetzt die aus dem Termin abgeleiteten Empfänger durch die im Fenster
 * bestätigten. Namen und Rollen (Pflicht/optional) bleiben erhalten, wo die
 * Adresse schon bekannt war; neue Adressen kommen ohne Namen dazu.
 */
const applySendOptions = <T extends Omit<InviteContext, "employeeId">>(context: T, options: InviteSendOptions): T => {
    const known = new Map(context.recipients.map((recipient) => [clean(recipient.email).toLowerCase(), recipient]));
    const pick = (email: string, fallback: Recipient): Recipient => known.get(email.toLowerCase()) ?? fallback;
    const to = clean(options.to);
    const recipients: Recipient[] = [
        pick(to, { email: to }),
        ...(options.cc || []).map((raw) => clean(raw)).filter(Boolean).map((email) => pick(email, { email, optional: true })),
    ];
    return {
        ...context,
        recipients,
        subject: options.subject ?? null,
        message: options.message ?? null,
    };
};

/** Kundenmail nur, wenn eine brauchbare Adresse dasteht. */
const hasCustomerAddress = (options: InviteSendOptions): boolean => EMAIL_RE.test(clean(options.to));

/**
 * Ohne Kundenadresse UND ohne Teammail gäbe es nichts zu verschicken — das ist
 * ein Eingabefehler, kein stiller Nichtversand.
 */
const requireSomething = (options: InviteSendOptions, teamRecipients: Recipient[]): void => {
    if (hasCustomerAddress(options)) return;
    if (options.teamMail && teamRecipients.length) return;
    throw Object.assign(new Error("Empfängeradresse fehlt oder ist ungültig."), { status: 400 });
};

/** Niemals den Aufrufer scheitern lassen: Kalender speichern ≠ Mail verschicken. */
const fireAndForget = (label: string, job: Promise<void>): void => {
    void job.catch((error) => console.error(`[KALENDER] ${label} fehlgeschlagen:`, error?.message || error));
};

/* ── Projekttermine (Appointment) ──────────────────────────────────────── */

const appointmentDomain = (fromEmail: string | null | undefined) =>
    String(fromEmail || "").split("@")[1]?.trim() || "offitec-erp.local";

/**
 * Wer die Teammail bekommt: das Montageteam (es steht im An-Feld), danach die
 * CC-Liste und zuletzt die Person, die den Termin angelegt hat. `cc` ist beim
 * Versand aus dem Fenster die dort bestätigte Liste, beim automatischen Versand
 * die am Termin gespeicherte.
 */
const teamAudience = (collected: CollectedAppointment, cc: Recipient[], creator: Recipient | null): Recipient[] =>
    dedupe([...collected.technicians, ...cc, ...(creator ? [creator] : [])]);

/** Eine Mitarbeiterin als Empfaengerin — fuer den Ersatz der fehlenden Ersteller:in. */
const employeeRecipient = async (employeeId: string): Promise<Recipient | null> => {
    if (!employeeId) return null;
    const employee = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { firstName: true, lastName: true, email: true },
    }).catch(() => null);
    if (!employee?.email) return null;
    return { email: employee.email, name: `${employee.firstName} ${employee.lastName}` };
};

/**
 * Alles, was eine Terminmail braucht. Die Bausteine der automatischen Teammail
 * stehen EINZELN darin — denn ihre CC-Liste kommt beim Versand aus dem Fenster
 * (dort ist sie änderbar), nicht aus der gespeicherten Liste am Termin.
 */
interface CollectedAppointment {
    context: Omit<InviteContext, "employeeId">;
    uid: string;
    sequence: number;
    /** Das Montageteam. Steht im An-Feld der Teammail. */
    technicians: Recipient[];
    /**
     * Die am Termin GESPEICHERTE CC-Liste. Der Versand aus dem Fenster nimmt
     * stattdessen die dort bestätigte Liste; die automatische Sendung beim
     * Anlegen hat kein Fenster und ist auf diese hier angewiesen.
     */
    storedCc: Recipient[];
    /** Wer den Termin angelegt hat — oder niemand (Termine von vor dem Feld). */
    creator: Recipient | null;
    /**
     * Die Tage eines MEHRTÄGIGEN Einsatzes, jeder mit eigener UID und eigenem
     * Zählstand. Leer beim gewöhnlichen eintägigen Termin — dann trägt der
     * Termin seine UID allein (`uid`/`sequence`).
     */
    days?: Array<InviteOccurrence & { id: string }>;
    /**
     * NUR BEI DER BESPRECHUNG: teilnehmende KUNDEN — ohne den Kunden der
     * Besprechung selbst, dessen Adresse im Versandfenster steht und dort
     * änderbar ist. Sie bekommen keine eigene Nachricht, gehören aber in die
     * Teilnehmerliste des Kalendereintrags (Vorgabe 19.08.2026: «alle müssen
     * drinstehen»). Wer die Nachricht bekommt und wer zur Besprechung gehört,
     * sind zwei verschiedene Fragen.
     */
    guests?: Recipient[];
}

/**
 * UID UND ZÄHLSTAND FESTHALTEN — je Tag des Einsatzes einer. Erst NACH
 * erfolgreichem Versand: sonst zählte eine gescheiterte Sendung die SEQUENCE
 * hoch und die nächste echte käme bei Outlook als veraltet an.
 *
 * `inviteSentAt` beantwortet die Frage «wurde der Kunde schon eingeladen?» und
 * wird deshalb nur bei der ausdrücklichen Sendung gesetzt, nicht bei der
 * automatischen Aufbietung des Teams. Beim mehrtägigen Einsatz gilt die Antwort
 * für ALLE Tage — verschickt wurde der ganze Plan.
 */
const stampAppointmentInvite = async (
    appointmentId: string,
    collected: CollectedAppointment,
    options: { inviteSentAt?: Date } = {},
): Promise<void> => {
    const rows = collected.days?.length
        ? collected.days.map((day) => ({ id: day.id, uid: day.uid, sequence: day.sequence }))
        : [{ id: appointmentId, uid: collected.uid, sequence: collected.sequence }];
    await Promise.all(rows.map((row) => (prisma as any).appointment.update({
        where: { id: row.id },
        data: {
            icalUid: row.uid,
            icalSequence: row.sequence,
            ...(options.inviteSentAt ? { inviteSentAt: options.inviteSentAt } : {}),
        },
    }).catch(() => undefined)));
};

/**
 * Einladung zu einem Projekttermin. `method` REQUEST beim Anlegen und Ändern,
 * CANCEL beim Löschen. Vergibt beim ersten Mal die UID und zählt bei jeder
 * weiteren Sendung `icalSequence` hoch.
 */
const collectAppointmentInvite = async (
    appointmentId: string,
    method: CalendarMethod,
): Promise<CollectedAppointment | null> => {
    const appointment: any = await (prisma as any).appointment.findUnique({
        where: { id: appointmentId },
        include: {
            customer: {
                select: {
                    id: true, companyName: true, mainEmail: true, language: true,
                    address: true, addressSupplement: true, postalCode: true, city: true,
                    locations: {
                        where: { kind: "INSTALLATION" },
                        select: { address: true, addressSupplement: true, postalCode: true, city: true },
                        take: 1,
                    },
                },
            },
            assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true } },
            technicianAssignments: { include: { technician: { select: { id: true, firstName: true, lastName: true, email: true } } } },
            // Die Teammail geht auch an die Person, die den Termin gesetzt hat.
            createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
            project: { select: { id: true, projectName: true, projectNumber: true } },
        },
    });
    if (!appointment) return null;
    // Nie verschickt ⇒ steht in keinem fremden Kalender ⇒ nichts abzusagen.
    if (method === "CANCEL" && !appointment.icalUid) return null;

    const settings = await prisma.mailSetting.findUnique({
        where: { tenantId: await getMailTenantId(appointment.tenantId) },
        select: { fromEmail: true },
    });
    const domain = appointmentDomain(settings?.fromEmail);
    const uid = appointment.icalUid || newIcalUid(appointment.id, domain);
    // Beim ersten Versand 0, danach immer eine höher — Outlook verwirft eine
    // Aktualisierung mit gleicher oder kleinerer SEQUENCE.
    const sequence = appointment.icalUid ? (appointment.icalSequence ?? 0) + 1 : 0;

    /* MEHRTÄGIGER EINSATZ (24.08.2026): eine EINLADUNG für alle Tage, nicht
       eine je Tag. Die Karte trägt den Einsatzplan, das Kalenderobjekt je Tag
       ein VEVENT mit EIGENER UID — nur so lässt sich ein einzelner Tag später
       verschieben oder absagen.
       Bei der ABSAGE gilt das ausdrücklich NICHT: `buildAppointmentCancellation`
       wird je gelöschtem Tag aufgerufen, und dann darf genau dieser eine Tag
       zurückgezogen werden — sonst verschwände beim Streichen des Dienstags
       auch der Mittwoch aus fremden Kalendern. */
    const siblings: any[] = appointment.seriesId && method === "REQUEST"
        ? await (prisma as any).appointment.findMany({
            where: { seriesId: appointment.seriesId, tenantId: appointment.tenantId },
            orderBy: { startTime: "asc" },
            select: { id: true, startTime: true, endTime: true, icalUid: true, icalSequence: true },
        })
        : [];
    const days: Array<InviteOccurrence & { id: string }> = (siblings.length > 1 ? siblings : []).map((day) => ({
        id: day.id,
        uid: day.icalUid || newIcalUid(day.id, domain),
        sequence: day.icalUid ? (day.icalSequence ?? 0) + 1 : 0,
        start: new Date(day.startTime),
        end: new Date(day.endTime),
    }));
    // Die Karte spricht vom ganzen Einsatz: ihr Kopfdatum ist der ERSTE Tag.
    const firstDay = days[0] ?? { start: new Date(appointment.startTime), end: new Date(appointment.endTime) };

    // Der Haupttechniker steht meist AUCH in den Zuteilungen — ohne Dedupe
    // stünde er zweimal im Team ("Muster, Muster, Meier").
    const technicians = Array.from(new Map(
        [
            appointment.assignedTechnician,
            ...(appointment.technicianAssignments || []).map((assignment: any) => assignment.technician),
        ].filter(Boolean).map((tech: any) => [tech.id || tech.email, tech]),
    ).values());

    const project = appointment.project;
    // Montageadresse: die Projektadresse des Kunden (INSTALLATION), sonst seine
    // Hauptadresse. Sie steht im Termin als LOCATION — in Outlook ist das die
    // Zeile, aus der die Karte/Navigation aufgeht.
    const place = appointment.customer?.locations?.[0] || appointment.customer || null;
    const location = [
        [place?.address, place?.addressSupplement].filter(Boolean).join(", "),
        [place?.postalCode, place?.city].filter(Boolean).join(" "),
    ].filter(Boolean).join(", ") || null;
    /* Die KUNDENSPRACHE traegt die ganze Sendung — auch den Titel und die
       Zeilenbeschriftungen. Die Teammail setzt sie spaeter auf Deutsch zurueck. */
    const language = normalizeInviteLanguage(appointment.customer?.language);
    const words = inviteWords(language);
    const summary = project?.projectName
        ? `${words.installation} – ${project.projectName}`
        : words.installation;
    const details: InviteDetail[] = [
        project?.projectNumber ? { label: words.project, value: project.projectNumber } : null,
        appointment.customer?.companyName ? { label: words.customer, value: appointment.customer.companyName } : null,
        technicians.length
            ? { label: words.team, value: technicians.map((tech: any) => `${tech.firstName} ${tech.lastName}`).join(", ") }
            : null,
    ].filter((row): row is InviteDetail => row !== null);
    const notes = String(appointment.notes || "").trim() || null;
    const description = [
        ...details.map((row) => `${row.label}: ${row.value}`),
        notes ? `\n${notes}` : "",
    ].filter(Boolean).join("\n");

    // Reihenfolge ist hier Bedeutung: der erste Eintrag wird das An-Feld der
    // Teammail, alles Weitere landet in deren CC.
    const teamRecipients: Recipient[] = dedupe(
        technicians.map((tech: any) => ({ email: tech.email, name: `${tech.firstName} ${tech.lastName}` })),
    );
    const creator: Recipient | null = appointment.createdBy?.email
        ? { email: appointment.createdBy.email, name: `${appointment.createdBy.firstName} ${appointment.createdBy.lastName}` }
        : null;
    const storedCc = dedupe(ccList(appointment.ccEmails).map((email) => ({ email })));
    // Für die ABSAGE: alle, die den Termin je bekommen haben.
    const team = dedupe([...teamRecipients, ...storedCc, ...(creator ? [creator] : [])]);

    return {
        uid,
        sequence,
        technicians: teamRecipients,
        storedCc,
        creator,
        days,
        context: {
            tenantId: appointment.tenantId,
            language,
            uid,
            sequence,
            method,
            start: firstDay.start,
            end: firstDay.end,
            ...(days.length ? { occurrences: days.map(({ uid: dayUid, sequence: daySequence, start, end }) => ({ uid: dayUid, sequence: daySequence, start, end })) } : {}),
            summary,
            description,
            location,
            details,
            notes,
            /* Fuer die ABSAGE ist das die Empfaengerliste: alle, die den Termin
               je bekommen haben — Kunde, Team, CC UND die erstellende Person.
               Bleibt eine von ihnen aussen vor, steht der abgesagte Termin bei
               ihr als Geist im Kalender. Beim VERSAND wird diese Liste von den
               im Fenster bestaetigten Adressen ersetzt (applySendOptions). */
            recipients: dedupe([
                ...(appointment.customer?.mainEmail ? [{ email: appointment.customer.mainEmail, name: appointment.customer.companyName }] : []),
                ...technicians.map((tech: any) => ({ email: tech.email, name: `${tech.firstName} ${tech.lastName}` })),
                ...ccList(appointment.ccEmails).map((email) => ({ email, optional: true })),
                ...team,
            ]),
            customerId: appointment.customerId,
            entityType: "APPOINTMENT",
            entityId: appointment.id,
            entityLabel: project?.projectNumber || null,
        },
    };
};

/**
 * «Termin senden»: EIN Klick, ZWEI Nachrichten — die verfasste an den Kunden
 * und (sofern nicht abgeschaltet) die automatische ans Team, an die CC-Liste
 * des Fensters und an die Person, die den Termin angelegt hat; nur an letzterer
 * hängen die Checklisten. Beim ersten Mal wird die UID vergeben, jede weitere
 * Sendung zählt `icalSequence` hoch (Outlook ersetzt den Eintrag) — beide
 * Nachrichten teilen sich diesen Zählstand. Wird ABGEWARTET: das Fenster zeigt
 * je Nachricht, ob sie raus ist.
 */
export const sendAppointmentInvite = async (
    appointmentId: string,
    employeeId: string,
    options: InviteSendOptions,
): Promise<InviteDualResult> => {
    const collected = await collectAppointmentInvite(appointmentId, "REQUEST");
    if (!collected) throw Object.assign(new Error("Termin nicht gefunden."), { status: 404 });
    /* Termine von VOR `createdByEmployeeId` (19.08.2026) wissen nicht, wer sie
       angelegt hat, und nachtragen laesst sich das nicht. Damit die Regel «die
       erstellende Person bekommt die Mail» trotzdem ueberall greift, tritt dort
       die sendende Person an ihre Stelle — bei diesen Terminen ist sie in aller
       Regel dieselbe, und sie hat den Versand ausgeloest. */
    const creator = collected.creator ?? await employeeRecipient(employeeId);
    /* Wer die Teammail bekommt: das Montageteam (An), die im Fenster
       BESTÄTIGTE CC-Liste und die Person, die den Termin angelegt hat. Die
       gespeicherte CC-Liste des Termins steckt bereits im Fenster — wer dort
       jemanden herausnimmt, will ihn auch nicht in der Teammail haben. */
    const teamRecipients = teamAudience(collected, ccList(options.cc).map((email) => ({ email })), creator);
    const teamMail = options.teamMail !== false && teamRecipients.length > 0;
    requireSomething(options, teamRecipients);

    // Die Kundenmail führt die Mitarbeitenden nur dann im CC, wenn KEINE
    // Teammail läuft — sonst bekämen sie dieselbe Einladung zweimal.
    const customerContext = hasCustomerAddress(options)
        ? applySendOptions(collected.context, teamMail ? { ...options, cc: [] } : options)
        : null;
    /* Die Teilnehmerliste des Kalendereintrags: die im Fenster BESTAETIGTE
       Kundenadresse (nicht die gespeicherte — sie ist dort aenderbar) plus das
       Team. Beide Sendungen fuehren dieselbe Liste. */
    const everyone = dedupe([...(customerContext?.recipients ?? []), ...teamRecipients]);

    const customer = customerContext
        ? await sendInvite({ ...customerContext, attendees: everyone, employeeId })
        : null;

    /* Die Teammail wird NICHT verfasst: Betreff und Text stellt der Server, die
       Empfänger stehen am Termin. Nur die Nachricht aus dem Fenster reicht
       durch — wer dem Kunden etwas schreibt, meint meist auch das Team. */
    let team: InviteSendResult | null = null;
    if (teamMail) {
        // Die Teammail spricht Deutsch: die Hausssprache. Fuer Mitarbeitende
        // gibt es kein Sprachfeld, und die Kundensprache waere hier falsch.
        const teamWords = inviteWords("de");
        const prefix = collected.sequence > 0 ? teamWords.changedPrefix : "";
        team = await sendInvite({
            ...collected.context,
            employeeId,
            audience: "TEAM",
            recipients: teamRecipients,
            attendees: everyone,
            message: options.message ?? null,
            language: "de",
            subject: `${prefix}${teamWords.assignmentPrefix}${collected.context.summary}`,
            attachments: options.attachments ?? [],
        }).catch((error: any) => {
            // Eine gescheiterte Teammail darf die schon verschickte Kundenmail
            // nicht in einen Fehler verwandeln — sie wird gemeldet, nicht geworfen.
            console.error(`[KALENDER] Teammail ${collected.uid} fehlgeschlagen:`, error?.message || error);
            return { sent: false, reason: "NO_RECIPIENT" } as InviteSendResult;
        });
    }

    const anySent = Boolean(customer?.sent || team?.sent);
    if (!anySent) {
        // Beide stumm ⇒ der Aufrufer soll den Grund zeigen dürfen.
        const reason = (customer && !customer.sent ? customer : team && !team.sent ? team : null);
        if (reason) throw Object.assign(new Error(inviteFailureMessage(reason as any)), { status: 400 });
    }

    // Erst NACH erfolgreichem Versand festhalten — sonst zählt eine gescheiterte
    // Sendung die SEQUENCE hoch und die nächste echte käme zu niedrig an. Beide
    // Nachrichten teilen sich diesen einen Zählstand: für Outlook sind sie
    // derselbe Termin in derselben Fassung.
    await stampAppointmentInvite(appointmentId, collected, { inviteSentAt: new Date() });

    return {
        sentAt: new Date().toISOString(),
        customer,
        team,
        recipients: customer?.sent ? customer.recipients : [],
        teamRecipients: team?.sent ? team.recipients : [],
    };
};

/**
 * DIE AUTOMATISCHE AUFBIETUNG BEIM ANLEGEN (19.08.2026).
 *
 * Empfänger: das zugeteilte Montageteam (An), die am Termin gespeicherte
 * CC-Liste und die Person, die den Termin angelegt hat. NICHT der Kunde — der
 * bekommt seine Einladung erst über «Termin senden».
 *
 * OHNE Checklisten: die PDFs werden im Browser gezeichnet, und beim Anlegen
 * gibt es keinen Browser, der sie mitschicken könnte (beim Anlegen hängt oft
 * auch noch gar keine Checkliste am Auftrag). Wer sie nachreichen will, schickt
 * die Teammail aus dem Versandfenster noch einmal — dort reisen sie mit.
 *
 * FEUERN UND VERGESSEN: ein stummer oder langsamer Mailserver darf das Anlegen
 * eines Termins nicht scheitern lassen.
 *
 * `inviteSentAt` bleibt dabei UNBERÜHRT — dieses Feld beantwortet im Fenster
 * die Frage «wurde der Kunde schon eingeladen?», und die Antwort ist hier nein.
 * `icalUid`/`icalSequence` werden dagegen festgehalten: die spätere Sendung an
 * den Kunden muss denselben Termin mit HÖHERER Sequenz meinen, sonst verwirft
 * Outlook sie beim Team als veraltete Wiederholung.
 */
export const queueAppointmentTeamInvite = (appointmentId: string, employeeId: string): void => {
    fireAndForget(`Teammail ${appointmentId}`, (async () => {
        const collected = await collectAppointmentInvite(appointmentId, "REQUEST");
        if (!collected) return;
        /* NUR DIE AUFGEBOTENEN UND DER CC (25.08.2026, Vorgabe Samet: «nur wenn
           ein Termin zugeteilt wird — an die betreffende Monteurin oder den
           CC»). Die Person, die den Termin anlegt, steht NICHT mehr darin: sie
           hat ihn gerade selbst geschrieben und bekam bis dahin bei jedem
           Speichern eine Mail über die eigene Eingabe.

           Steht niemand darin — kein Team, kein CC —, geht auch nichts raus:
           ohne Aufbietung gibt es nichts zu melden. Der Versand VON HAND
           («Termin senden») führt die Erstellerin unverändert mit; dort ist
           die Mail ja gewollt und die Liste im Fenster sichtbar. */
        const recipients = dedupe([...collected.technicians, ...collected.storedCc]);
        if (!recipients.length) return;

        // Die Teammail spricht Deutsch: die Hausssprache. Fuer Mitarbeitende
        // gibt es kein Sprachfeld, und die Kundensprache waere hier falsch.
        const teamWords = inviteWords("de");
        const prefix = collected.sequence > 0 ? teamWords.changedPrefix : "";
        const result = await sendInvite({
            ...collected.context,
            employeeId,
            audience: "TEAM",
            recipients,
            attendees: recipients,
            language: "de",
            subject: `${prefix}${teamWords.assignmentPrefix}${collected.context.summary}`,
        });
        if (!result.sent) return;
        await stampAppointmentInvite(appointmentId, collected);
    })());
};

/**
 * Absage EINSAMMELN, solange die Zeile noch existiert. Sie wird erst nach der
 * erfolgreichen Löschung verschickt — eine gescheiterte Löschung darf den
 * Termin nicht aus fremden Kalendern entfernen.
 */
export type AppointmentCancellation = Omit<InviteContext, "employeeId"> | null;

export const buildAppointmentCancellation = async (appointmentId: string): Promise<AppointmentCancellation> => {
    const collected = await collectAppointmentInvite(appointmentId, "CANCEL");
    return collected ? collected.context : null;
};

export const queueAppointmentCancellation = (cancellation: AppointmentCancellation, employeeId: string): void => {
    if (!cancellation) return;
    fireAndForget(`Absage ${cancellation.uid}`, sendInvite({ ...cancellation, employeeId }).then(() => undefined));
};

/* ── Besprechungen (MeetingActivity) ───────────────────────────────────── */

const collectMeetingInvite = async (
    meetingId: string,
    method: CalendarMethod,
): Promise<CollectedAppointment | null> => {
    const meeting: any = await (prisma as any).meetingActivity.findUnique({
        where: { id: meetingId },
        include: {
            customer: { select: { id: true, companyName: true, mainEmail: true, language: true } },
            participants: {
                include: {
                    employee: { select: { id: true, firstName: true, lastName: true, email: true } },
                    customer: { select: { companyName: true, mainEmail: true } },
                },
            },
            // Wie beim Projekttermin: die Teammail geht auch an die Person,
            // die die Besprechung angesetzt hat.
            createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
    });
    if (!meeting) return null;
    // Aufgaben sind keine Termine — für sie gibt es nichts einzuladen.
    if (meeting.kind === "TASK") return null;
    // Termine, die AUS Outlook kamen, gehören dem dortigen Organisator: eine
    // Einladung von uns würde seine Einladung überschreiben.
    if (meeting.externalOrigin) return null;
    // Nie verschickt ⇒ nichts abzusagen.
    if (method === "CANCEL" && !meeting.icalUid) return null;

    const settings = await prisma.mailSetting.findUnique({
        where: { tenantId: await getMailTenantId(meeting.tenantId) },
        select: { fromEmail: true },
    });
    const uid = meeting.icalUid || newIcalUid(meeting.id, appointmentDomain(settings?.fromEmail));
    const sequence = meeting.icalUid ? (meeting.icalSequence ?? 0) + 1 : 0;

    /* WER DAZUGEHÖRT (19.08.2026, Vorgabe Samet: «die Besprechung läuft wie der
       Termin, und im Kalendereintrag müssen ALLE stehen — auch der Kunde bzw.
       die teilnehmende Person»). Drei Gruppen, sauber getrennt:
         staff     — die Mitarbeitenden unter den Teilnehmenden. Sie sind das
                     An-Feld der Teammail, wie das Montageteam beim Termin.
         guests    — der Kunde der Besprechung und teilnehmende Kunden. Sie
                     stehen im An-Feld der KUNDENmail und im Kalendereintrag.
         storedCc  — die am Eintrag gespeicherte CC-Liste.
       Alle drei zusammen sind die Teilnehmerliste des Kalendereintrags: keine
       Sendung führt eine kürzere, sonst sähe der Kunde eine andere Besprechung
       als das Team. */
    const staff: Recipient[] = [];
    const guests: Recipient[] = [];
    if (meeting.customer?.mainEmail) {
        guests.push({ email: meeting.customer.mainEmail, name: meeting.customer.companyName });
    }
    for (const participant of meeting.participants || []) {
        if (participant.employee?.email) {
            staff.push({ email: participant.employee.email, name: `${participant.employee.firstName} ${participant.employee.lastName}` });
        }
        if (participant.customer?.mainEmail) {
            guests.push({ email: participant.customer.mainEmail, name: participant.customer.companyName });
        }
    }
    const technicians = dedupe(staff);
    const invited = dedupe(guests);
    /* Ohne den Kunden der Besprechung: seine Adresse ist die An-Zeile des
       Versandfensters und darf dort korrigiert werden — stünde sie hier
       zusätzlich, käme die alte Adresse über die Teilnehmerliste zurück. */
    const participantGuests = invited.filter(
        (guest) => guest.email !== clean(meeting.customer?.mainEmail).toLowerCase(),
    );
    const storedCc = dedupe(ccList(meeting.ccEmails).map((email) => ({ email, optional: true })));
    const creator: Recipient | null = meeting.createdBy?.email
        ? { email: meeting.createdBy.email, name: `${meeting.createdBy.firstName} ${meeting.createdBy.lastName}` }
        : null;

    const staffNames = technicians.map((person) => person.name).filter((name): name is string => Boolean(name));
    // Teilnehmende Kunden, die NICHT schon als Kunde der Besprechung dastehen.
    const guestNames = invited
        .map((guest) => guest.name)
        .filter((name): name is string => Boolean(name) && name !== meeting.customer?.companyName);
    /* Auch die Besprechung geht in der Sprache des Kunden raus; ohne Kunde
       (reine Hausbesprechung) bleibt es bei Deutsch. */
    const language = normalizeInviteLanguage(meeting.customer?.language);
    const meetingWords = inviteWords(language);
    const details: InviteDetail[] = [
        meeting.customer?.companyName ? { label: meetingWords.customer, value: meeting.customer.companyName } : null,
        staffNames.length ? { label: meetingWords.participants, value: staffNames.join(", ") } : null,
        guestNames.length ? { label: meetingWords.guests, value: guestNames.join(", ") } : null,
    ].filter((row): row is InviteDetail => row !== null);
    const notes = String(meeting.notes || "").trim() || null;

    return {
        uid,
        sequence,
        technicians,
        storedCc,
        creator,
        guests: participantGuests,
        context: {
            tenantId: meeting.tenantId,
            kind: "MEETING",
            language,
            uid,
            sequence,
            method,
            start: new Date(meeting.startTime),
            end: new Date(meeting.endTime),
            summary: meeting.title,
            description: [
                ...details.map((row) => `${row.label}: ${row.value}`),
                notes ? `\n${notes}` : "",
            ].filter(Boolean).join("\n"),
            details,
            notes,
            /* Für die ABSAGE die vollständige Liste — alle, die den Eintrag je
               bekommen haben. Beim ausdrücklichen Versand ersetzen die im
               Fenster bestätigten Adressen sie (applySendOptions). */
            recipients: dedupe([...invited, ...technicians, ...storedCc, ...(creator ? [creator] : [])]),
            customerId: meeting.customerId,
            entityType: "MEETING",
            entityId: meeting.id,
            entityLabel: null,
        },
    };
};

/**
 * «Besprechung senden» — GENAU WIE BEIM PROJEKTTERMIN (19.08.2026, Vorgabe
 * Samet: «die Besprechung läuft wie der Termin»). Ein Klick, zwei Nachrichten:
 * die verfasste an den Kunden und die automatische an die Teilnehmenden, die
 * CC-Liste und die Person, die die Besprechung angesetzt hat. Beide führen
 * DIESELBE Teilnehmerliste im Kalendereintrag — Kunde und Team sehen denselben
 * Eintrag, nicht zwei verschiedene.
 */
export const sendMeetingInvite = async (
    meetingId: string,
    employeeId: string,
    options: InviteSendOptions,
): Promise<InviteDualResult> => {
    const collected = await collectMeetingInvite(meetingId, "REQUEST");
    if (!collected) throw Object.assign(new Error("Besprechung nicht gefunden oder nicht einladbar."), { status: 404 });
    const creator = collected.creator ?? await employeeRecipient(employeeId);
    const teamRecipients = teamAudience(collected, ccList(options.cc).map((email) => ({ email })), creator);
    const teamMail = options.teamMail !== false && teamRecipients.length > 0;
    requireSomething(options, teamRecipients);

    const customerContext = hasCustomerAddress(options)
        ? applySendOptions(collected.context, teamMail ? { ...options, cc: [] } : options)
        : null;
    /* Die Teilnehmerliste des Kalendereintrags — beide Nachrichten fuehren
       dieselbe: die im Fenster bestaetigte Kundenadresse, die eigenen Leute
       UND die teilnehmenden Kunden, die selbst gar keine Nachricht bekommen.
       Wer die Nachricht bekommt und wer zur Besprechung gehoert, sind zwei
       verschiedene Fragen (Vorgabe 19.08.2026: «alle muessen drinstehen»). */
    const everyone = dedupe([
        ...(customerContext?.recipients ?? []),
        ...teamRecipients,
        ...(collected.guests ?? []),
    ]);

    const customer = customerContext
        ? await sendInvite({ ...customerContext, attendees: everyone, employeeId })
        : null;

    let team: InviteSendResult | null = null;
    if (teamMail) {
        // Die Teammail spricht Deutsch: die Hausssprache. Fuer Mitarbeitende
        // gibt es kein Sprachfeld, und die Kundensprache waere hier falsch.
        const teamWords = inviteWords("de");
        const prefix = collected.sequence > 0 ? teamWords.changedPrefix : "";
        team = await sendInvite({
            ...collected.context,
            employeeId,
            audience: "TEAM",
            recipients: teamRecipients,
            attendees: everyone,
            message: options.message ?? null,
            subject: `${prefix}Besprechung: ${collected.context.summary}`,
        }).catch((error: any) => {
            console.error(`[KALENDER] Teammail ${collected.uid} fehlgeschlagen:`, error?.message || error);
            return { sent: false, reason: "NO_RECIPIENT" } as InviteSendResult;
        });
    }

    if (!customer?.sent && !team?.sent) {
        const reason = (customer && !customer.sent ? customer : team && !team.sent ? team : null);
        if (reason) throw Object.assign(new Error(inviteFailureMessage(reason as any)), { status: 400 });
    }

    await (prisma as any).meetingActivity.update({
        where: { id: meetingId },
        data: { icalUid: collected.uid, icalSequence: collected.sequence, inviteSentAt: new Date() },
    }).catch(() => undefined);

    return {
        sentAt: new Date().toISOString(),
        customer,
        team,
        recipients: customer?.sent ? customer.recipients : [],
        teamRecipients: team?.sent ? team.recipients : [],
    };
};

/**
 * DIE AUTOMATISCHE AUFBIETUNG BEIM ANSETZEN EINER BESPRECHUNG (19.08.2026).
 *
 * Dasselbe wie `queueAppointmentTeamInvite`, nur für die Besprechung:
 * Empfänger sind die teilnehmenden MITARBEITENDEN (An), die gespeicherte
 * CC-Liste und die Person, die die Besprechung angesetzt hat. NICHT der Kunde —
 * der bekommt seine Einladung erst über «Besprechung senden».
 *
 * Der Kalendereintrag führt trotzdem ALLE Beteiligten als Teilnehmende, den
 * Kunden eingeschlossen: die Empfängerliste sagt, wer diese Nachricht bekommt,
 * die Teilnehmerliste sagt, wer zur Besprechung gehört. Das ist nicht dasselbe.
 *
 * `inviteSentAt` bleibt UNBERÜHRT (das Feld beantwortet «wurde der Kunde schon
 * eingeladen?»); `icalUid`/`icalSequence` werden festgehalten, damit die
 * spätere Kundensendung als Aktualisierung desselben Eintrags durchgeht.
 */
export const queueMeetingTeamInvite = (meetingId: string, employeeId: string): void => {
    fireAndForget(`Teammail Besprechung ${meetingId}`, (async () => {
        const collected = await collectMeetingInvite(meetingId, "REQUEST");
        if (!collected) return;
        const creator = collected.creator ?? await employeeRecipient(employeeId);
        const recipients = teamAudience(collected, collected.storedCc, creator);
        if (!recipients.length) return;

        // Die Teammail spricht Deutsch: die Hausssprache. Fuer Mitarbeitende
        // gibt es kein Sprachfeld, und die Kundensprache waere hier falsch.
        const teamWords = inviteWords("de");
        const prefix = collected.sequence > 0 ? teamWords.changedPrefix : "";
        const result = await sendInvite({
            ...collected.context,
            employeeId,
            audience: "TEAM",
            recipients,
            // Der Kalendereintrag führt ALLE — auch den Kunden, der diese
            // Nachricht nicht bekommt.
            attendees: dedupe([...collected.context.recipients, ...recipients]),
            subject: `${prefix}Besprechung: ${collected.context.summary}`,
        });
        if (!result.sent) return;
        await (prisma as any).meetingActivity.update({
            where: { id: meetingId },
            data: { icalUid: collected.uid, icalSequence: collected.sequence },
        }).catch(() => undefined);
    })());
};

export const buildMeetingCancellation = async (meetingId: string): Promise<AppointmentCancellation> => {
    const collected = await collectMeetingInvite(meetingId, "CANCEL");
    return collected ? collected.context : null;
};

export const queueMeetingCancellation = (cancellation: AppointmentCancellation, employeeId: string): void => {
    if (!cancellation) return;
    fireAndForget(`Absage ${cancellation.uid}`, sendInvite({ ...cancellation, employeeId }).then(() => undefined));
};

/** Antworttext für das Versandfenster, wenn nicht gesendet werden konnte. */
export const inviteFailureMessage = (result: Extract<InviteSendResult, { sent: false }>): string => {
    switch (result.reason) {
        case "NO_SMTP": return "Kein Mailserver eingerichtet — bitte zuerst die Mail-Einstellungen ausfüllen.";
        case "NO_SENDER": return "Keine Absenderadresse hinterlegt — bitte die Mail-Einstellungen prüfen.";
        default: return "Keine gültige Empfängeradresse.";
    }
};
