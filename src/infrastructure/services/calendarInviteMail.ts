import {
    BRAND_ICON_APPOINTMENT_CID,
    BRAND_ICON_TASK_CID,
    BRAND_LOGO_CID,
    BRAND_NAVY,
    BRAND_RED,
    BRAND_TASK,
    BRAND_WAVE_CID,
} from "./mailBrand";
import type { CalendarMethod } from "./calendarInvite";

/**
 * DIE EINLADUNGSMAIL ALS KARTE (18.08.2026).
 *
 * Vorgabe: die Terminmail soll kein nackter Text sein, sondern eine Karte mit
 * Logo und Absender im Kopf, einem ruhigen Hintergrund und den Angaben zum
 * Termin ("Bilgiler") deutlich lesbar auf der Karte.
 *
 * Mail-HTML ist NICHT Browser-HTML: kein Flexbox, kein Grid, keine externen
 * Stylesheets, keine SVGs. Alles hier sind Tabellen mit Inline-Stilen — das
 * ist der kleinste gemeinsame Nenner von Outlook (Word-Renderer), Gmail und
 * Apple Mail. Abgerundete Ecken zeigt Outlook Desktop nicht; die Karte bleibt
 * dort eckig, aber vollständig lesbar. Das Logo kommt als Inline-Bild mit
 * Content-ID mit (siehe mailBrand.ts), damit kein "Bilder anzeigen" nötig ist.
 */

export interface InviteDetail {
    label: string;
    value: string;
}

/**
 * An WEN die Karte spricht. Der Kunde wird eingeladen ("wir haben folgenden
 * Termin fuer Sie eingetragen"), das Team wird aufgeboten ("dieser Termin ist
 * fuer Sie eingeplant") — dieselbe Karte, ein anderer Satz.
 */
export type InviteAudience = "CUSTOMER" | "TEAM";

/**
 * WAS auf der Karte steht (19.08.2026, Vorgabe Samet). Dieselbe Karte traegt
 * zwei Sachen:
 *   APPOINTMENT — der Projekttermin: Marineblau, Kalenderblatt, eine
 *                 Zeitspanne, dazu die Kalender-Einladung selbst.
 *   MEETING     — die Besprechung: dieselbe Farbe und dasselbe Zeichen (sie
 *                 ist genauso ein Kalendereintrag), aber eigene Worte — man
 *                 wird zu einer Besprechung eingeladen, nicht aufgeboten.
 *   TASK        — eine zugeteilte Aufgabe: Gruen, Haken im Kreis, nur ein
 *                 Faelligkeitstag und KEINE Einladung (eine Aufgabe ist kein
 *                 Termin, sie gehoert in keinen fremden Kalender).
 * Die Farbe und das Zeichen sind das, was im Posteingang beim Ueberfliegen
 * haengen bleibt — darum unterscheidet sich die Aufgabe genau darin.
 */
export type InviteKind = "APPOINTMENT" | "MEETING" | "TASK";

/**
 * Das Zeichen im Kopf der Karte. Termin und Besprechung teilen sich das
 * Kalenderblatt — beide sind ein Eintrag im Kalender; nur die Aufgabe hat ihr
 * eigenes Zeichen.
 */
const kindIconCid = (kind: InviteKind) =>
    kind === "TASK" ? BRAND_ICON_TASK_CID : BRAND_ICON_APPOINTMENT_CID;

