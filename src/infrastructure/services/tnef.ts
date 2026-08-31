import type { ParsedCalendarEvent } from "./calendarInvite";
import { parseCalendarObjects } from "./calendarInvite";

/**
 * WINMAIL.DAT → TERMIN (14.09.2026, Samet: «du kannst auch aus den .dat-Dateien
 * ziehen»).
 *
 * Outlook verschickt eine Einladung nicht immer als `text/calendar`. Steht der
 * Absender auf Rich-Text — oder redet Exchange mit sich selbst —, wandert die
 * GANZE Nachricht als TNEF-Blob in einen Anhang namens `winmail.dat`
 * (`application/ms-tnef`). Für jeden anderen Mailserver ist das eine Datei mit
 * Rauschen; der Termin darin war für den Import unsichtbar.
 *
 * TNEF ([MS-OXTNEF]) ist kein iCalendar, sondern die serialisierte
 * MAPI-Nachricht: Betreff, Rumpf, Empfängertabelle und ein Block mit
 * MAPI-EIGENSCHAFTEN, in dem Anfang, Ende, Ort, Serienkennzeichen und die
 * `GlobalObjectId` des Termins stehen. Zwei Wege führen von dort zum Termin:
 *
 *   1. Als ANHANG im TNEF steckt eine `.ics` (jemand hat eine Einladung
 *      weitergeleitet). Dann wird sie herausgelöst und geht denselben Weg wie
 *      eine gewöhnliche Einladung.
 *   2. Die Nachricht IST die Einladung (`IPM.Schedule.Meeting.Request` und
 *      Verwandte). Dann wird der Termin aus den MAPI-Eigenschaften gebaut.
 *
 * Der SCHLÜSSEL ist in beiden Welten derselbe: Outlook schreibt als
 * iCalendar-UID die hexadezimale `GlobalObjectId`. Ein Termin, der einmal als
 * .ics und einmal als winmail.dat hereinkommt, landet darum auf EINER Zeile.
 *
 * Handgeschrieben wie der Rest des Mailstapels — kein Paket. Gelesen wird nur,
 * was der Termin braucht; alles andere (Bilder, RTF, Formatierung) wird
 * übersprungen, nie ausgewertet.
 */

/* ── TNEF-Rahmen ──────────────────────────────────────────────────────────── */

const TNEF_SIGNATURE = 0x223e9f78;

/** Attribut-IDs (die unteren 16 Bit der Attributkennung). */
const ATT = {
    DATE_START: 0x0006,
    DATE_END: 0x0007,
    FROM: 0x8000,
    SUBJECT: 0x8004,
    MESSAGE_CLASS: 0x8008,
    BODY: 0x800c,
    ATTACH_DATA: 0x800f,
    ATTACH_TITLE: 0x8010,
    ATTACH_RENDDATA: 0x9002,
    MAPI_PROPS: 0x9003,
    RECIP_TABLE: 0x9004,
    ATTACHMENT: 0x9005,
    OEM_CODEPAGE: 0x9007,
} as const;

const LEVEL_MESSAGE = 1;
const LEVEL_ATTACHMENT = 2;

/* ── MAPI-Eigenschaften ───────────────────────────────────────────────────── */

const PT = {
    I2: 0x0002, LONG: 0x0003, R4: 0x0004, DOUBLE: 0x0005, CURRENCY: 0x0006, APPTIME: 0x0007,
    ERROR: 0x000a, BOOLEAN: 0x000b, OBJECT: 0x000d, I8: 0x0014, STRING8: 0x001e, UNICODE: 0x001f,
    SYSTIME: 0x0040, CLSID: 0x0048, BINARY: 0x0102, MV_FLAG: 0x1000,
} as const;

/** Benannte Eigenschaften: der Namensraum, in dem die LID gilt. */
const PSETID = {
    APPOINTMENT: "00062002-0000-0000-c000-000000000046",
    MEETING: "6ed8da90-450b-101b-98da-00aa003f1305",
    COMMON: "00062008-0000-0000-c000-000000000046",
    PUBLIC_STRINGS: "00020329-0000-0000-c000-000000000046",
} as const;

