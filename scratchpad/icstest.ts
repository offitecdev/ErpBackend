/* Prüfstand für den ICS-Teil (ohne Datenbank): Bauen, Lesen, Teams-Link,
   Serienerkennung und das Aufräumen der Beschreibung.
   Lauf:  npx ts-node -T scratchpad/icstest.ts                                */
import {
    buildInvite,
    cleanDescription,
    cleanLocation,
    onlineMeetingOrigin,
    parseCalendarObject,
} from "../src/infrastructure/services/calendarInvite";

let passed = 0;
const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) passed += 1;
    else failures.push(`${name}\n    erwartet: ${e}\n    erhalten: ${a}`);
};
const ok = (name: string, value: boolean) => check(name, value, true);

/* ── 1. Eigene Einladung: Hin- und Rückweg ──────────────────────────────── */
const own = buildInvite({
    uid: "offitec-abc123@offitec.eu",
    sequence: 2,
    method: "REQUEST",
    start: new Date(Date.UTC(2026, 7, 25, 8, 30)),
    end: new Date(Date.UTC(2026, 7, 25, 9, 30)),
    summary: "Baubesprechung Grosswangen — Etappe 2, Fassade & Türen",
    description: "Bitte Pläne mitbringen; Treffpunkt Baustellenbüro.",
    location: "Luzernstrasse 12, 6022 Grosswangen",
    organizer: { email: "info@offitec.eu", name: "Offitec Verwaltung" },
    attendees: [{ email: "kunde@basler-haustechnik.ch", name: "Basler Haustechnik AG" }],
});
const parsedOwn = parseCalendarObject(own)!;
ok("eigene Einladung wird gelesen", Boolean(parsedOwn));
check("UID bleibt", parsedOwn.uid, "offitec-abc123@offitec.eu");
check("SEQUENCE bleibt", parsedOwn.sequence, 2);
check("Umlaute überleben die Faltung", parsedOwn.summary, "Baubesprechung Grosswangen — Etappe 2, Fassade & Türen");
check("Beschreibung überlebt", parsedOwn.description, "Bitte Pläne mitbringen; Treffpunkt Baustellenbüro.");
check("Ort überlebt", parsedOwn.location, "Luzernstrasse 12, 6022 Grosswangen");
check("VALARM überschreibt die Beschreibung nicht", parsedOwn.description?.includes("Erinnerung"), false);
check("Start in UTC", parsedOwn.start?.toISOString(), "2026-08-25T08:30:00.000Z");
check("kein Serientermin", parsedOwn.recurring, false);
check("kein Online-Link", parsedOwn.onlineUrl, null);
ok("jede Zeile höchstens 75 Oktette", own.split("\r\n").every((line) => Buffer.from(line, "utf8").length <= 75));

/* ── 2. Teams-Einladung, wie Outlook sie schickt ────────────────────────── */
const teams = [
    "BEGIN:VCALENDAR",
    "METHOD:REQUEST",
    "PRODID:Microsoft Exchange Server 2010",
    "VERSION:2.0",
    "BEGIN:VTIMEZONE",
    "TZID:W. Europe Standard Time",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "ORGANIZER;CN=\"Meier, Anna\":mailto:anna.meier@partnerbau.ch",
    "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=info@offitec.e",
    " u:mailto:info@offitec.eu",
    "DESCRIPTION;LANGUAGE=de-CH:Kurze Abstimmung zur Ausschreibung.\\n\\n_____________",
    " ___________________________________________________________\\nMicrosoft Teams-B",
    " esprechung\\nNehmen Sie auf dem Computer teil\\nHier klicken\\, um an der Bespre",
    " chung teilzunehmen<https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZmEx",
    " ZmQ%40thread.v2/0?context=%7b%22Tid%22%3a%22abc%22%7d>\\nBesprechungs-ID: 123 4",
    " 56 789\\n________________________________________________________________________\\n",
    "UID:040000008200E00074C5B7101A82E00800000000B0F1@partnerbau.ch",
    "SUMMARY;LANGUAGE=de-CH:Abstimmung Ausschreibung Neubau",
    "DTSTART;TZID=W. Europe Standard Time:20260901T140000",
    "DTEND;TZID=W. Europe Standard Time:20260901T150000",
    "X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/19%3",
    " ameeting_ZmExZmQ%40thread.v2/0?context=%7b%22Tid%22%3a%22abc%22%7d",
    "LOCATION;LANGUAGE=de-CH:Microsoft Teams-Besprechung",
    "SEQUENCE:1",
    "BEGIN:VALARM",
    "DESCRIPTION:REMINDER",
    "TRIGGER;RELATED=START:-PT15M",
    "ACTION:DISPLAY",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
].join("\r\n");
const parsedTeams = parseCalendarObject(teams)!;
ok("Teams-Einladung wird gelesen", Boolean(parsedTeams));
check("Teams UID", parsedTeams.uid, "040000008200E00074C5B7101A82E00800000000B0F1@partnerbau.ch");
check("Teams Titel", parsedTeams.summary, "Abstimmung Ausschreibung Neubau");
check("Teams Organisator", parsedTeams.organizer?.email, "anna.meier@partnerbau.ch");
check("gefalteter Teilnehmer wieder zusammengesetzt", parsedTeams.attendees[0]?.email, "info@offitec.eu");
check("VALARM-DESCRIPTION bleibt draussen", parsedTeams.description?.startsWith("Kurze Abstimmung"), true);
ok("Teams-Link gefunden", (parsedTeams.onlineUrl || "").startsWith("https://teams.microsoft.com/l/meetup-join/"));
check("Link ohne schliessende Klammer", parsedTeams.onlineUrl?.includes(">"), false);
check("Herkunft TEAMS", onlineMeetingOrigin(parsedTeams.onlineUrl), "TEAMS");
check("keine Serie", parsedTeams.recurring, false);
check("Beschreibung ohne Teams-Block", cleanDescription(parsedTeams.description), "Kurze Abstimmung zur Ausschreibung.");
check("Ort bleibt lesbar", cleanLocation(parsedTeams.location), "Microsoft Teams-Besprechung");