export interface InviteCardInput {
    method: CalendarMethod;
    /** Termin/Besprechung (Vorgabe) oder Aufgabe. Bestimmt Farbe und Zeichen. */
    kind?: InviteKind;
    /**
     * Aufgaben ohne Fälligkeitstag: der Datumsblock fällt weg. Ein erfundenes
     * Datum wäre schlimmer als keins — die Person würde sich danach richten.
     */
    hideDate?: boolean;
    /** 0 = neu, >0 = Aktualisierung eines schon verschickten Termins. */
    sequence: number;
    /** Ohne Angabe: die Kundenfassung (so war es vor der Teammail). */
    audience?: InviteAudience;
    start: Date;
    end: Date;
    summary: string;
    location?: string | null;
    /** Zeilen der Karte: Projekt, Kunde, Team … in dieser Reihenfolge. */
    details: InviteDetail[];
    /** Freitext (Notizen), unter den Zeilen. */
    notes?: string | null;
    /**
     * Persönliche Nachricht der absendenden Person (aus dem Versandfenster).
     * Steht auf der Karte anstelle des Standardsatzes — die Angaben zum Termin
     * folgen darunter unverändert.
     */
    message?: string | null;
    /** Sprache der Karte. Ohne Angabe Deutsch, wie vor der Uebersetzung. */
    language?: InviteLanguage;
    /**
     * Absendername. Er steht seit 19.08.2026 NICHT MEHR auf der Karte (Vorgabe
     * Samet: dort stand der Name einer Person, gemeint ist aber das System) —
     * Kopf und Grussformel tragen `words.brand`. Auch der MAILKOPF heisst
     * inzwischen so: die versendenden Dienste setzen `fromName` auf
     * `words.brand` und geben es hier nur noch mit, damit die Karte und die
     * Nachricht, in der sie steckt, denselben Absender nennen. Der in den
     * Mail-Einstellungen hinterlegte Name gilt weiter für die Post, die eine
     * Person selbst schreibt (/crm/mail).
     */
    senderName: string;
    /**
     * Name der ANGESCHRIEBENEN Person — dann heisst es "Guten Tag Frau Muster"
     * statt bloss "Guten Tag". Nur wo die Nachricht wirklich an EINE Person
     * geht (die Aufgabenmail); bei Einladungen an mehrere bleibt es unpersönlich.
     */
    greetingName?: string | null;
    /**
     * Namen der angehaengten Checklisten. Sie stehen als eigene Zeile auf der
     * Karte, damit die Monteurin im Posteingang sieht, WAS mitgekommen ist,
     * ohne die Anhaenge oeffnen zu muessen.
     */
    attachmentNames?: string[];
}

/**
 * DIE SPRACHE DER KARTE (19.08.2026, Vorgabe Samet: "den Text der Sprache
 * anpassen"). Es gilt dieselbe Regel wie bei den Dokumenten des Hauses: eine
 * Nachricht steht in der Korrespondenzsprache der EMPFAENGERIN, nicht in der
 * Bediensprache derjenigen, die sie ausloest.
 *   Kundenmail — `Customer.language` (TR/EN/DE), sonst Deutsch.
 *   Teammail   — Deutsch: die Hausssprache; fuer Mitarbeitende gibt es kein
 *                Sprachfeld.
 */
export type InviteLanguage = "de" | "en" | "tr";

/** "TR", "tr-CH", "" … -> eine unterstuetzte Sprache; Unbekanntes wird Deutsch. */
export const normalizeInviteLanguage = (raw: unknown): InviteLanguage => {
    const code = String(raw ?? "").trim().toLowerCase().slice(0, 2);
    return code === "tr" || code === "en" ? code : "de";
};

/**
 * Der ganze Wortschatz der Karte an EINER Stelle. Deutsch ist die Vorgabe und
 * bleibt unveraendert; Englisch und Tuerkisch kommen dazu. Wer eine Zeile
 * ergaenzt, ergaenzt sie in allen drei Sprachen — die Typangabe erzwingt es.
 */
interface InviteWords {
    /** Der Absender der Karte: das System, nicht die ausloesende Person. */
    brand: string;
    greeting: string;
    regards: string;
    /** Kleinzeile unter dem Absender — je nach Art Kalender oder Aufgabe. */
    calendar: string;
    task: string;
    place: string;
    date: string;
    /** Die Aufgabe hat kein Datum, sondern einen Tag, an dem sie faellig ist. */
    due: string;
    time: string;
    /** Anhaengsel der Zeitspanne; nur das Deutsche sagt "Uhr". */
    clockSuffix: string;
    attachments: string;
    autoNotice: string;
    /** Die Aufgabe ist keine Einladung — sie bekommt den nuechternen Satz. */
    autoNoticeTask: string;
    replyNotice: string;
    /** Betreffvorsaetze und der Titel des Montagetermins (calendarMailService). */
    cancelledPrefix: string;
    changedPrefix: string;
    assignmentPrefix: string;
    installation: string;
    project: string;
    customer: string;
    team: string;
    /** Besprechung: Mitarbeitende und geladene Kundengaeste. */
    participants: string;
    guests: string;
    tone: {
        taskCancel: [string, string, string];
        taskNew: [string, string, string];
        taskChanged: [string, string, string];
        cancel: [string, string, string];
        changed: [string, string, string];
        changedTeam: [string, string, string];
        invite: [string, string, string];
        inviteTeam: [string, string, string];
        /* Die Besprechung. Sie ist ein Kalendereintrag wie der Termin, aber
           kein Aufgebot: eine Besprechung wird nicht "eingeplant", man ist
           dabei. Eigene Zeilen statt einer Notloesung mit den Terminworten. */
        meetingCancel: [string, string, string];
        meetingChanged: [string, string, string];
        meetingInvite: [string, string, string];
        meetingInviteTeam: [string, string, string];
    };
}