/** Standard-Tags (Kennung = Property-ID, oberes Wort des Tags). */
const TAG = {
    MESSAGE_CLASS: 0x001a, SUBJECT: 0x0037, SENT_REPRESENTING_NAME: 0x0042,
    SENT_REPRESENTING_EMAIL: 0x0065, START_DATE: 0x0060, END_DATE: 0x0061,
    RECIPIENT_TYPE: 0x0c15, SENDER_NAME: 0x0c1a, SENDER_EMAIL: 0x0c1f,
    BODY: 0x1000, DISPLAY_NAME: 0x3001, ADDRTYPE: 0x3002, EMAIL_ADDRESS: 0x3003,
    ATTACH_DATA_BIN: 0x3701, ATTACH_FILENAME: 0x3704, ATTACH_LONG_FILENAME: 0x3707, ATTACH_MIME_TAG: 0x370e,
    SMTP_ADDRESS: 0x39fe, SENDER_SMTP: 0x5d01, SENT_REPRESENTING_SMTP: 0x5d02,
} as const;

/** Benannte Eigenschaften des Termins (LID im jeweiligen Namensraum). */
const LID = {
    // PSETID_Meeting
    GLOBAL_OBJECT_ID: 0x0003, IS_RECURRING: 0x0005, CLEAN_GLOBAL_OBJECT_ID: 0x0023,
    // PSETID_Appointment
    APPOINTMENT_SEQUENCE: 0x8201, LOCATION: 0x8208, START_WHOLE: 0x820d, END_WHOLE: 0x820e,
    RECURRING: 0x8223,
    // PSETID_Common
    COMMON_START: 0x8516, COMMON_END: 0x8517,
} as const;

type PropValue = string | number | boolean | Date | Buffer | null;

/** Eine gelesene Eigenschaft; `key` ist `tag:xxxx` oder `guid:lid` / `guid:name`. */
interface MapiProperty {
    key: string;
    type: number;
    values: PropValue[];
}

type PropertyBag = Map<string, MapiProperty>;

const keyOfTag = (id: number) => `tag:${id.toString(16).padStart(4, "0")}`;
const keyOfLid = (guid: string, lid: number) => `${guid}:${lid.toString(16).padStart(4, "0")}`;
const keyOfName = (guid: string, name: string) => `${guid}:${name.toLowerCase()}`;

const pad4 = (length: number) => (length + 3) & ~3;

/** Windows FILETIME (100-ns-Schritte seit 1601) → Date. */
const fileTimeToDate = (buffer: Buffer, offset: number): Date | null => {
    const low = buffer.readUInt32LE(offset);
    const high = buffer.readUInt32LE(offset + 4);
    if (!low && !high) return null;
    const ms = (high * 4294967296 + low) / 10000 - 11644473600000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
};

/** OLE-Datum (Tage seit 30.12.1899, als Double) → Date. */
const appTimeToDate = (days: number): Date | null => {
    if (!Number.isFinite(days) || !days) return null;
    return new Date(Date.UTC(1899, 11, 30) + days * 86_400_000);
};

const guidOf = (buffer: Buffer, offset: number): string => {
    const hex = (start: number, length: number) => buffer.subarray(offset + start, offset + start + length).toString("hex");
    const swap = (value: string) => value.match(/../g)!.reverse().join("");
    return `${swap(hex(0, 4))}-${swap(hex(4, 2))}-${swap(hex(6, 2))}-${hex(8, 2)}-${hex(10, 6)}`.toLowerCase();
};

/**
 * Texte in 8-Bit-Kodierung: die Codepage steht als `attOemCodepage` vorn im
 * TNEF (Outlook Türkisch = 1254, Deutsch = 1252). Node kennt die
 * Windows-Codepages über den TextDecoder; ohne ihn bleibt Latin-1.
 */
