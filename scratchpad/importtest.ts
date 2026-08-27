/* Durchlauf des Kalenderimports gegen die echte Datenbank. Legt EINEN
   Testtermin an und räumt ihn am Ende wieder weg; die Zeilenzahl am Schluss
   muss der vom Anfang entsprechen.
   Lauf:  npx ts-node -T -r dotenv/config scratchpad/importtest.ts           */
import prisma from "../src/infrastructure/database/prisma.client";
import { importCalendarObject } from "../src/infrastructure/services/calendarImportService";
import { nanoid } from "nanoid";

const stamp = Date.now();
const UID = `claude-test-${stamp}@partnerbau.ch`;
const LOCAL_UID = `claude-local-${stamp}@offitec.eu`;

const teamsIcs = (uid: string, sequence: number, summary: string, hour: string, method = "REQUEST") => [
    "BEGIN:VCALENDAR",
    `METHOD:${method}`,
    "PRODID:Microsoft Exchange Server 2010",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "ORGANIZER;CN=\"Meier, Anna\":mailto:anna.meier@partnerbau.ch",
    "ATTENDEE;ROLE=REQ-PARTICIPANT;CN=info@offitec.eu:mailto:info@offitec.eu",
    "DESCRIPTION;LANGUAGE=de-CH:Abstimmung zur Ausschreibung.\\n\\n____________________",
    " ____________________________________________\\nMicrosoft Teams-Besprechung\\nHier",
    " klicken\\, um teilzunehmen<https://teams.microsoft.com/l/meetup-join/19%3ameeti",
    " ng_TEST%40thread.v2/0>\\nBesprechungs-ID: 123 456 789\\n____________________________\\n",
    `UID:${uid}`,
    `SUMMARY;LANGUAGE=de-CH:${summary}`,
    `DTSTART:20260915T${hour}0000Z`,
    `DTEND:20260915T${hour}3000Z`,
    "X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/19%3ameeting_TEST%40thread.v2/0",
    "LOCATION;LANGUAGE=de-CH:Microsoft Teams-Besprechung",
    `SEQUENCE:${sequence}`,
    "BEGIN:VALARM",
    "DESCRIPTION:Erinnerung",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
].join("\r\n");

let passed = 0;
const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed += 1; console.log(`  ok  ${name}`); }
    else { failures.push(`${name}: erwartet ${e}, erhalten ${a}`); console.log(`  XX  ${name}: erwartet ${e}, erhalten ${a}`); }
};

const rowOf = (uid: string) => (prisma as any).meetingActivity.findFirst({ where: { icalUid: uid } });