const WORDS: Record<InviteLanguage, InviteWords> = {
    de: {
        brand: "Offitec Verwaltungspanel",
        greeting: "Guten Tag",
        regards: "Freundliche Grüsse",
        calendar: "Kalender",
        task: "Aufgabe",
        place: "Ort",
        date: "Datum",
        due: "Fällig",
        time: "Zeit",
        clockSuffix: " Uhr",
        attachments: "Checklisten im Anhang",
        autoNotice: "Diese Einladung wurde automatisch vom Offitec ERP erstellt.",
        autoNoticeTask: "Diese Nachricht wurde automatisch vom Offitec ERP erstellt.",
        replyNotice: "Antworten Sie mit „Annehmen“ oder „Ablehnen“ in Ihrem Kalenderprogramm.",
        cancelledPrefix: "Abgesagt: ",
        changedPrefix: "Geändert: ",
        assignmentPrefix: "Einsatz: ",
        installation: "Montagetermin",
        project: "Projekt",
        customer: "Kunde",
        team: "Team",
        participants: "Teilnehmende",
        guests: "Gäste",
        tone: {
            taskCancel: ["Aufgabe zurückgezogen", "die folgende Aufgabe ist nicht mehr Ihnen zugeteilt:", "Sie müssen nichts weiter tun."],
            taskNew: ["Neue Aufgabe", "diese Aufgabe wurde Ihnen zugeteilt:", "Die Aufgabe finden Sie im ERP unter „Aufgaben“."],
            taskChanged: ["Aufgabe geändert", "diese Aufgabe von Ihnen wurde geändert:", "Die Aufgabe finden Sie im ERP unter „Aufgaben“."],
            cancel: ["Termin abgesagt", "der folgende Termin wurde abgesagt:", "Der Termin wird beim Öffnen dieser E-Mail aus Ihrem Kalender entfernt."],
            changed: ["Termin geändert", "der folgende Termin wurde geändert:", "Mit „Annehmen“ wird der Termin in Ihrem Kalender aktualisiert."],
            changedTeam: ["Termin geändert", "dieser Einsatz wurde geändert:", "Mit „Annehmen“ wird der Termin in Ihrem Kalender aktualisiert."],
            invite: ["Termineinladung", "wir haben folgenden Termin für Sie eingetragen:", "Mit „Annehmen“ übernehmen Sie den Termin direkt in Ihren Kalender."],
            inviteTeam: ["Ihr Einsatz", "dieser Termin ist für Sie eingeplant:", "Mit „Annehmen“ übernehmen Sie den Termin direkt in Ihren Kalender."],
            meetingCancel: ["Besprechung abgesagt", "die folgende Besprechung wurde abgesagt:", "Die Besprechung wird beim Öffnen dieser E-Mail aus Ihrem Kalender entfernt."],
            meetingChanged: ["Besprechung geändert", "diese Besprechung wurde geändert:", "Mit „Annehmen“ wird die Besprechung in Ihrem Kalender aktualisiert."],
            meetingInvite: ["Einladung zur Besprechung", "wir laden Sie zu folgender Besprechung ein:", "Mit „Annehmen“ übernehmen Sie die Besprechung direkt in Ihren Kalender."],
            meetingInviteTeam: ["Ihre Besprechung", "Sie sind zu dieser Besprechung eingeladen:", "Mit „Annehmen“ übernehmen Sie die Besprechung direkt in Ihren Kalender."],
        },
    },
    en: {
        brand: "Offitec Management Panel",
        greeting: "Hello",
        regards: "Kind regards",
        calendar: "Calendar",
        task: "Task",
        place: "Place",
        date: "Date",
        due: "Due",
        time: "Time",
        clockSuffix: "",
        attachments: "Checklists attached",
        autoNotice: "This invitation was created automatically by Offitec ERP.",
        autoNoticeTask: "This message was created automatically by Offitec ERP.",
        replyNotice: "Reply with “Accept” or “Decline” in your calendar app.",
        cancelledPrefix: "Cancelled: ",
        changedPrefix: "Changed: ",
        assignmentPrefix: "Assignment: ",
        installation: "Installation appointment",
        project: "Project",
        customer: "Customer",
        team: "Team",
        participants: "Participants",
        guests: "Guests",
        tone: {
            taskCancel: ["Task withdrawn", "the following task is no longer assigned to you:", "There is nothing further for you to do."],
            taskNew: ["New task", "this task has been assigned to you:", "You will find the task in the ERP under “Tasks”."],
            taskChanged: ["Task changed", "this task of yours has changed:", "You will find the task in the ERP under “Tasks”."],
            cancel: ["Appointment cancelled", "the following appointment has been cancelled:", "Opening this e-mail removes the appointment from your calendar."],
            changed: ["Appointment changed", "the following appointment has changed:", "“Accept” updates the appointment in your calendar."],
            changedTeam: ["Appointment changed", "this assignment has changed:", "“Accept” updates the appointment in your calendar."],
            invite: ["Appointment invitation", "we have scheduled the following appointment for you:", "“Accept” puts the appointment straight into your calendar."],
            inviteTeam: ["Your assignment", "this appointment is scheduled for you:", "“Accept” puts the appointment straight into your calendar."],
            meetingCancel: ["Meeting cancelled", "the following meeting has been cancelled:", "Opening this e-mail removes the meeting from your calendar."],
            meetingChanged: ["Meeting changed", "this meeting has changed:", "“Accept” updates the meeting in your calendar."],
            meetingInvite: ["Meeting invitation", "we would like to invite you to the following meeting:", "“Accept” puts the meeting straight into your calendar."],
            meetingInviteTeam: ["Your meeting", "you are invited to this meeting:", "“Accept” puts the meeting straight into your calendar."],
        },
    },
    tr: {
        brand: "Offitec Yönetim Paneli",
        greeting: "Merhaba",
        regards: "Saygılarımızla",
        calendar: "Takvim",
        task: "Görev",
        place: "Yer",
        date: "Tarih",
        due: "Son tarih",
        time: "Saat",
        clockSuffix: "",
        attachments: "Ekteki kontrol listeleri",
        autoNotice: "Bu davet Offitec ERP tarafından otomatik olarak oluşturuldu.",
        autoNoticeTask: "Bu mesaj Offitec ERP tarafından otomatik olarak oluşturuldu.",
        replyNotice: "Takvim uygulamanızda “Kabul et” veya “Reddet” ile yanıtlayın.",
        cancelledPrefix: "İptal edildi: ",
        changedPrefix: "Değişti: ",
        assignmentPrefix: "Görevlendirme: ",
        installation: "Montaj randevusu",
        project: "Proje",
        customer: "Müşteri",
        team: "Ekip",
        participants: "Katılımcılar",
        guests: "Konuklar",
        tone: {
            taskCancel: ["Görev geri alındı", "aşağıdaki görev artık size atanmış değil:", "Yapmanız gereken başka bir şey yok."],
            taskNew: ["Yeni görev", "bu görev size atandı:", "Görevi ERP’de “Görevler” altında bulabilirsiniz."],
            taskChanged: ["Görev değişti", "size ait bu görev değiştirildi:", "Görevi ERP’de “Görevler” altında bulabilirsiniz."],
            cancel: ["Randevu iptal edildi", "aşağıdaki randevu iptal edildi:", "Bu e-postayı açtığınızda randevu takviminizden kaldırılır."],
            changed: ["Randevu değişti", "aşağıdaki randevu değiştirildi:", "“Kabul et” ile randevu takviminizde güncellenir."],
            changedTeam: ["Randevu değişti", "bu görevlendirme değiştirildi:", "“Kabul et” ile randevu takviminizde güncellenir."],
            invite: ["Randevu daveti", "sizin için aşağıdaki randevuyu planladık:", "“Kabul et” ile randevu doğrudan takviminize eklenir."],
            inviteTeam: ["Görevlendirmeniz", "bu randevu sizin için planlandı:", "“Kabul et” ile randevu doğrudan takviminize eklenir."],
            meetingCancel: ["Toplantı iptal edildi", "aşağıdaki toplantı iptal edildi:", "Bu e-postayı açtığınızda toplantı takviminizden kaldırılır."],
            meetingChanged: ["Toplantı değişti", "bu toplantı değiştirildi:", "“Kabul et” ile toplantı takviminizde güncellenir."],
            meetingInvite: ["Toplantı daveti", "sizi aşağıdaki toplantıya davet ediyoruz:", "“Kabul et” ile toplantı doğrudan takviminize eklenir."],
            meetingInviteTeam: ["Toplantınız", "bu toplantıya davetlisiniz:", "“Kabul et” ile toplantı doğrudan takviminize eklenir."],
        },
    },
};