const decodeString8 = (bytes: Buffer, codepage: number): string => {
    const trimmed = bytes.subarray(0, bytes.indexOf(0) >= 0 ? bytes.indexOf(0) : bytes.length);
    if (codepage === 65001) return trimmed.toString("utf8");
    try {
        return new TextDecoder(`windows-${codepage || 1252}`).decode(trimmed);
    } catch {
        return trimmed.toString("latin1");
    }
};

const decodeUnicode = (bytes: Buffer): string => {
    const text = bytes.toString("utf16le");
    const end = text.indexOf("\0");
    return end >= 0 ? text.slice(0, end) : text;
};

/**
 * Ein Block von MAPI-Eigenschaften ([MS-OXTNEF] 2.1.3.4.3): Anzahl, dann je
 * Eigenschaft Tag, bei benannten Eigenschaften GUID + Name/LID, bei
 * mehrwertigen und variabel langen Typen eine Anzahl, dann die Werte, alles
 * auf 4 Byte aufgefüllt. Liefert das Ende des Blocks zurück, damit die
 * Empfängertabelle (mehrere Blöcke hintereinander) durchlaufen werden kann.
 */
const readPropertyBag = (buffer: Buffer, start: number, codepage: number): { bag: PropertyBag; end: number } => {
    const bag: PropertyBag = new Map();
    if (start + 4 > buffer.length) return { bag, end: buffer.length };
    const count = buffer.readUInt32LE(start);
    let offset = start + 4;

    for (let index = 0; index < count && offset + 4 <= buffer.length; index += 1) {
        const tag = buffer.readUInt32LE(offset);
        offset += 4;
        const type = tag & 0xffff;
        const id = tag >>> 16;
        const baseType = type & ~PT.MV_FLAG;
        const multi = (type & PT.MV_FLAG) !== 0;

        let key = keyOfTag(id);
        if (id >= 0x8000) {
            if (offset + 20 > buffer.length) break;
            const guid = guidOf(buffer, offset);
            const kind = buffer.readUInt32LE(offset + 16);
            offset += 20;
            if (kind === 0) {
                key = keyOfLid(guid, buffer.readUInt32LE(offset));
                offset += 4;
            } else {
                const length = buffer.readUInt32LE(offset);
                offset += 4;
                key = keyOfName(guid, decodeUnicode(buffer.subarray(offset, offset + length)));
                offset += pad4(length);
            }
        }

        const variable = baseType === PT.STRING8 || baseType === PT.UNICODE || baseType === PT.BINARY || baseType === PT.OBJECT;
        let valueCount = 1;
        if (multi || variable) {
            if (offset + 4 > buffer.length) break;
            valueCount = buffer.readUInt32LE(offset);
            offset += 4;
        }

        const values: PropValue[] = [];
        for (let v = 0; v < valueCount && offset <= buffer.length; v += 1) {
            switch (baseType) {
                case PT.I2:
                    values.push(buffer.readInt16LE(offset)); offset += 4; break;
                case PT.LONG: case PT.ERROR:
                    values.push(buffer.readInt32LE(offset)); offset += 4; break;
                case PT.R4:
                    values.push(buffer.readFloatLE(offset)); offset += 4; break;
                case PT.BOOLEAN:
                    values.push(buffer.readUInt16LE(offset) !== 0); offset += 4; break;
                case PT.DOUBLE:
                    values.push(buffer.readDoubleLE(offset)); offset += 8; break;
                case PT.APPTIME:
                    values.push(appTimeToDate(buffer.readDoubleLE(offset))); offset += 8; break;
                case PT.CURRENCY: case PT.I8:
                    values.push(Number(buffer.readBigInt64LE(offset))); offset += 8; break;
                case PT.SYSTIME:
                    values.push(fileTimeToDate(buffer, offset)); offset += 8; break;
                case PT.CLSID:
                    values.push(guidOf(buffer, offset)); offset += 16; break;
                case PT.STRING8: case PT.UNICODE: case PT.BINARY: case PT.OBJECT: {
                    if (offset + 4 > buffer.length) { offset = buffer.length; break; }
                    const length = buffer.readUInt32LE(offset);
                    offset += 4;
                    let data = buffer.subarray(offset, Math.min(buffer.length, offset + length));
                    offset += pad4(length);
                    // Ein eingebettetes Objekt beginnt mit der IID (16 Byte);
                    // der Anhang selbst kommt danach.
                    if (baseType === PT.OBJECT && data.length >= 16) data = data.subarray(16);
                    values.push(
                        baseType === PT.STRING8 ? decodeString8(data, codepage)
                            : baseType === PT.UNICODE ? decodeUnicode(data)
                                : Buffer.from(data),
                    );
                    break;
                }
                default:
                    // Unbekannter Typ: der Block ist ab hier nicht mehr lesbar.
                    return { bag, end: buffer.length };
            }
        }
        bag.set(key, { key, type, values });
    }
    return { bag, end: offset };
};