const main = async () => {
    const seed = await (prisma as any).meetingActivity.findFirst({ where: { externalOrigin: { not: null } }, select: { tenantId: true } });
    const tenantId: string = seed?.tenantId || (await prisma.tenant.findFirst({ select: { id: true } }))!.id;
    const before = await (prisma as any).meetingActivity.count();
    console.log(`Mandant ${tenantId}, ${before} Termine vor dem Lauf.\n`);

    console.log("1. Teams-Einladung kommt herein");
    const created = await importCalendarObject(tenantId, teamsIcs(UID, 1, "Claude Testtermin", "09"), {
        senderEmail: "anna.meier@partnerbau.ch", customerId: null, employeeId: null, direction: "IN",
    });
    check("angelegt", created.action, "created");
    const row1 = await rowOf(UID);
    check("Titel", row1?.title, "Claude Testtermin");
    check("Herkunft TEAMS", row1?.externalOrigin, "TEAMS");
    check("Organisator", row1?.externalOrganizer, "anna.meier@partnerbau.ch");
    check("Beitrittslink", row1?.meetingUrl, "https://teams.microsoft.com/l/meetup-join/19%3ameeting_TEST%40thread.v2/0");
    check("Notiz ohne Teams-Block", String(row1?.notes || "").split("\n")[0], "Abstimmung zur Ausschreibung.");
    check("Startzeit", row1?.startTime?.toISOString(), "2026-09-15T09:00:00.000Z");

    console.log("2. Dieselbe Einladung, neue Fassung (verschoben + umbenannt)");
    const updated = await importCalendarObject(tenantId, teamsIcs(UID, 2, "Claude Testtermin verschoben", "14"), {
        senderEmail: "anna.meier@partnerbau.ch", customerId: null, employeeId: null, direction: "IN",
    });
    check("aktualisiert", updated.action, "updated");
    check("dieselbe Zeile", updated.meetingId, row1?.id);
    const row2 = await rowOf(UID);
    check("neuer Titel", row2?.title, "Claude Testtermin verschoben");
    check("neue Zeit", row2?.startTime?.toISOString(), "2026-09-15T14:00:00.000Z");
    check("kein zweiter Eintrag", await (prisma as any).meetingActivity.count({ where: { icalUid: UID } }), 1);

    console.log("3. Ältere Fassung kommt hinterher");
    const stale = await importCalendarObject(tenantId, teamsIcs(UID, 1, "Alte Fassung", "09"), {
        senderEmail: "anna.meier@partnerbau.ch", customerId: null, employeeId: null, direction: "IN",
    });
    check("übersprungen", stale.action, "ignored");
    check("Grund", stale.reason, "ältere Fassung");
    check("Titel unverändert", (await rowOf(UID))?.title, "Claude Testtermin verschoben");

    console.log("4. Eigene Einladung (offitec-UID) kommt als Kopie zurück");
    const own = await importCalendarObject(tenantId, teamsIcs("offitec-xyz@offitec.eu", 1, "Eigener Termin", "10"), {
        senderEmail: "info@offitec.eu", customerId: null, employeeId: null, direction: "OUT",
    });
    check("übersprungen", own.action, "ignored");
    check("Grund", own.reason, "eigene Einladung");

    console.log("5. Im System angelegter Termin mit derselben UID");
    const employee = await prisma.employee.findFirst({ where: { tenantId, isActive: true, deletedAt: null }, select: { id: true } });
    const local = await (prisma as any).meetingActivity.create({
        data: {
            id: nanoid(12), tenantId, kind: "MEETING", title: "Von Hand angelegt",
            startTime: new Date("2026-09-16T08:00:00Z"), endTime: new Date("2026-09-16T09:00:00Z"),
            createdByEmployeeId: employee!.id, icalUid: LOCAL_UID, icalSequence: 0,
        },
        select: { id: true },
    });
    const overwrite = await importCalendarObject(tenantId, teamsIcs(LOCAL_UID, 5, "Von aussen überschrieben", "17"), {
        senderEmail: "anna.meier@partnerbau.ch", customerId: null, employeeId: null, direction: "IN",
    });
    check("übersprungen", overwrite.action, "ignored");
    check("Grund", overwrite.reason, "im System angelegter Termin");
    const localRow = await rowOf(LOCAL_UID);
    check("Titel unangetastet", localRow?.title, "Von Hand angelegt");
    check("Zeit unangetastet", localRow?.startTime?.toISOString(), "2026-09-16T08:00:00.000Z");
    check("kein Doppel daneben", await (prisma as any).meetingActivity.count({ where: { icalUid: LOCAL_UID } }), 1);

    console.log("6. Serientermin");
    const series = await importCalendarObject(
        tenantId,
        teamsIcs(`claude-series-${stamp}@partnerbau.ch`, 1, "Wöchentlich", "11").replace("SEQUENCE:1", "RRULE:FREQ=WEEKLY;BYDAY=TU\r\nSEQUENCE:1"),
        { senderEmail: "anna.meier@partnerbau.ch", customerId: null, employeeId: null, direction: "IN" },
    );
    check("übersprungen", series.action, "ignored");
    check("Grund", series.reason, "Serientermin");

    console.log("7. Absage aus Outlook");
    const cancelled = await importCalendarObject(tenantId, teamsIcs(UID, 3, "Claude Testtermin verschoben", "14", "CANCEL"), {
        senderEmail: "anna.meier@partnerbau.ch", customerId: null, employeeId: null, direction: "IN",
    });
    check("abgesagt", cancelled.action, "cancelled");
    check("Zeile weg", await rowOf(UID), null);

    console.log("8. Absage für einen SELBST angelegten Termin");
    const cancelLocal = await importCalendarObject(tenantId, teamsIcs(LOCAL_UID, 9, "Von Hand angelegt", "08", "CANCEL"), {
        senderEmail: "anna.meier@partnerbau.ch", customerId: null, employeeId: null, direction: "IN",
    });
    check("übersprungen", cancelLocal.action, "ignored");
    check("Zeile steht noch", Boolean(await rowOf(LOCAL_UID)), true);

    // Aufräumen: der von Hand angelegte Testtermin.
    await (prisma as any).meetingActivity.delete({ where: { id: local.id } });
    const after = await (prisma as any).meetingActivity.count();
    check("Zeilenzahl wie vorher", after, before);

    console.log(`\n${passed} von ${passed + failures.length} Prüfungen bestanden.`);
    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
};

main().catch(async (error) => {
    console.error(error?.message || error);
    await prisma.$disconnect();
    process.exit(1);
});
