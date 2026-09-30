"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildInviteHtml = exports.buildInviteText = exports.formatInviteTime = exports.formatInviteDate = exports.inviteWords = exports.normalizeInviteLanguage = void 0;
const mailBrand_1 = require("./mailBrand");
const mailCardKit_1 = require("./mailCardKit");
/** "TR", "tr-CH", "" … -> eine unterstuetzte Sprache; Unbekanntes wird Deutsch. */
const normalizeInviteLanguage = (raw) => {
    const code = String(raw ?? "").trim().toLowerCase().slice(0, 2);
    return code === "tr" || code === "en" ? code : "de";
};
exports.normalizeInviteLanguage = normalizeInviteLanguage;
const WORDS = {
    de: {
        brand: "Offitec Control Center",
        greeting: "Guten Tag",
        regards: "Freundliche Grüsse",
        calendar: "Kalender",
        task: "Aufgabe",
        place: "Ort",
        date: "Datum",
        due: "Fällig",
        time: "Zeit",
        clockSuffix: " Uhr",
        schedule: "Einsatzplan",
        day: "Tag",
        scheduleLeadTeam: "Ihr Einsatzplan sieht wie folgt aus:",
        scheduleLeadCustomer: "wir haben folgende Termine für Sie eingetragen:",
        attachments: "Checklisten im Anhang",
        details: "Angaben",
        autoNotice: "Diese Einladung wurde automatisch vom Offitec Control Center erstellt.",
        autoNoticeTask: "Diese Nachricht wurde automatisch vom Offitec Control Center erstellt.",
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
            taskNew: ["Neue Aufgabe", "diese Aufgabe wurde Ihnen zugeteilt:", "Die Aufgabe finden Sie im OCC unter „Aufgaben“."],
            taskChanged: ["Aufgabe geändert", "diese Aufgabe von Ihnen wurde geändert:", "Die Aufgabe finden Sie im OCC unter „Aufgaben“."],
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
        brand: "Offitec Control Center",
        greeting: "Hello",
        regards: "Kind regards",
        calendar: "Calendar",
        task: "Task",
        place: "Place",
        date: "Date",
        due: "Due",
        time: "Time",
        clockSuffix: "",
        schedule: "Schedule",
        day: "Day",
        scheduleLeadTeam: "your assignment schedule is as follows:",
        scheduleLeadCustomer: "we have scheduled the following appointments for you:",
        attachments: "Checklists attached",
        details: "Details",
        autoNotice: "This invitation was created automatically by Offitec Control Center.",
        autoNoticeTask: "This message was created automatically by Offitec Control Center.",
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
            taskNew: ["New task", "this task has been assigned to you:", "You will find the task in the OCC under “Tasks”."],
            taskChanged: ["Task changed", "this task of yours has changed:", "You will find the task in the OCC under “Tasks”."],
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
        brand: "Offitec Control Center",
        greeting: "Merhaba",
        regards: "Saygılarımızla",
        calendar: "Takvim",
        task: "Görev",
        place: "Yer",
        date: "Tarih",
        due: "Son tarih",
        time: "Saat",
        clockSuffix: "",
        schedule: "Görev planı",
        day: "Gün",
        scheduleLeadTeam: "görev planınız şu şekildedir:",
        scheduleLeadCustomer: "sizin için aşağıdaki randevuları planladık:",
        attachments: "Ekteki kontrol listeleri",
        details: "Bilgiler",
        autoNotice: "Bu davet Offitec Control Center tarafından otomatik olarak oluşturuldu.",
        autoNoticeTask: "Bu mesaj Offitec Control Center tarafından otomatik olarak oluşturuldu.",
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
            taskNew: ["Yeni görev", "bu görev size atandı:", "Görevi OCC’de “Görevler” altında bulabilirsiniz."],
            taskChanged: ["Görev değişti", "size ait bu görev değiştirildi:", "Görevi OCC’de “Görevler” altında bulabilirsiniz."],
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
const inviteWords = (language = "de") => WORDS[language];
exports.inviteWords = inviteWords;
const TZ = "Europe/Zurich";
/** Datums- und Zeitformat je Sprache; die Zeitzone bleibt immer die des Hauses. */
const LOCALES = { de: "de-CH", en: "en-GB", tr: "tr-TR" };
const fmt = (date, options, language = "de") => new Intl.DateTimeFormat(LOCALES[language], { timeZone: TZ, ...options }).format(date);
const sameDay = (a, b) => fmt(a, { year: "numeric", month: "2-digit", day: "2-digit" }) ===
    fmt(b, { year: "numeric", month: "2-digit", day: "2-digit" });
/** "Dienstag, 18. August 2026" — in der Sprache der Empfaengerin. */
const formatInviteDate = (date, language = "de") => fmt(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" }, language);
exports.formatInviteDate = formatInviteDate;
/** "09:30 – 10:30 Uhr" bzw. "18.08.2026, 09:30 – 19.08.2026, 10:30" bei Tagwechsel. */
const formatInviteTime = (start, end, language = "de") => {
    const suffix = WORDS[language].clockSuffix;
    const from = fmt(start, { hour: "2-digit", minute: "2-digit" }, language);
    const to = fmt(end, { hour: "2-digit", minute: "2-digit" }, language);
    if (sameDay(start, end))
        return `${from} – ${to}${suffix}`;
    const day = (date) => fmt(date, { day: "2-digit", month: "2-digit", year: "numeric" }, language);
    return `${day(start)}, ${from} – ${day(end)}, ${to}${suffix}`;
};
exports.formatInviteTime = formatInviteTime;
const toneOf = (method, sequence, audience = "CUSTOMER", kind = "APPOINTMENT", language = "de") => {
    const words = WORDS[language];
    const team = audience === "TEAM";
    const of = ([kicker, lead, footer], accent, label) => ({ kicker, lead, footer, accent, label });
    /* DIE AUFGABE (19.08.2026). Sie ist keine Einladung: es gibt nichts
       anzunehmen und nichts abzusagen, nur eine Zuteilung und einen Tag, an
       dem sie faellig ist. Darum eigene Worte — und das Gruen der Aufgabe
       statt des Marineblaus des Termins. */
    if (kind === "TASK") {
        if (method === "CANCEL")
            return of(words.tone.taskCancel, mailBrand_1.BRAND_RED, words.task);
        return of(sequence > 0 ? words.tone.taskChanged : words.tone.taskNew, mailBrand_1.BRAND_TASK, words.task);
    }
    /* Besprechung und Projekttermin tragen dasselbe Marineblau und dasselbe
       Kalenderblatt — sie sind beide ein Kalendereintrag. Getrennt sind nur
       die Worte. */
    if (kind === "MEETING") {
        if (method === "CANCEL")
            return of(words.tone.meetingCancel, mailBrand_1.BRAND_RED, words.calendar);
        if (sequence > 0)
            return of(words.tone.meetingChanged, mailBrand_1.BRAND_NAVY, words.calendar);
        return of(team ? words.tone.meetingInviteTeam : words.tone.meetingInvite, mailBrand_1.BRAND_NAVY, words.calendar);
    }
    if (method === "CANCEL")
        return of(words.tone.cancel, mailBrand_1.BRAND_RED, words.calendar);
    if (sequence > 0)
        return of(team ? words.tone.changedTeam : words.tone.changed, mailBrand_1.BRAND_NAVY, words.calendar);
    return of(team ? words.tone.inviteTeam : words.tone.invite, mailBrand_1.BRAND_NAVY, words.calendar);
};
/**
 * Die Tage eines mehrtägigen Einsatzes — oder nichts, wenn es nur einer ist.
 * An dieser einen Stelle wird entschieden, ob die Karte vom „Termin“ oder vom
 * „Einsatzplan“ spricht; Klartext und HTML fragen beide hier.
 */
const scheduleDays = (input) => (input.schedule && input.schedule.length > 1 ? input.schedule : null);
/**
 * Die Zeiten EINES Einsatztages: „08:00 – 17:00 Uhr“ — und bei einer
 * Nachtschicht „20:00 – 02:00 Uhr (+1)“ statt des zweimal ausgeschriebenen
 * Datums. Der Tag steht schon in der Zeile davor; ihn in der Uhrzeit zu
 * wiederholen macht die Zeile lang und die Schicht nicht klarer.
 */
const formatScheduleTime = (start, end, language) => {
    const words = WORDS[language];
    const from = fmt(start, { hour: "2-digit", minute: "2-digit" }, language);
    const to = fmt(end, { hour: "2-digit", minute: "2-digit" }, language);
    return `${from} – ${to}${words.clockSuffix}${sameDay(start, end) ? "" : " (+1)"}`;
};
/** „Tag 2 · Dienstag, 25. August 2026 · 08:00 – 17:00 Uhr“. */
const scheduleLine = (day, index, language) => {
    const words = WORDS[language];
    return `(${index + 1}) · ${(0, exports.formatInviteDate)(day.start, language)} · ${formatScheduleTime(day.start, day.end, language)}`;
};
/** Klartext-Fassung (text/plain-Teil) — dieselben Angaben, ohne Gestaltung. */
const buildInviteText = (input) => {
    const kind = input.kind ?? "APPOINTMENT";
    const language = input.language ?? "de";
    const words = WORDS[language];
    const tone = toneOf(input.method, input.sequence, input.audience, kind, language);
    const days = scheduleDays(input);
    // Eine Aufgabe hat einen Tag, keine Zeitspanne — eine Zeile „09:00–10:00“
    // würde eine Genauigkeit vorgeben, die es nicht gibt.
    const rows = [
        // Beim mehrtägigen Einsatz stünde hier der erste Tag allein — der ganze
        // Plan folgt stattdessen als eigener Block unter der Anrede.
        input.hideDate || days ? null : `${kind === "TASK" ? words.due : words.date}: ${(0, exports.formatInviteDate)(input.start, language)}`,
        kind === "TASK" || input.hideDate || days ? null : `${words.time}: ${(0, exports.formatInviteTime)(input.start, input.end, language)}`,
        input.location ? `${words.place}: ${input.location}` : null,
        ...input.details.map((row) => `${row.label}: ${row.value}`),
    ].filter((line) => line !== null);
    const notes = input.notes?.trim();
    const message = input.message?.trim();
    // Leerzeilen sind hier Absicht (Absätze) — nur `null` fällt weg.
    const greeting = input.greetingName?.trim() ? `${words.greeting} ${input.greetingName.trim()}` : words.greeting;
    const lead = message
        || (days ? (input.audience === "TEAM" ? words.scheduleLeadTeam : words.scheduleLeadCustomer) : tone.lead);
    return [
        greeting,
        "",
        lead,
        "",
        input.summary,
        ...(days
            ? [`${words.schedule}:`, ...days.map((day, index) => `  ${scheduleLine(day, index, language)}`), ""]
            : []),
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
exports.buildInviteText = buildInviteText;
/**
 * HTML-Fassung — DIE KARTE (30.09.2026, Vorgabe Samet mit dem Bild der
 * Augustkarte: «bunun gibi olsun ama biraz daha büyük, kart daha düzenli,
 * tablolar renkli, sütunları ayrı renk, dalga aynı kalsın, premium»).
 *
 * Von oben nach unten (Baukasten: mailCardKit.ts):
 *   Kopf (Logo, Absender, Rubrik) · Welle · Zeichen · Stichwort · Titel,
 *   das Datum als Ticket — beim mehrtägigen Einsatz stattdessen der
 *   Einsatzplan als farbige Tabelle (Tag · Datum · Zeit),
 *   Anrede und Satz, die Angaben als farbige Tabelle, die Notiz bernstein,
 *   die Checklisten als Tabelle, Hinweis und Gruss;
 *   unter der Karte der automatische Hinweis.
 * Runde Ecken, Verläufe und Schatten zeigt Outlook Desktop nicht; die Karte
 * bleibt dort eckig, aber vollständig lesbar.
 */
const buildInviteHtml = (input) => {
    const kind = input.kind ?? "APPOINTMENT";
    const language = input.language ?? "de";
    const words = WORDS[language];
    const tone = toneOf(input.method, input.sequence, input.audience, kind, language);
    const cancelled = input.method === "CANCEL";
    const days = scheduleDays(input);
    const message = input.message?.trim();
    const notes = input.notes?.trim();
    const attachmentNames = (input.attachmentNames || []).filter((name) => Boolean(name && name.trim()));
    const greeting = `${words.greeting}${input.greetingName?.trim() ? ` ${input.greetingName.trim()}` : ""},`;
    const lead = message
        ? (0, mailCardKit_1.mailNl2br)(message)
        : (0, mailCardKit_1.mailEscape)(days
            ? (input.audience === "TEAM" ? words.scheduleLeadTeam : words.scheduleLeadCustomer)
            : tone.lead);
    const rows = [
        ...(input.location ? [{ label: words.place, value: input.location }] : []),
        ...input.details.filter((row) => row.value && row.value.trim()),
    ];
    const blocks = [
        (0, mailCardKit_1.cardHeader)(words.brand, tone.label),
        (0, mailCardKit_1.cardWave)(),
        (0, mailCardKit_1.cardHero)({
            icon: kind === "TASK" ? "TASK" : "APPOINTMENT",
            accent: tone.accent,
            kicker: tone.kicker,
            title: input.summary,
            strike: cancelled,
        }),
    ];
    if (days) {
        /* DER EINSATZPLAN (24.08.2026): eine Zeile je Tag, jede Spalte in
           ihrer Farbe — die Nummer hell-marineblau, das Datum weiss, die
           Zeiten dieses Tages rot getönt. */
        blocks.push((0, mailCardKit_1.cardGrid)({
            head: [{ text: words.schedule, colspan: 2 }, { text: words.time }],
            rows: days.map((day, index) => [
                String(index + 1),
                (0, exports.formatInviteDate)(day.start, language),
                formatScheduleTime(day.start, day.end, language),
            ]),
            tones: ["navy", "plain", "red"],
            widths: ["20px", "", ""],
            nowrap: [2],
        }));
    }
    else if (!input.hideDate) {
        /* Die Aufgabe hat nur einen Fälligkeitstag, keine Zeitspanne; ohne
           Fälligkeit fällt das Ticket ganz weg — ein erfundenes Datum wäre
           schlimmer als keins. */
        blocks.push((0, mailCardKit_1.cardTicket)({
            accent: tone.accent,
            month: fmt(input.start, { month: "short" }, language).replace(/\.$/, "").toLocaleUpperCase(LOCALES[language]),
            day: fmt(input.start, { day: "numeric" }, language),
            label: kind === "TASK" ? words.due : null,
            date: (0, exports.formatInviteDate)(input.start, language),
            time: kind === "TASK" ? null : (0, exports.formatInviteTime)(input.start, input.end, language),
        }));
    }
    blocks.push((0, mailCardKit_1.cardGreeting)(greeting, lead));
    blocks.push((0, mailCardKit_1.cardTable)(rows, { title: words.details }));
    if (notes)
        blocks.push((0, mailCardKit_1.cardNote)((0, mailCardKit_1.mailNl2br)(notes), "amber"));
    if (attachmentNames.length) {
        blocks.push((0, mailCardKit_1.cardGrid)({
            head: [{ text: words.attachments, colspan: 2 }],
            rows: attachmentNames.map((name) => [(0, mailCardKit_1.cardFileType)(name), name]),
            tones: ["red", "plain"],
            widths: ["40px", ""],
        }));
    }
    blocks.push((0, mailCardKit_1.cardClosing)(tone.footer, words.regards, words.brand));
    return (0, mailCardKit_1.cardPage)({
        lang: language,
        title: input.summary,
        preheader: `${tone.kicker} · ${input.summary}`,
        rows: blocks,
        below: kind === "TASK"
            ? [words.autoNoticeTask]
            : [words.autoNotice, words.replyNotice],
    });
};
exports.buildInviteHtml = buildInviteHtml;
//# sourceMappingURL=calendarInviteMail.js.map