import prisma from "../database/prisma.client";
import { dispatchMail } from "./outlook/MailDispatchService";
import { buildInvite, newIcalUid, type CalendarMethod } from "./calendarInvite";
import { buildInviteHtml, buildInviteText, type InviteDetail } from "./calendarInviteMail";
import { brandLogoInline } from "./mailBrand";

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
 * Empfänger dieser Sendung:
 *   An  — der Kunde (Hauptadresse, im Fenster änderbar)
 *   CC  — NUR Mitarbeitende: das zugeteilte Team plus die CC-Liste des Termins
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

interface InviteContext {
    tenantId: string;
    employeeId: string;
    uid: string;
    sequence: number;
    method: CalendarMethod;
    start: Date;
    end: Date;
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
    recipients: Recipient[];
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
    const settings = await prisma.mailSetting.findUnique({ where: { tenantId: context.tenantId } });
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

    const fromName = clean(settings.fromName) || "Offitec ERP";
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
        attendees: recipients,
        cancelled: context.method === "CANCEL",
    });

    const prefix = context.method === "CANCEL" ? "Abgesagt: " : context.sequence > 0 ? "Geändert: " : "";
    const subject = clean(context.subject) || `${prefix}${context.summary}`;
    // Die Mail selbst: Karte mit Logo und Absender im Kopf, Termin und Angaben
    // auf der Karte (calendarInviteMail.ts); dazu dieselben Angaben als Klartext.
    const card = {
        method: context.method,
        sequence: context.sequence,
        start: context.start,
        end: context.end,
        summary: context.summary,
        location: context.location ?? null,
        details: context.details,
        notes: context.notes ?? null,
        message: context.message ?? null,
        senderName: fromName,
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
            // Das Logo im Kopf der Karte — als Inline-Bild, nicht als Anhang.
            inlineImages: [brandLogoInline()],
            calendar: { method: context.method, content: ics },
            // Zusätzlich als Datei — Programme, die den Alternativteil ignorieren,
            // können den Termin so trotzdem übernehmen.
            attachments: [{
                filename: "invite.ics",
                contentType: "text/calendar",
                contentBase64: Buffer.from(ics, "utf8").toString("base64"),
            }],
        },
        {
            record: context.customerId
                ? {
                    customerId: context.customerId,
                    entityType: context.entityType ?? null,
                    entityId: context.entityId ?? null,
                    entityLabel: context.entityLabel ?? null,
                }
                : null,
        },
    );
    console.log(`[KALENDER] ${context.method} ${context.uid} an ${recipients.map((r) => r.email).join(", ")}`);
    return { sent: true, recipients: recipients.map((recipient) => recipient.email) };
};

/* ── Der ausdrückliche Versand: Adressen aus dem Versandfenster ─────────── */