/** Der Wortschatz einer Sprache — auch calendarMailService greift darauf zu. */
export const inviteWords = (language: InviteLanguage = "de"): InviteWords => WORDS[language];

const TZ = "Europe/Zurich";
/** Datums- und Zeitformat je Sprache; die Zeitzone bleibt immer die des Hauses. */
const LOCALES: Record<InviteLanguage, string> = { de: "de-CH", en: "en-GB", tr: "tr-TR" };

const escapeHtml = (value: string) =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

const nl2br = (value: string) => escapeHtml(value).replace(/\r?\n/g, "<br />");

const fmt = (date: Date, options: Intl.DateTimeFormatOptions, language: InviteLanguage = "de") =>
    new Intl.DateTimeFormat(LOCALES[language], { timeZone: TZ, ...options }).format(date);

const sameDay = (a: Date, b: Date) =>
    fmt(a, { year: "numeric", month: "2-digit", day: "2-digit" }) ===
    fmt(b, { year: "numeric", month: "2-digit", day: "2-digit" });

/** "Dienstag, 18. August 2026" — in der Sprache der Empfaengerin. */
export const formatInviteDate = (date: Date, language: InviteLanguage = "de") =>
    fmt(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" }, language);

/** "09:30 – 10:30 Uhr" bzw. "18.08.2026, 09:30 – 19.08.2026, 10:30" bei Tagwechsel. */
export const formatInviteTime = (start: Date, end: Date, language: InviteLanguage = "de") => {
    const suffix = WORDS[language].clockSuffix;
    const from = fmt(start, { hour: "2-digit", minute: "2-digit" }, language);
    const to = fmt(end, { hour: "2-digit", minute: "2-digit" }, language);
    if (sameDay(start, end)) return `${from} – ${to}${suffix}`;
    const day = (date: Date) => fmt(date, { day: "2-digit", month: "2-digit", year: "numeric" }, language);
    return `${day(start)}, ${from} – ${day(end)}, ${to}${suffix}`;
};

interface Tone {
    kicker: string;
    lead: string;
    footer: string;
    accent: string;
    /** Die leise Zeile unter dem Absendernamen im Briefkopf. */
    label: string;
}

const toneOf = (
    method: CalendarMethod,
    sequence: number,
    audience: InviteAudience = "CUSTOMER",
    kind: InviteKind = "APPOINTMENT",
    language: InviteLanguage = "de",
): Tone => {
    const words = WORDS[language];
    const team = audience === "TEAM";
    const of = ([kicker, lead, footer]: [string, string, string], accent: string, label: string): Tone =>
        ({ kicker, lead, footer, accent, label });

    /* DIE AUFGABE (19.08.2026). Sie ist keine Einladung: es gibt nichts
       anzunehmen und nichts abzusagen, nur eine Zuteilung und einen Tag, an
       dem sie faellig ist. Darum eigene Worte — und das Gruen der Aufgabe
       statt des Marineblaus des Termins. */
    if (kind === "TASK") {
        if (method === "CANCEL") return of(words.tone.taskCancel, BRAND_RED, words.task);
        return of(sequence > 0 ? words.tone.taskChanged : words.tone.taskNew, BRAND_TASK, words.task);
    }
    /* Besprechung und Projekttermin tragen dasselbe Marineblau und dasselbe
       Kalenderblatt — sie sind beide ein Kalendereintrag. Getrennt sind nur
       die Worte. */
    if (kind === "MEETING") {
        if (method === "CANCEL") return of(words.tone.meetingCancel, BRAND_RED, words.calendar);
        if (sequence > 0) return of(words.tone.meetingChanged, BRAND_NAVY, words.calendar);
        return of(team ? words.tone.meetingInviteTeam : words.tone.meetingInvite, BRAND_NAVY, words.calendar);
    }
    if (method === "CANCEL") return of(words.tone.cancel, BRAND_RED, words.calendar);
    if (sequence > 0) return of(team ? words.tone.changedTeam : words.tone.changed, BRAND_NAVY, words.calendar);
    return of(team ? words.tone.inviteTeam : words.tone.invite, BRAND_NAVY, words.calendar);
};

/** Klartext-Fassung (text/plain-Teil) — dieselben Angaben, ohne Gestaltung. */
export const buildInviteText = (input: InviteCardInput): string => {
    const kind = input.kind ?? "APPOINTMENT";
    const language = input.language ?? "de";
    const words = WORDS[language];
    const tone = toneOf(input.method, input.sequence, input.audience, kind, language);
    // Eine Aufgabe hat einen Tag, keine Zeitspanne — eine Zeile „09:00–10:00“
    // würde eine Genauigkeit vorgeben, die es nicht gibt.
    const rows = [
        input.hideDate ? null : `${kind === "TASK" ? words.due : words.date}: ${formatInviteDate(input.start, language)}`,
        kind === "TASK" || input.hideDate ? null : `${words.time}: ${formatInviteTime(input.start, input.end, language)}`,
        input.location ? `${words.place}: ${input.location}` : null,
        ...input.details.map((row) => `${row.label}: ${row.value}`),
    ].filter((line): line is string => line !== null);
    const notes = input.notes?.trim();
    const message = input.message?.trim();
    // Leerzeilen sind hier Absicht (Absätze) — nur `null` fällt weg.
    const greeting = input.greetingName?.trim() ? `${words.greeting} ${input.greetingName.trim()}` : words.greeting;
    return [
        greeting,
        "",
        message || tone.lead,
        "",
        input.summary,
        ...rows,
        ...(notes ? ["", notes] : []),
        ...(input.attachmentNames?.length
            ? ["", `${words.attachments}: ${input.attachmentNames.join(", ")}`]
            : []),
        "",
        tone.footer,
        "",
        words.regards,
        words.brand,
    ].join("\n");
};

const FONT = "font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";

/**
 * KARTENBREITE (19.08.2026 auf Wunsch verkleinert: vorher 660).
 *
 * 520 Pixel sind knapp die Breite eines Lesefensters ohne Zoom und schmal
 * genug, dass die Karte auch am grossen Bildschirm als Karte wirkt und nicht
 * als Seite. `width="100%"` + `max-width` macht sie auf dem Handy schmaler;
 * Outlook (Word-Renderer) kennt kein max-width und bekommt dieselbe Spalte
 * darum zusaetzlich in einem bedingten Kommentar mit fester Breite.
 */
const WIDTH = 520;
const MSO_OPEN = `<!--[if mso]><table role="presentation" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td><![endif]-->`;
const MSO_CLOSE = '<!--[if mso]></td></tr></table><![endif]-->';

/**
 * Eine Zeile der Angaben: Bezeichnung links, Wert rechts, Haarlinie darunter.
 * Die Bezeichnungsspalte ist 96 Punkte BREIT, aber nicht gedeckelt: ein langes
 * Wort ("ANSPRECHPARTNER", "KATILIMCILAR") schiebt sie auf, statt in den Wert
 * hineinzulaufen. In einer Tabelle gilt die Breite fuer alle Zeilen, die Karte
 * bleibt also ausgerichtet.
 * Enger gesetzt als frueher (9 statt 13 Pixel Luft, 15 statt 16 Pixel Schrift) —
 * die Angaben sollen ein Block sein, keine Liste, durch die man scrollt.
 */
const detailRow = (label: string, value: string, last: boolean) => `
    <tr>
        <td style="${FONT}padding:9px 14px 9px 0;width:96px;white-space:nowrap;vertical-align:top;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#8b93a7;${last ? "" : "border-bottom:1px solid #eef1f7;"}">${escapeHtml(label)}</td>
        <td style="${FONT}padding:9px 0;vertical-align:top;font-size:15px;line-height:1.4;color:#0f172a;${last ? "" : "border-bottom:1px solid #eef1f7;"}">${nl2br(value)}</td>
    </tr>`;

/**
 * HTML-Fassung: EINE schmale, mittig stehende Karte mit runden Ecken.
 *
 * Aufbau von oben nach unten:
 *   Briefkopf  — Logo und Absender.
 *   Wellenband — die Welle der Anmeldeseite ueber die GANZE Kartenbreite
 *                (`cid:`-Bild, siehe mailWaveAsset.ts). Damit traegt die
 *                Terminmail dasselbe Zeichen wie der Anmeldebildschirm.
 *   Kopf       — Kicker und Titel, mittig.
 *   Termin     — Datum und Zeit als EIN kompakter, mittiger Block mit runden
 *                Ecken (bis 19.08.2026 war das ein grosses Kalenderblatt neben
 *                einer zweispaltigen Zeile — zu gross fuer die Sache).
 *   Anrede     — Gruss und Satz, linksbuendig: Fliesstext liest sich mittig
 *                schlecht, nur die Angaben stehen mittig.
 *   Angaben    — Ort, Projekt, Kunde, Team.
 *   Notizen / Checklisten / Hinweis / Gruss.
 *
 * Runde Ecken zeigt Outlook Desktop nicht (Word-Renderer); die Karte bleibt
 * dort eckig, aber vollstaendig lesbar.
 */
export const buildInviteHtml = (input: InviteCardInput): string => {
    const kind = input.kind ?? "APPOINTMENT";
    const language = input.language ?? "de";
    const words = WORDS[language];
    const tone = toneOf(input.method, input.sequence, input.audience, kind, language);
    const cancelled = input.method === "CANCEL";
    const weekday = fmt(input.start, { weekday: "long" }, language);
    const dateLong = fmt(input.start, { day: "numeric", month: "long", year: "numeric" }, language);
    const time = formatInviteTime(input.start, input.end, language);
    const message = input.message?.trim();
    const notes = input.notes?.trim();
    const attachmentNames = (input.attachmentNames || []).filter((name) => Boolean(name && name.trim()));

    const rows: InviteDetail[] = [
        ...(input.location ? [{ label: words.place, value: input.location }] : []),
        ...input.details.filter((row) => row.value && row.value.trim()),
    ];

    /** Notiz- und Checklistenblock teilen sich dieselbe Form, nur die Farbe trennt sie. */
    const softBox = (accent: string, background: string, inner: string) =>
        `<div style="margin-top:14px;padding:11px 14px;background:${background};border-left:3px solid ${accent};border-radius:10px;">${inner}</div>`;

    return `<!DOCTYPE html>
<html lang="${language}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light" />
<title>${escapeHtml(input.summary)}</title>
</head>
<!-- WEISSER GRUND (19.08.2026, Vorgabe Samet: kein blaeulicher Hintergrund
     hinter der Karte). Die Karte hebt sich jetzt allein durch ihre Kontur und
     den weichen Schatten ab. Die Farbe steht doppelt (body UND Tabelle): manche
     Programme lesen das eine, manche das andere. -->
<body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;">
<tr><td align="center" style="padding:28px 16px 36px;">

    ${MSO_OPEN}
    <!-- Die Karte selbst: mittig, schmal, runde Ecken, ruhiger Schatten. -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:${WIDTH}px;margin:0 auto;background:#ffffff;border-radius:18px;border:1px solid #e1e5f0;box-shadow:0 10px 30px rgba(31,38,84,.10);">

    <!-- Briefkopf: Logo und Absender. -->
    <tr><td style="padding:20px 24px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
            <td style="vertical-align:middle;width:36px;">
                <img src="cid:${BRAND_LOGO_CID}" width="34" height="34" alt="" style="display:block;width:34px;height:34px;border:0;border-radius:17px;" />
            </td>
            <td style="${FONT}vertical-align:middle;padding-left:11px;">
                <div style="font-size:14.5px;font-weight:700;color:${BRAND_NAVY};letter-spacing:.01em;">${escapeHtml(words.brand)}</div>
                <div style="font-size:9.5px;color:#98a0b5;letter-spacing:.14em;text-transform:uppercase;margin-top:2px;">${escapeHtml(tone.label)}</div>
            </td>
        </tr>
        </table>
    </td></tr>

    <!-- Die Welle der Anmeldeseite, ueber die GANZE Kartenbreite. Kein
         Innenabstand: das Band soll die Karte fuellen, nicht in ihr schweben.
         Die Prozentbreite traegt es durch jede Fensterbreite; die feste Breiten-
         angabe im Attribut ist fuer Outlook, das kein Prozent auf Bildern mag. -->
    <tr><td style="padding:0;font-size:0;line-height:0;">
        <img src="cid:${BRAND_WAVE_CID}" width="${WIDTH}" height="62" alt="" style="display:block;width:100%;max-width:${WIDTH}px;height:auto;border:0;" />
    </td></tr>

    <!-- DAS ZEICHEN (19.08.2026): Kalenderblatt beim Termin, Haken im Kreis
         bei der Aufgabe — weiss auf der Akzentflaeche. Die FLAECHE traegt die
         Farbe, nicht das Bild: background-color auf einer Zelle ist das
         Einzige, worauf in Outlook Verlass ist. Runde Ecken zeigt Outlook
         nicht; dort steht ein Quadrat, und das ist in Ordnung. -->
    <tr><td align="center" style="padding:18px 26px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;">
        <tr><td align="center" width="52" height="52" bgcolor="${tone.accent}" style="width:52px;height:52px;background:${tone.accent};border-radius:16px;text-align:center;vertical-align:middle;font-size:0;line-height:0;">
            <img src="cid:${kindIconCid(kind)}" width="28" height="28" alt="" style="display:inline-block;width:28px;height:28px;border:0;" />
        </td></tr>
        </table>
    </td></tr>

    <!-- Kopf: Kicker und Titel, mittig. -->
    <tr><td align="center" style="padding:14px 26px 0;">
        <div style="${FONT}font-size:10.5px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:${tone.accent};">${escapeHtml(tone.kicker)}</div>
        <div style="${FONT}font-size:20px;line-height:1.3;font-weight:700;color:${BRAND_NAVY};margin-top:9px;${cancelled ? "text-decoration:line-through;color:#64748b;" : ""}">${escapeHtml(input.summary)}</div>
    </td></tr>

    <!-- Termin: EIN kompakter, mittiger Block. Die Aufgabe zeigt darin ihren
         Fälligkeitstag — sie hat keine Zeitspanne. Ohne Fälligkeit fällt der
         Block ganz weg. -->
    ${input.hideDate ? "" : `
    <tr><td align="center" style="padding:16px 26px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;background:#f4f6fb;border:1px solid #e6eaf4;border-radius:14px;">
        <tr><td align="center" style="${FONT}padding:12px 26px;">
            ${kind === "TASK"
                ? `<div style="font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8b93a7;">Fällig am</div>`
                : ""}
            <div style="font-size:15px;font-weight:700;color:#0f172a;${kind === "TASK" ? "margin-top:3px;" : ""}">${escapeHtml(weekday)}, ${escapeHtml(dateLong)}</div>
            ${kind === "TASK"
                ? ""
                : `<div style="font-size:16px;font-weight:700;color:${tone.accent};margin-top:3px;letter-spacing:.01em;">${escapeHtml(time)}</div>`}
        </td></tr>
        </table>
    </td></tr>`}

    <!-- Anrede: Fliesstext bleibt linksbuendig. -->
    <tr><td style="padding:20px 26px 0;">
        <div style="${FONT}font-size:14.5px;line-height:1.6;color:#475569;">${escapeHtml(words.greeting)}${input.greetingName?.trim() ? ` ${escapeHtml(input.greetingName.trim())}` : ""}</div>
        <div style="${FONT}font-size:14.5px;line-height:1.6;color:#475569;margin-top:2px;">${message ? nl2br(message) : escapeHtml(tone.lead)}</div>
    </td></tr>

    <!-- Die Angaben zum Termin. -->
    <tr><td style="padding:12px 26px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${rows.map((row, index) => detailRow(row.label, row.value, index === rows.length - 1)).join("")}
        </table>
        ${notes
            ? softBox("#f59e0b", "#fffbeb", `<div style="${FONT}font-size:14px;line-height:1.5;color:#3f3f46;">${nl2br(notes)}</div>`)
            : ""}
        ${attachmentNames.length
            ? softBox(BRAND_NAVY, "#f1f5fd",
                `<div style="${FONT}font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#8b93a7;">${escapeHtml(words.attachments)}</div>` +
                attachmentNames.map((name) => `<div style="${FONT}font-size:14px;line-height:1.5;color:#0f172a;margin-top:4px;">${escapeHtml(name)}</div>`).join(""))
            : ""}
    </td></tr>

    <!-- Hinweis und Gruss -->
    <tr><td style="padding:16px 26px 24px;">
        <div style="${FONT}font-size:12px;line-height:1.55;color:#8b93a7;padding-top:14px;border-top:1px solid #eef1f7;">${escapeHtml(tone.footer)}</div>
        <div style="${FONT}font-size:14.5px;line-height:1.6;color:#0f172a;margin-top:16px;">${escapeHtml(words.regards)}<br /><strong>${escapeHtml(words.brand)}</strong></div>
    </td></tr>
    </table>
    ${MSO_CLOSE}

    ${MSO_OPEN}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" align="center" style="max-width:${WIDTH}px;margin:0 auto;">
    <tr><td align="center" style="${FONT}padding:16px 20px 0;font-size:10.5px;line-height:1.7;color:#a3abbd;">
        ${kind === "TASK"
            ? escapeHtml(words.autoNoticeTask)
            : `${escapeHtml(words.autoNotice)}<br />${escapeHtml(words.replyNotice)}`}
    </td></tr>
    </table>
    ${MSO_CLOSE}

</td></tr>
</table>
</body>
</html>`;
};
