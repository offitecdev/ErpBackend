/* Was am 31.08.2026 dazugekommen ist: der Kalender aus CalDAV (mehrere VEVENTs
   je Antwort, vom Server aufgelöste Serien) und die Besitzfrage «welchem
   Postfach gehört dieser Termin».

   Der erste Teil ist rein (kein DB-Zugriff), der zweite legt einen Testtermin
   an und räumt ihn selbst weg — die Zeilenzahl am Ende muss stimmen.

   Lauf:  TS_NODE_COMPILER_OPTIONS='{"rootDir":"."}' \
          npx ts-node -T -r dotenv/config scratchpad/caldavtest.ts              */
import prisma from "../src/infrastructure/database/prisma.client";
import { parseCalendarObject, parseCalendarObjects } from "../src/infrastructure/services/calendarInvite";
import { importCalendarEvent } from "../src/infrastructure/services/calendarImportService";
import { mailboxIdentity } from "../src/infrastructure/services/mailboxIdentity";

const stamp = Date.now();
const SERIES_UID = `claude-caldav-series-${stamp}@offitec.eu`;
const SINGLE_UID = `claude-caldav-single-${stamp}@offitec.eu`;
const MINE = "mail.cyon.ch|mine@offitec.eu";
const THEIRS = "mail.cyon.ch|theirs@offitec.ch";

let passed = 0;
const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed += 1; console.log(`  ok  ${name}`); }
    else { failures.push(`${name}: erwartet ${e}, erhalten ${a}`); console.log(`  XX  ${name}: erwartet ${e}, erhalten ${a}`); }
};

/* So sieht die Antwort eines CalDAV-Servers auf eine aufgelöste Serie aus:
   EIN VCALENDAR, mehrere VEVENTs, alle mit derselben UID und je einer eigenen
   RECURRENCE-ID. Kein METHOD — es ist keine Einladung, sondern der Stand des
   Kalenders. */
const expandedSeries = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//cyon//CalDAV//EN",
    "BEGIN:VEVENT",
    `UID:${SERIES_UID}`,
    "RECURRENCE-ID:20260908T080000Z",
    "DTSTART:20260908T080000Z",
    "DTEND:20260908T090000Z",
    "SUMMARY:Wochenrapport",
    "ORGANIZER;CN=Sahin:mailto:mine@offitec.eu",
    "RRULE:FREQ=WEEKLY;BYDAY=MO",
    "BEGIN:VALARM",
    "DESCRIPTION:Erinnerung",
    "TRIGGER:-PT15M",
    "END:VALARM",
    "END:VEVENT",
    "BEGIN:VEVENT",
    `UID:${SERIES_UID}`,
    "RECURRENCE-ID:20260915T080000Z",
    "DTSTART:20260915T080000Z",
    "DTEND:20260915T090000Z",
    "SUMMARY:Wochenrapport",
    "RRULE:FREQ=WEEKLY;BYDAY=MO",
    "END:VEVENT",
    "BEGIN:VEVENT",
    `UID:${SINGLE_UID}`,
    "DTSTART:20260910T130000Z",
    "DTEND:20260910T140000Z",
    "SUMMARY:Baustellenbesuch Volta",
    "DESCRIPTION:Nur fuer mich eingetragen\\, niemand eingeladen.",
    "END:VEVENT",
    "END:VCALENDAR",
].join("\r\n");

