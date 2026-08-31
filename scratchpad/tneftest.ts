/* Prüfstand für tnef.ts — ohne Datenbank, ohne Netz.
   Baut eine winmail.dat so, wie Outlook sie für eine Einladung schreibt, und
   liest sie mit dem eigenen Parser zurück; dazu die ECHTE Absage aus dem
   Postfach (tnef-sample-213.dat), falls sie daneben liegt.
   Lauf:  npx ts-node -T scratchpad/tneftest.ts                                */
import fs from "fs";
import { calendarEventsFromTnef, isTnef, parseTnef } from "../src/infrastructure/services/tnef";

let passed = 0;
const failures: string[] = [];
const check = (name: string, actual: unknown, expected: unknown) => {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) { passed += 1; console.log(`  ok  ${name}`); }
    else { failures.push(`${name}: erwartet ${e}, erhalten ${a}`); console.log(`  XX  ${name}: erwartet ${e}, erhalten ${a}`); }
};

/* ── Ein kleiner TNEF-SCHREIBER, nur für den Prüfstand ─────────────────────── */

const u32 = (value: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b; };
const u16 = (value: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b; };
const pad4 = (data: Buffer) => Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
const guidBytes = (guid: string) => {
    const [a, b, c, d, e] = guid.split("-");
    const swap = (hex: string) => Buffer.from(hex, "hex").reverse();
    return Buffer.concat([swap(a!), swap(b!), swap(c!), Buffer.from(d!, "hex"), Buffer.from(e!, "hex")]);
};
const fileTime = (date: Date) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(Math.round(date.getTime() + 11644473600000)) * 10000n);
    return b;
};

const PSETID_APPOINTMENT = "00062002-0000-0000-c000-000000000046";
const PSETID_MEETING = "6ed8da90-450b-101b-98da-00aa003f1305";
const PS_PUBLIC_STRINGS = "00020329-0000-0000-c000-000000000046";

type Prop = { tag: number; guid?: string; lid?: number; name?: string; value: string | number | boolean | Date | Buffer };
const encodeProp = (prop: Prop): Buffer => {
    const parts: Buffer[] = [u32(prop.tag)];
    const id = prop.tag >>> 16;
    if (id >= 0x8000) {
        parts.push(guidBytes(prop.guid!));
        if (prop.name !== undefined) {
            const name = Buffer.from(`${prop.name}\0`, "utf16le");
            parts.push(u32(1), u32(name.length), pad4(name));
        } else {
            parts.push(u32(0), u32(prop.lid!));
        }
    }
    const type = prop.tag & 0xffff;
    switch (type) {
        case 0x0003: parts.push(u32(prop.value as number)); break;
        case 0x000b: parts.push(u16(prop.value ? 1 : 0), u16(0)); break;
        case 0x0040: parts.push(fileTime(prop.value as Date)); break;
        case 0x001f: {
            const text = Buffer.from(`${prop.value as string}\0`, "utf16le");
            parts.push(u32(1), u32(text.length), pad4(text));
            break;
        }
        case 0x001e: {
            const text = Buffer.from(`${prop.value as string}\0`, "latin1");
            parts.push(u32(1), u32(text.length), pad4(text));
            break;
        }
        case 0x0102: {
            const data = prop.value as Buffer;
            parts.push(u32(1), u32(data.length), pad4(data));
            break;
        }
        default: throw new Error(`Prüfstand kennt Typ ${type.toString(16)} nicht`);
    }
    return Buffer.concat(parts);
};
const encodeBag = (props: Prop[]) => Buffer.concat([u32(props.length), ...props.map(encodeProp)]);
const attribute = (level: number, id: number, type: number, data: Buffer) =>
    Buffer.concat([Buffer.from([level]), u32((type << 16) | id), u32(data.length), data, u16(0)]);
const tnefFile = (attributes: Buffer[]) => Buffer.concat([u32(0x223e9f78), u16(0x1234), ...attributes]);