const first = (bag: PropertyBag | undefined, key: string): PropValue => bag?.get(key)?.values[0] ?? null;
const text = (bag: PropertyBag | undefined, key: string): string | null => {
    const value = first(bag, key);
    return typeof value === "string" ? value.trim() || null : null;
};
const date = (bag: PropertyBag | undefined, key: string): Date | null => {
    const value = first(bag, key);
    return value instanceof Date ? value : null;
};
const bytes = (bag: PropertyBag | undefined, key: string): Buffer | null => {
    const value = first(bag, key);
    return Buffer.isBuffer(value) && value.length ? value : null;
};
const flag = (bag: PropertyBag | undefined, key: string): boolean => first(bag, key) === true;
const number = (bag: PropertyBag | undefined, key: string): number | null => {
    const value = first(bag, key);
    return typeof value === "number" ? value : null;
};

/* ── Die Nachricht ───────────────────────────────────────────────────────── */

export interface TnefAttachment {
    filename: string | null;
    mimeType: string | null;
    data: Buffer | null;
}

export interface TnefMessage {
    messageClass: string | null;
    codepage: number;
    subject: string | null;
    body: string | null;
    /** attDateStart/attDateEnd — Ortszeit des Absenders, ohne Zeitzone. */
    dateStart: Date | null;
    dateEnd: Date | null;
    props: PropertyBag;
    recipients: PropertyBag[];
    attachments: TnefAttachment[];
}

/** TNEF-Datumsstruktur (DTR): sieben WORDs — Jahr, Monat, Tag, Stunde, Minute, Sekunde, Wochentag. */
const readDtr = (data: Buffer): Date | null => {
    if (data.length < 12) return null;
    const [year, month, day, hour, minute, second] = [0, 2, 4, 6, 8, 10].map((at) => data.readUInt16LE(at));
    if (!year || !month || !day) return null;
    // Wie `parseIcalDate` ohne Zeitzone: die lokale Auslegung des Servers.
    const value = new Date(year, month! - 1, day!, hour, minute, second);
    return Number.isNaN(value.getTime()) ? null : value;
};

/** Ist das überhaupt ein TNEF? Die Signatur steht in den ersten vier Bytes. */
export const isTnef = (buffer: Buffer): boolean =>
    buffer.length >= 6 && buffer.readUInt32LE(0) === TNEF_SIGNATURE;

/**
 * Den TNEF-Strom in seine Attribute zerlegen. Jedes Attribut: Ebene (1 Byte),
 * Kennung (4), Länge (4), Daten, Prüfsumme (2). Die Prüfsumme wird nicht
 * geprüft — ein verstümmelter Strom endet einfach früher.
 */