/* ── 3. Serientermin: gelesen, aber als Serie gekennzeichnet ────────────── */
const series = teams.replace("SEQUENCE:1", "RRULE:FREQ=WEEKLY;BYDAY=TU\r\nSEQUENCE:1");
const parsedSeries = parseCalendarObject(series)!;
ok("Serie wird trotzdem gelesen", Boolean(parsedSeries));
check("Serie ist als solche erkannt", parsedSeries.recurring, true);

/* ── 4. Absage ──────────────────────────────────────────────────────────── */
const cancel = teams.replace("METHOD:REQUEST", "METHOD:CANCEL");
const parsedCancel = parseCalendarObject(cancel)!;
check("CANCEL erkannt", parsedCancel.method, "CANCEL");
check("CANCEL gilt als abgesagt", parsedCancel.cancelled, true);

/* ── 5. Andere Anbieter ─────────────────────────────────────────────────── */
const meet = [
    "BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT",
    "UID:google-42@google.com",
    "SUMMARY:Kurzabstimmung",
    "DTSTART:20260902T090000Z",
    "DTEND:20260902T093000Z",
    "DESCRIPTION:Videokonferenz: https://meet.google.com/abc-defg-hij",
    "END:VEVENT", "END:VCALENDAR",
].join("\r\n");
const parsedMeet = parseCalendarObject(meet)!;
check("Meet-Link aus der Beschreibung", parsedMeet.onlineUrl, "https://meet.google.com/abc-defg-hij");
check("Meet ist kein Teams", onlineMeetingOrigin(parsedMeet.onlineUrl), "OUTLOOK");

const zoom = [
    "BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT",
    "UID:zoom-7@zoom.us",
    "SUMMARY:Zoom",
    "DTSTART:20260902T090000Z",
    "LOCATION:https://us02web.zoom.us/j/8899001122?pwd=x",
    "END:VEVENT", "END:VCALENDAR",
].join("\r\n");
const parsedZoom = parseCalendarObject(zoom)!;
check("Zoom-Link aus dem Ort", parsedZoom.onlineUrl, "https://us02web.zoom.us/j/8899001122?pwd=x");
check("Ort ohne Link ist leer", cleanLocation(parsedZoom.location), "");
check("Ende fehlt ⇒ eine Stunde", parsedZoom.end?.toISOString(), "2026-09-02T10:00:00.000Z");

/* ── 6. Aufräumen der Beschreibung ──────────────────────────────────────── */
check("Beschreibung ohne Trennlinie bleibt", cleanDescription("Nur Text"), "Nur Text");
check("reiner Teams-Block wird leer", cleanDescription("________________________\nMicrosoft Teams meeting\nMeeting ID: 1 2 3\n________________________"), "");
check("Text NACH dem Block bleibt", cleanDescription("________________________\nJoin: https://teams.microsoft.com/l/meetup-join/x\n________________________\nAgenda: Punkt 1"), "Agenda: Punkt 1");
check("leere Beschreibung", cleanDescription(null), "");
check("Ort mit Zusatz behält den Zusatz", cleanLocation("Sitzungszimmer 2, https://teams.microsoft.com/l/x"), "Sitzungszimmer 2");

/* ── 7. Kein Kalenderobjekt ─────────────────────────────────────────────── */
check("Nichtkalender wird abgewiesen", parseCalendarObject("Guten Tag, hier ist kein Termin."), null);
check("VEVENT ohne UID wird abgewiesen", parseCalendarObject("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR"), null);

console.log(`\n${passed} von ${passed + failures.length} Prüfungen bestanden.`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
process.exit(failures.length ? 1 : 0);