export interface InviteSendOptions {
    /** An-Adresse (der Kunde). Pflicht — ohne sie gibt es nichts zu senden. */
    to: string;
    /** CC-Adressen — Mitarbeitende (Team + CC-Liste), im Fenster bestätigt. */
    cc?: string[] | null;
    subject?: string | null;
    message?: string | null;
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

const requireTo = (options: InviteSendOptions): void => {
    if (!EMAIL_RE.test(clean(options.to))) {
        throw Object.assign(new Error("Empfängeradresse fehlt oder ist ungültig."), { status: 400 });
    }
};

/** Niemals den Aufrufer scheitern lassen: Kalender speichern ≠ Mail verschicken. */
const fireAndForget = (label: string, job: Promise<void>): void => {
    void job.catch((error) => console.error(`[KALENDER] ${label} fehlgeschlagen:`, error?.message || error));
};

/* ── Projekttermine (Appointment) ──────────────────────────────────────── */

const appointmentDomain = (fromEmail: string | null | undefined) =>
    String(fromEmail || "").split("@")[1]?.trim() || "offitec-erp.local";

/**
 * Einladung zu einem Projekttermin. `method` REQUEST beim Anlegen und Ändern,
 * CANCEL beim Löschen. Vergibt beim ersten Mal die UID und zählt bei jeder
 * weiteren Sendung `icalSequence` hoch.
 */
const collectAppointmentInvite = async (
    appointmentId: string,
    method: CalendarMethod,
): Promise<{ context: Omit<InviteContext, "employeeId">; uid: string; sequence: number } | null> => {
    const appointment: any = await (prisma as any).appointment.findUnique({
        where: { id: appointmentId },
        include: {
            customer: {
                select: {
                    id: true, companyName: true, mainEmail: true,
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
            project: { select: { id: true, projectName: true, projectNumber: true } },
        },
    });
    if (!appointment) return null;
    // Nie verschickt ⇒ steht in keinem fremden Kalender ⇒ nichts abzusagen.
    if (method === "CANCEL" && !appointment.icalUid) return null;

    const settings = await prisma.mailSetting.findUnique({
        where: { tenantId: appointment.tenantId },
        select: { fromEmail: true },
    });
    const uid = appointment.icalUid || newIcalUid(appointment.id, appointmentDomain(settings?.fromEmail));
    // Beim ersten Versand 0, danach immer eine höher — Outlook verwirft eine
    // Aktualisierung mit gleicher oder kleinerer SEQUENCE.
    const sequence = appointment.icalUid ? (appointment.icalSequence ?? 0) + 1 : 0;

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
    const summary = project?.projectName
        ? `Montagetermin – ${project.projectName}`
        : "Montagetermin";
    const details: InviteDetail[] = [
        project?.projectNumber ? { label: "Projekt", value: project.projectNumber } : null,
        appointment.customer?.companyName ? { label: "Kunde", value: appointment.customer.companyName } : null,
        technicians.length
            ? { label: "Team", value: technicians.map((tech: any) => `${tech.firstName} ${tech.lastName}`).join(", ") }
            : null,
    ].filter((row): row is InviteDetail => row !== null);
    const notes = String(appointment.notes || "").trim() || null;
    const description = [
        ...details.map((row) => `${row.label}: ${row.value}`),
        notes ? `\n${notes}` : "",
    ].filter(Boolean).join("\n");

    return {
        uid,
        sequence,
        context: {
            tenantId: appointment.tenantId,
            uid,
            sequence,
            method,
            start: new Date(appointment.startTime),
            end: new Date(appointment.endTime),
            summary,
            description,
            location,
            details,
            notes,
            recipients: [
                ...(appointment.customer?.mainEmail ? [{ email: appointment.customer.mainEmail, name: appointment.customer.companyName }] : []),
                ...technicians.map((tech: any) => ({ email: tech.email, name: `${tech.firstName} ${tech.lastName}` })),
                ...ccList(appointment.ccEmails).map((email) => ({ email, optional: true })),
            ],
            customerId: appointment.customerId,
            entityType: "APPOINTMENT",
            entityId: appointment.id,
            entityLabel: project?.projectNumber || null,
        },
    };
};

/**
 * «Termin an Kunden senden»: die Einladung zu einem Projekttermin, mit den im
 * Versandfenster bestätigten Adressen. Beim ersten Mal wird die UID vergeben,
 * jede weitere Sendung zählt `icalSequence` hoch (Outlook ersetzt den Eintrag).
 * Wird ABGEWARTET — das Fenster zeigt das Ergebnis.
 */
export const sendAppointmentInvite = async (
    appointmentId: string,
    employeeId: string,
    options: InviteSendOptions,
): Promise<InviteSendResult> => {
    requireTo(options);
    const collected = await collectAppointmentInvite(appointmentId, "REQUEST");
    if (!collected) throw Object.assign(new Error("Termin nicht gefunden."), { status: 404 });
    const result = await sendInvite({ ...applySendOptions(collected.context, options), employeeId });
    if (!result.sent) return result;

    // Erst NACH erfolgreichem Versand festhalten — sonst zählt eine gescheiterte
    // Sendung die SEQUENCE hoch und die nächste echte käme zu niedrig an.
    await (prisma as any).appointment.update({
        where: { id: appointmentId },
        data: { icalUid: collected.uid, icalSequence: collected.sequence, inviteSentAt: new Date() },
    }).catch(() => undefined);
    return result;
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
): Promise<{ context: Omit<InviteContext, "employeeId">; uid: string; sequence: number } | null> => {
    const meeting: any = await (prisma as any).meetingActivity.findUnique({
        where: { id: meetingId },
        include: {
            customer: { select: { id: true, companyName: true, mainEmail: true } },
            participants: {
                include: {
                    employee: { select: { firstName: true, lastName: true, email: true } },
                    customer: { select: { companyName: true, mainEmail: true } },
                },
            },
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
        where: { tenantId: meeting.tenantId },
        select: { fromEmail: true },
    });
    const uid = meeting.icalUid || newIcalUid(meeting.id, appointmentDomain(settings?.fromEmail));
    const sequence = meeting.icalUid ? (meeting.icalSequence ?? 0) + 1 : 0;

    const recipients: Recipient[] = [];
    if (meeting.customer?.mainEmail) recipients.push({ email: meeting.customer.mainEmail, name: meeting.customer.companyName });
    for (const participant of meeting.participants || []) {
        if (participant.employee?.email) {
            recipients.push({ email: participant.employee.email, name: `${participant.employee.firstName} ${participant.employee.lastName}` });
        }
        if (participant.customer?.mainEmail) {
            recipients.push({ email: participant.customer.mainEmail, name: participant.customer.companyName });
        }
    }
    for (const email of ccList(meeting.ccEmails)) recipients.push({ email, optional: true });

    return {
        uid,
        sequence,
        context: {
            tenantId: meeting.tenantId,
            uid,
            sequence,
            method,
            start: new Date(meeting.startTime),
            end: new Date(meeting.endTime),
            summary: meeting.title,
            description: [
                meeting.customer?.companyName ? `Kunde: ${meeting.customer.companyName}` : "",
                meeting.notes || "",
            ].filter(Boolean).join("\n"),
            details: meeting.customer?.companyName ? [{ label: "Kunde", value: meeting.customer.companyName }] : [],
            notes: String(meeting.notes || "").trim() || null,
            recipients,
            customerId: meeting.customerId,
            entityType: "MEETING",
            entityId: meeting.id,
            entityLabel: null,
        },
    };
};

/** «Besprechung senden» — dasselbe wie beim Projekttermin, für MeetingActivity. */
export const sendMeetingInvite = async (
    meetingId: string,
    employeeId: string,
    options: InviteSendOptions,
): Promise<InviteSendResult> => {
    requireTo(options);
    const collected = await collectMeetingInvite(meetingId, "REQUEST");
    if (!collected) throw Object.assign(new Error("Besprechung nicht gefunden oder nicht einladbar."), { status: 404 });
    const result = await sendInvite({ ...applySendOptions(collected.context, options), employeeId });
    if (!result.sent) return result;
    await (prisma as any).meetingActivity.update({
        where: { id: meetingId },
        data: { icalUid: collected.uid, icalSequence: collected.sequence, inviteSentAt: new Date() },
    }).catch(() => undefined);
    return result;
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