export const parseTnef = (buffer: Buffer): TnefMessage | null => {
    if (!isTnef(buffer)) return null;
    const message: TnefMessage = {
        messageClass: null, codepage: 1252, subject: null, body: null,
        dateStart: null, dateEnd: null, props: new Map(), recipients: [], attachments: [],
    };
    let current: TnefAttachment | null = null;
    // Kopf: Signatur (4) + Schlüssel (2).
    let offset = 6;

    while (offset + 9 <= buffer.length) {
        const level = buffer[offset]!;
        const attribute = buffer.readUInt32LE(offset + 1);
        const length = buffer.readUInt32LE(offset + 5);
        const dataStart = offset + 9;
        const dataEnd = Math.min(buffer.length, dataStart + length);
        const data = buffer.subarray(dataStart, dataEnd);
        offset = dataEnd + 2;
        const id = attribute & 0xffff;

        if (level === LEVEL_ATTACHMENT) {
            // attAttachRenddata eröffnet jeden Anhang; alles bis zum nächsten gehört dazu.
            if (id === ATT.ATTACH_RENDDATA || !current) {
                current = { filename: null, mimeType: null, data: null };
                message.attachments.push(current);
                if (id === ATT.ATTACH_RENDDATA) continue;
            }
            if (id === ATT.ATTACH_DATA) current.data = Buffer.from(data);
            else if (id === ATT.ATTACH_TITLE) current.filename = decodeString8(data, message.codepage) || current.filename;
            else if (id === ATT.ATTACHMENT) {
                const { bag } = readPropertyBag(data, 0, message.codepage);
                current.filename = text(bag, keyOfTag(TAG.ATTACH_LONG_FILENAME)) || text(bag, keyOfTag(TAG.ATTACH_FILENAME)) || current.filename;
                current.mimeType = text(bag, keyOfTag(TAG.ATTACH_MIME_TAG)) || current.mimeType;
                current.data = current.data || bytes(bag, keyOfTag(TAG.ATTACH_DATA_BIN));
            }
            continue;
        }
        if (level !== LEVEL_MESSAGE) continue;

        switch (id) {
            case ATT.OEM_CODEPAGE:
                if (data.length >= 4) message.codepage = data.readUInt32LE(0) || 1252;
                break;
            case ATT.MESSAGE_CLASS:
                message.messageClass = decodeString8(data, message.codepage) || null;
                break;
            case ATT.SUBJECT:
                message.subject = decodeString8(data, message.codepage) || null;
                break;
            case ATT.BODY:
                message.body = decodeString8(data, message.codepage) || null;
                break;
            case ATT.DATE_START:
                message.dateStart = readDtr(data);
                break;
            case ATT.DATE_END:
                message.dateEnd = readDtr(data);
                break;
            case ATT.MAPI_PROPS: {
                const { bag } = readPropertyBag(data, 0, message.codepage);
                for (const [key, property] of bag) message.props.set(key, property);
                break;
            }
            case ATT.RECIP_TABLE: {
                if (data.length < 4) break;
                const rows = data.readUInt32LE(0);
                let at = 4;
                for (let row = 0; row < rows && at < data.length; row += 1) {
                    const { bag, end } = readPropertyBag(data, at, message.codepage);
                    message.recipients.push(bag);
                    if (end <= at) break;
                    at = end;
                }
                break;
            }
            default:
                break;
        }
    }
    return message;
};

/* ── Vom TNEF zum Termin ──────────────────────────────────────────────────── */

/**
 * Die Klasse sagt, was die Nachricht ist. Outlook schreibt sie in TNEF alt
 * (`IPM.Microsoft Schedule.MtgReq`) und in MAPI neu (`IPM.Schedule.Meeting.Request`);
 * beide Schreibweisen werden verstanden.
 */
const methodOfClass = (messageClass: string | null): ParsedCalendarEvent["method"] | null => {
    const value = String(messageClass || "").toLowerCase();
    if (!value) return null;
    if (/schedule\.meeting\.request|schedule\.mtgreq/.test(value)) return "REQUEST";
    if (/schedule\.meeting\.canceled|schedule\.mtgcncl/.test(value)) return "CANCEL";
    if (/schedule\.meeting\.resp|schedule\.mtgresp/.test(value)) return "REPLY";
    // Ein blosser Kalendereintrag (weitergeleitet, exportiert): behandelt wie
    // eine Einladung — er beschreibt denselben Termin.
    if (/^ipm\.appointment/.test(value)) return "REQUEST";
    return null;
};