/** Die GlobalObjectId, wie Outlook sie für einen eigenen Termin baut. */
const globalObjectId = (occurrence?: { year: number; month: number; day: number }) => {
    const head = Buffer.from("040000008200E00074C5B7101A82E008", "hex");
    const date = Buffer.alloc(4);
    if (occurrence) { date.writeUInt16BE(occurrence.year, 0); date[2] = occurrence.month; date[3] = occurrence.day; }
    const stamp = Buffer.alloc(8);
    const tail = Buffer.concat([Buffer.alloc(8), u32(16), Buffer.from("0123456789abcdef", "hex")]);
    return Buffer.concat([head, date, stamp, tail]);
};

const start = new Date("2026-09-21T07:30:00Z");
const end = new Date("2026-09-21T08:15:00Z");
const messageProps = (extra: Prop[] = []): Prop[] => [
    { tag: 0x001a001e, value: "IPM.Schedule.Meeting.Request" },
    { tag: 0x0037001f, value: "Bauabnahme Müller — Küche" },
    { tag: 0x1000001f, value: "Bitte Pläne mitbringen.\r\n\r\n________________________________________________________________________________\r\nMicrosoft Teams-Besprechung\r\nhttps://teams.microsoft.com/l/meetup-join/19%3ameeting_TNEF%40thread.v2/0" },
    { tag: 0x5d02001f, value: "anna.meier@partnerbau.ch" },
    { tag: 0x0042001f, value: "Anna Meier" },
    { tag: 0x820d0040, guid: PSETID_APPOINTMENT, lid: 0x820d, value: start },
    { tag: 0x820e0040, guid: PSETID_APPOINTMENT, lid: 0x820e, value: end },
    { tag: 0x8208001f, guid: PSETID_APPOINTMENT, lid: 0x8208, value: "Baustelle Müller, Zürich" },
    { tag: 0x82010003, guid: PSETID_APPOINTMENT, lid: 0x8201, value: 3 },
    { tag: 0x8223000b, guid: PSETID_APPOINTMENT, lid: 0x8223, value: false },
    { tag: 0x80030102, guid: PSETID_MEETING, lid: 0x0003, value: globalObjectId() },
    { tag: 0x80230102, guid: PSETID_MEETING, lid: 0x0023, value: globalObjectId() },
    { tag: 0x8100001f, guid: PS_PUBLIC_STRINGS, name: "SkypeTeamsMeetingUrl", value: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_TNEF%40thread.v2/0" },
    ...extra,
];
const recipientRow = (name: string, smtp: string, kind: number): Prop[] => [
    { tag: 0x3001001f, value: name },
    { tag: 0x39fe001f, value: smtp },
    { tag: 0x3003001f, value: "/o=Exchange/ou=First Administrative Group/cn=Recipients/cn=x" },
    { tag: 0x0c150003, value: kind },
];
const recipTable = (rows: Prop[][]) => Buffer.concat([u32(rows.length), ...rows.map(encodeBag)]);

const buildInvitation = (extra: Prop[] = [], attachments: Buffer[] = []) => tnefFile([
    attribute(1, 0x9006, 8, u32(0x10000)),
    attribute(1, 0x9007, 6, Buffer.concat([u32(1252), u32(0)])),
    attribute(1, 0x8008, 7, Buffer.from("IPM.Microsoft Schedule.MtgReq\0", "latin1")),
    attribute(1, 0x9004, 6, recipTable([
        recipientRow("Barış Şahin", "sahin@offitec.ch", 1),
        recipientRow("Offitec", "sck@offitec.eu", 2),
        recipientRow("Heimlich", "bcc@example.com", 3),
    ])),
    attribute(1, 0x9003, 6, encodeBag(messageProps(extra))),
    ...attachments,
]);

const main = () => {
    console.log("1. Einladung aus Outlook als winmail.dat");
    const invitation = buildInvitation();
    check("ist TNEF", isTnef(invitation), true);
    const parsed = parseTnef(invitation)!;
    check("Klasse (TNEF-Schreibweise)", parsed.messageClass, "IPM.Microsoft Schedule.MtgReq");
    check("Codepage", parsed.codepage, 1252);
    check("Empfängerzeilen", parsed.recipients.length, 3);
    const events = calendarEventsFromTnef(invitation);
    check("genau ein Termin", events.length, 1);
    const event = events[0]!;
    check("Methode", event.method, "REQUEST");
    check("UID = GlobalObjectId hexadezimal", event.uid, globalObjectId().toString("hex").toUpperCase());
    check("Betreff (Unicode, Umlaut, Gedankenstrich)", event.summary, "Bauabnahme Müller — Küche");
    check("Beginn (UTC aus StartWhole)", event.start?.toISOString(), "2026-09-21T07:30:00.000Z");
    check("Ende", event.end?.toISOString(), "2026-09-21T08:15:00.000Z");
    check("Ort", event.location, "Baustelle Müller, Zürich");
    check("SEQUENCE", event.sequence, 3);
    check("Organisator", event.organizer, { email: "anna.meier@partnerbau.ch", name: "Anna Meier" });
    check("Teilnehmende ohne BCC, SMTP statt X.500", event.attendees.map((a) => a.email), ["sahin@offitec.ch", "sck@offitec.eu"]);
    check("Teams-Link aus benannter Eigenschaft", event.onlineUrl, "https://teams.microsoft.com/l/meetup-join/19%3ameeting_TNEF%40thread.v2/0");
    check("kein Serientermin", event.recurring, false);
    check("kein Vorkommen", event.recurrenceId, null);
    check("nicht abgesagt", event.cancelled, false);

    console.log("2. Absage");
    const cancel = calendarEventsFromTnef(buildInvitation([{ tag: 0x001a001e, value: "IPM.Schedule.Meeting.Canceled" }]))[0]!;
    check("Methode CANCEL", cancel.method, "CANCEL");
    check("abgesagt", cancel.cancelled, true);
    check("dieselbe UID", cancel.uid, globalObjectId().toString("hex").toUpperCase());

    console.log("3. Serienkopf");
    const series = calendarEventsFromTnef(buildInvitation([{ tag: 0x8223000b, guid: PSETID_APPOINTMENT, lid: 0x8223, value: true }]))[0]!;
    check("als Serie erkannt", series.recurring, true);

    console.log("4. Einzelnes Vorkommen einer Serie");
    const occurrence = calendarEventsFromTnef(buildInvitation([
        { tag: 0x8223000b, guid: PSETID_APPOINTMENT, lid: 0x8223, value: true },
        { tag: 0x80030102, guid: PSETID_MEETING, lid: 0x0003, value: globalObjectId({ year: 2026, month: 9, day: 28 }) },
    ]))[0]!;
    check("Schlüssel der Serie (Clean)", occurrence.uid, globalObjectId().toString("hex").toUpperCase());
    check("RECURRENCE-ID aus Bytes 16–19", occurrence.recurrenceId, "20260928");
    check("kein Serienkopf mehr", occurrence.recurring, false);

    console.log("5. Fremde UID im vCal-Uid-Mantel (unsere eigene Einladung kommt zurück)");
    const wrapped = Buffer.concat([
        Buffer.from("040000008200E00074C5B7101A82E008", "hex"), Buffer.alloc(12),
        u32(0), Buffer.from("vCal-Uid", "latin1"), u32(1), Buffer.from("offitec-vRLVRx7uXm@offitec.eu\0", "latin1"),
    ]);
    const own = calendarEventsFromTnef(buildInvitation([
        { tag: 0x80030102, guid: PSETID_MEETING, lid: 0x0003, value: wrapped },
        { tag: 0x80230102, guid: PSETID_MEETING, lid: 0x0023, value: wrapped },
    ]))[0]!;
    check("Original-UID zurückgewonnen", own.uid, "offitec-vRLVRx7uXm@offitec.eu");

    console.log("6. Eine .ics als Anhang im TNEF gewinnt");
    const ics = [
        "BEGIN:VCALENDAR", "METHOD:REQUEST", "VERSION:2.0", "BEGIN:VEVENT",
        "UID:ics-inside-tnef@partnerbau.ch", "SUMMARY:Aus der Datei", "DTSTART:20260922T060000Z", "DTEND:20260922T070000Z",
        "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const withIcs = buildInvitation([], [
        attribute(2, 0x9002, 6, Buffer.alloc(32)),
        attribute(2, 0x8010, 1, Buffer.from("einladung.ics\0", "latin1")),
        attribute(2, 0x800f, 6, Buffer.from(ics, "utf8")),
    ]);
    const parsedIcs = parseTnef(withIcs)!;
    check("Anhang erkannt", parsedIcs.attachments.map((a) => a.filename), ["einladung.ics"]);
    const fromIcs = calendarEventsFromTnef(withIcs);
    check("Termin aus der .ics, nicht aus der Nachricht", fromIcs.map((e) => e.uid), ["ics-inside-tnef@partnerbau.ch"]);

    console.log("7. Türkische Codepage (1254) in 8-Bit-Texten");
    const turkish = tnefFile([
        attribute(1, 0x9007, 6, Buffer.concat([u32(1254), u32(0)])),
        attribute(1, 0x8008, 7, Buffer.from("IPM.Microsoft Schedule.MtgReq\0", "latin1")),
        attribute(1, 0x8004, 1, Buffer.from([0x54, 0x6f, 0x70, 0x6c, 0x61, 0x6e, 0x74, 0xfd, 0x20, 0xde, 0x61, 0x68, 0x69, 0x6e, 0x00])), // "Toplantı Şahin" in cp1254
        attribute(1, 0x0006, 3, Buffer.concat([u16(2026), u16(9), u16(21), u16(9), u16(0), u16(0), u16(1)])),
        attribute(1, 0x9003, 6, encodeBag([
            { tag: 0x80030102, guid: PSETID_MEETING, lid: 0x0003, value: globalObjectId() },
        ])),
    ]);
    const tr = calendarEventsFromTnef(turkish)[0]!;
    check("Betreff aus attSubject in cp1254", tr.summary, "Toplantı Şahin");
    check("Beginn aus der TNEF-Datumsstruktur", tr.start?.getHours(), 9);
    check("Ende = Beginn + 1 h ohne Angabe", (tr.end!.getTime() - tr.start!.getTime()) / 60000, 60);

    console.log("8. Kein TNEF / keine Einladung");
    check("Textdatei", calendarEventsFromTnef(Buffer.from("BEGIN:VCALENDAR")), []);
    check("leer", calendarEventsFromTnef(Buffer.alloc(0)), []);
    check("gewöhnliche Mail im TNEF", calendarEventsFromTnef(tnefFile([
        attribute(1, 0x8008, 7, Buffer.from("IPM.Note\0", "latin1")),
        attribute(1, 0x9003, 6, encodeBag([{ tag: 0x0037001f, value: "Nur eine Mail" }])),
    ])), []);

    const sample = `${__dirname}/tnef-sample-213.dat`;
    if (fs.existsSync(sample)) {
        console.log("9. Die echte Absage aus dem Postfach (winmail.dat, cp1254)");
        const real = calendarEventsFromTnef(fs.readFileSync(sample));
        check("ein Termin", real.length, 1);
        check("Antwort auf eine Einladung", real[0]?.method, "REPLY");
        check("unsere eigene UID zurückgewonnen", real[0]?.uid, "offitec-vRLVRx7uXm@offitec.eu");
        check("Ort aus benannter Eigenschaft", Boolean(real[0]?.location), true);
    }

    console.log(`\n${passed} von ${passed + failures.length} Prüfungen bestanden.`);
    process.exit(failures.length ? 1 : 0);
};

main();