const main = async () => {
    console.log("A. Der Kalender liefert mehrere Termine in EINER Antwort");
    const events = parseCalendarObjects(expandedSeries);
    check("drei Termine gelesen", events.length, 3);
    check("erster Titel", events[0]?.summary, "Wochenrapport");
    check("dritter Titel", events[2]?.summary, "Baustellenbesuch Volta");
    // Der Mailweg nimmt weiterhin nur den ersten — eine Einladung beschreibt
    // genau einen Termin.
    check("Mailweg nimmt den ersten", parseCalendarObject(expandedSeries)?.summary, "Wochenrapport");
    // Die Erinnerung im VALARM darf die Beschreibung des Termins nicht
    // überschreiben, auch nicht im mehrteiligen Text.
    check("VALARM faellt nicht in den Termin", events[0]?.description, null);
    check("zweiter Termin bleibt heil", events[1]?.start?.toISOString(), "2026-09-15T08:00:00.000Z");
    check("ohne METHOD gilt REQUEST", events[0]?.method, "REQUEST");

    console.log("B. Ein aufgeloestes Vorkommen ist KEIN Serienkopf");
    check("Vorkommen 1 nicht als Serie", events[0]?.recurring, false);
    check("Vorkommen 2 nicht als Serie", events[1]?.recurring, false);
    check("RECURRENCE-ID gelesen", events[0]?.recurrenceId, "20260908T080000Z");
    check("Einzeltermin ohne RECURRENCE-ID", events[2]?.recurrenceId, null);
    // Der Serienkopf (RRULE ohne RECURRENCE-ID) bleibt draussen wie bisher.
    const head = parseCalendarObjects(expandedSeries.replace("RECURRENCE-ID:20260908T080000Z\r\n", ""));
    check("Serienkopf weiterhin als Serie", head[0]?.recurring, true);

    console.log("C. Die Postfachkennung");
    check("Server plus Adresse", mailboxIdentity("Mail.Cyon.CH", "SCK@offitec.eu", null, null), "mail.cyon.ch|sck@offitec.eu");
    check("IMAP schlaegt SMTP", mailboxIdentity("h", "a@x.ch", "b@x.ch", "c@x.ch"), "h|a@x.ch");
    check("sonst SMTP, sonst Absender", mailboxIdentity("h", null, null, "c@x.ch"), "h|c@x.ch");
    check("ohne Postfach leer", mailboxIdentity("h", null, null, null), "");

    console.log("D. Zwei Vorkommen derselben Serie werden ZWEI Zeilen");
    const seed = await prisma.meetingActivity.findFirst({
        where: { NOT: { externalOrigin: null } },
        select: { tenantId: true },
    });
    const tenantId = seed?.tenantId || (await prisma.tenant.findFirst({ select: { id: true } }))!.id;
    const before = await prisma.meetingActivity.count();

    const first = await importCalendarEvent(tenantId, events[0]!, { mailbox: MINE, source: "CALDAV" });
    const second = await importCalendarEvent(tenantId, events[1]!, { mailbox: MINE, source: "CALDAV" });
    check("erstes Vorkommen angelegt", first.action, "created");
    check("zweites Vorkommen angelegt", second.action, "created");
    check("eigene Schluessel", first.icalUid !== second.icalUid, true);
    check("Schluessel traegt die RECURRENCE-ID", first.icalUid, `${SERIES_UID}#20260908T080000Z`);

    console.log("E. Der Termin traegt sein Postfach");
    const row = await prisma.meetingActivity.findFirst({ where: { icalUid: first.icalUid! } });
    check("Postfach vermerkt", row?.externalMailbox, MINE);
    check("Weg vermerkt", row?.externalSource, "CALDAV");
    check("Herkunft gesetzt", row?.externalOrigin, "OUTLOOK");

    console.log("F. Ein anderes Postfach sieht ihn nicht");
    const visible = (mailbox: string) => prisma.meetingActivity.count({
        where: {
            OR: [
                { tenantId, externalOrigin: null, id: row!.id },
                { tenantId, NOT: { externalOrigin: null }, externalMailbox: mailbox, id: row!.id },
            ],
        },
    });
    check("eigenes Postfach sieht ihn", await visible(MINE), 1);
    check("fremdes Postfach nicht", await visible(THEIRS), 0);
    check("ohne Postfach niemand", await visible(""), 0);

    console.log("G. Der Kalender fuehrt nach — dieselbe UID, neue Zeit");
    const moved = { ...events[0]!, start: new Date("2026-09-08T10:00:00Z"), end: new Date("2026-09-08T11:00:00Z"), sequence: 0 };
    const update = await importCalendarEvent(tenantId, moved, { mailbox: MINE, source: "CALDAV" });
    check("aktualisiert statt verdoppelt", update.action, "updated");
    check("dieselbe Zeile", update.meetingId, row?.id);
    const after = await prisma.meetingActivity.findFirst({ where: { icalUid: first.icalUid! } });
    check("neue Zeit uebernommen", after?.startTime?.toISOString(), "2026-09-08T10:00:00.000Z");

    // Aufräumen — der Lauf darf nichts hinterlassen.
    await prisma.meetingActivity.deleteMany({
        where: { icalUid: { in: [first.icalUid!, second.icalUid!] } },
    });
    check("Zeilenzahl wie vorher", await prisma.meetingActivity.count(), before);

    console.log(`\n${passed} von ${passed + failures.length} Prüfungen bestanden.`);
    for (const failure of failures) console.log(`  ${failure}`);
    await prisma.$disconnect();
    if (failures.length) process.exit(1);
};

main().catch((error) => { console.error(error?.message || error); process.exit(1); });