const addressOf = (bag: PropertyBag): string | null => {
    const candidates = [
        text(bag, keyOfTag(TAG.SMTP_ADDRESS)),
        text(bag, keyOfTag(TAG.EMAIL_ADDRESS)),
    ];
    // PR_EMAIL_ADDRESS ist bei Exchange-Empfängern ein X.500-Pfad, keine
    // Mailadresse — nur eine Adresse mit «@» zählt.
    return candidates.find((value) => value && value.includes("@"))?.toLowerCase() || null;
};

/**
 * DER SCHLÜSSEL. Outlook nimmt als iCalendar-UID die hexadezimale
 * `GlobalObjectId` (Grossbuchstaben). Bei einem einzelnen Vorkommen aus einer
 * Serie stehen in den Bytes 16–19 Jahr/Monat/Tag des Vorkommens; die
 * `CleanGlobalObjectId` hat dort Nullen und ist der Schlüssel der Serie.
 *
 * FREMDE UIDs WERDEN EINGEPACKT ([MS-OXOCAL] 2.2.1.27.3): kommt der Termin
 * ursprünglich aus einer .ics mit eigener UID — etwa unserem
 * `offitec-…@offitec.eu` —, baut Outlook daraus eine GlobalObjectId mit dem
 * Marker `vCal-Uid` gefolgt von der Originalzeichenkette. Die Original-UID
 * ist dann der Schlüssel, nicht der Hexblock: nur so erkennt der Import
 * unsere eigene Einladung wieder, wenn sie als winmail.dat zurückkommt
 * (genau der Fall im Postfach: die Absage zu «Montagetermin PR-2026-10003»).
 */
// «vCal-Uid» + 0x01 0x00 0x00 0x00, dann die Originalzeichenkette, nullterminiert.
const VCAL_UID_MARKER = Buffer.concat([Buffer.from("vCal-Uid", "latin1"), Buffer.from([1, 0, 0, 0])]);

const unwrapGlobalObjectId = (id: Buffer): string => {
    const marker = id.indexOf(VCAL_UID_MARKER);
    if (marker >= 0) {
        const tail = id.subarray(marker + VCAL_UID_MARKER.length);
        const end = tail.indexOf(0);
        const original = tail.subarray(0, end >= 0 ? end : tail.length).toString("latin1").trim();
        if (original) return original;
    }
    return id.toString("hex").toUpperCase();
};

const uidOf = (props: PropertyBag): { uid: string; recurrenceId: string | null } | null => {
    const raw = bytes(props, keyOfLid(PSETID.MEETING, LID.GLOBAL_OBJECT_ID));
    const clean = bytes(props, keyOfLid(PSETID.MEETING, LID.CLEAN_GLOBAL_OBJECT_ID));
    const base = clean || raw;
    if (!base) return null;
    let recurrenceId: string | null = null;
    if (raw && raw.length >= 20) {
        const year = raw.readUInt16BE(16);
        const month = raw[18]!;
        const day = raw[19]!;
        if (year && month && day) {
            recurrenceId = `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
        }
    }
    return { uid: unwrapGlobalObjectId(base), recurrenceId };
};

/** Beitrittslink: Teams legt ihn als benannte Zeichenkette ab. */
const onlineUrlOf = (props: PropertyBag): string | null => {
    for (const property of props.values()) {
        if (!/skypeteamsmeetingurl|onlinemeetingexternallink|onlinemeetingconflink/.test(property.key)) continue;
        const value = property.values[0];
        if (typeof value === "string" && /^https:\/\//i.test(value.trim())) return value.trim().slice(0, 512);
    }
    return null;
};

/**
 * Den Termin aus den MAPI-Eigenschaften bauen. Anfang und Ende kommen in
 * dieser Reihenfolge: `AppointmentStartWhole/EndWhole` (UTC, das Verlässliche)
 * → `CommonStart/End` → `PR_START_DATE/END_DATE` → die TNEF-Datumsstruktur
 * (Ortszeit ohne Zone — der letzte Ausweg).
 */
const eventFromMessage = (message: TnefMessage): ParsedCalendarEvent | null => {
    const props = message.props;
    const messageClass = text(props, keyOfTag(TAG.MESSAGE_CLASS)) || message.messageClass;
    const method = methodOfClass(messageClass);
    if (!method) return null;
    const key = uidOf(props);
    if (!key) return null;

    const start = date(props, keyOfLid(PSETID.APPOINTMENT, LID.START_WHOLE))
        || date(props, keyOfLid(PSETID.COMMON, LID.COMMON_START))
        || date(props, keyOfTag(TAG.START_DATE))
        || message.dateStart;
    const end = date(props, keyOfLid(PSETID.APPOINTMENT, LID.END_WHOLE))
        || date(props, keyOfLid(PSETID.COMMON, LID.COMMON_END))
        || date(props, keyOfTag(TAG.END_DATE))
        || message.dateEnd;
    if (!start) return null;

    const organizerEmail = [
        text(props, keyOfTag(TAG.SENT_REPRESENTING_SMTP)),
        text(props, keyOfTag(TAG.SENDER_SMTP)),
        text(props, keyOfTag(TAG.SENT_REPRESENTING_EMAIL)),
        text(props, keyOfTag(TAG.SENDER_EMAIL)),
    ].find((value) => value && value.includes("@"))?.toLowerCase() || null;
    const organizerName = text(props, keyOfTag(TAG.SENT_REPRESENTING_NAME)) || text(props, keyOfTag(TAG.SENDER_NAME));

    const attendees = message.recipients
        .filter((bag) => (number(bag, keyOfTag(TAG.RECIPIENT_TYPE)) ?? 1) !== 3)
        .map((bag) => ({ email: addressOf(bag) || "", name: text(bag, keyOfTag(TAG.DISPLAY_NAME)), partstat: null }))
        .filter((attendee) => attendee.email);

    const recurring = flag(props, keyOfLid(PSETID.APPOINTMENT, LID.RECURRING))
        || flag(props, keyOfLid(PSETID.MEETING, LID.IS_RECURRING));

    return {
        method,
        uid: key.uid,
        sequence: number(props, keyOfLid(PSETID.APPOINTMENT, LID.APPOINTMENT_SEQUENCE)) ?? 0,
        start,
        end: end || new Date(start.getTime() + 60 * 60_000),
        summary: text(props, keyOfTag(TAG.SUBJECT)) || message.subject,
        description: text(props, keyOfTag(TAG.BODY)) || message.body,
        location: text(props, keyOfLid(PSETID.APPOINTMENT, LID.LOCATION)),
        organizer: organizerEmail ? { email: organizerEmail, name: organizerName } : null,
        attendees,
        cancelled: method === "CANCEL",
        // Ein aufgelöstes Vorkommen hat sein eigenes Datum und ist kein Serienkopf.
        recurring: recurring && !key.recurrenceId,
        onlineUrl: onlineUrlOf(props),
        recurrenceId: key.recurrenceId,
    };
};

const looksLikeCalendarAttachment = (attachment: TnefAttachment): boolean =>
    /\.ics$/i.test(String(attachment.filename || "")) || /text\/calendar/i.test(String(attachment.mimeType || ""));

/**
 * ALLE Termine aus einem winmail.dat. Zuerst die angehängten .ics-Dateien (sie
 * sind die vollständigere Fassung), dann — wenn keine da war — die Nachricht
 * selbst, sofern sie eine Einladung ist. Kein TNEF, keine Einladung, nichts
 * Lesbares: leere Liste, kein Fehler.
 */
export const calendarEventsFromTnef = (buffer: Buffer): ParsedCalendarEvent[] => {
    const message = parseTnef(buffer);
    if (!message) return [];
    const fromAttachments = message.attachments
        .filter((attachment) => attachment.data && looksLikeCalendarAttachment(attachment))
        .flatMap((attachment) => parseCalendarObjects(attachment.data!.toString("utf8")));
    if (fromAttachments.length) return fromAttachments;
    const own = eventFromMessage(message);
    return own ? [own] : [];
};
