import { nanoid } from "nanoid";
import prisma from "../database/prisma.client";
import {
    cleanDescription,
    cleanLocation,
    onlineMeetingOrigin,
    parseCalendarObject,
    type ParsedCalendarEvent,
} from "./calendarInvite";
import { normalizeAddress } from "./outlook/mailCustomerMatcher";
import { calendarEventsFromTnef } from "./tnef";
import { getCompanyTreeTenantIds } from "../../presentation/controllers/serviceTenantScope";

/**
 * OUTLOOK/TEAMS → ERP-KALENDER (18.08.2026, erweitert 21.08. und 31.08.2026).
 *
 * Die Gegenrichtung zu `calendarMailService`. ZWEI WEGE führen hier herein:
 *
 *   MAIL    Eine Einladung liegt als `text/calendar; method=REQUEST` im
 *           Postfach — jemand hat das Firmenpostfach eingeladen. Gelesen werden
 *           beide Ordner: Posteingang (wir wurden eingeladen) und Gesendet (aus
 *           dem Postfach ist eine Einladung RAUSGEGANGEN, etwa ein in Outlook
 *           angesetztes Teams-Meeting).
 *   CALDAV  Der Kalender des Kontos selbst (`caldavCalendarService`). Damit
 *           kommt auch an, was sich jemand nur SELBST einträgt — dafür gibt es
 *           keine Mail, und bis zum 31.08.2026 war das schlicht unerreichbar.
 *
 * VIER REGELN, DIE DEN KALENDER SAUBER HALTEN:
 *
 *  1. AKTUALISIEREN — der Schlüssel ist die UID. Dieselbe Einladung ein
 *     zweites Mal (weil der Termin in Outlook verschoben wurde) ändert den
 *     vorhandenen Eintrag, statt einen zweiten anzulegen. `METHOD:CANCEL`
 *     entfernt ihn wieder.
 *  2. NUR, WAS VON AUSSEN KAM — ein Eintrag, den jemand IM SYSTEM angelegt
 *     hat, wird von hier NIE angefasst. Nur Zeilen mit `externalOrigin`
 *     gehören dem Organisator draussen; alles andere gehört uns.
 *  3. NUR EINMAL — was wir selbst verschickt haben, kommt über den
 *     Gesendet-Ordner (und als Kopie im Posteingang, und im eigenen Kalender)
 *     wieder herein. Solche Termine werden an der UID erkannt und
 *     übersprungen, sonst stünde derselbe Termin zweimal im Kalender: einmal
 *     als eigener Eintrag, einmal als Import. Zusätzlich verhindert ein
 *     eindeutiger Schlüssel auf (tenantId, icalUid) das Doppel auch bei zwei
 *     gleichzeitigen Abrufen.
 *  4. DER TERMIN GEHÖRT DER EMPFÄNGER-PERSON, NICHT DER FIRMA. CYON liefert
 *     kein Graph-Profil; darum wird die Person aus To/CC und ATTENDEE ermittelt
 *     und als interner Teilnehmer verknüpft. Die stabile Employee-ID bleibt
 *     beim Mandantenwechsel gleich. `externalMailbox` bleibt zusätzlich als
 *     Herkunftsnachweis erhalten, entscheidet aber nicht mehr, wer den
 *     persönlichen Termin sehen darf.
 *  5. UND KEINER GEHT VERLOREN (14.09.2026). Steht in der Einladung NIEMAND aus
 *     dem ERP — sie ging nur an die Firmenadresse —, wurde sie bis hierher
 *     verworfen («kein Benutzer für die Zuordnung»). Das war der häufigste
 *     Fall überhaupt und der Grund, warum Termine im Postfach lagen und nie im
 *     Kalender ankamen. Jetzt kommt auch sie herein, nur ohne persönliche
 *     Teilnehmende: KEIN interner Teilnehmer heisst «Termin des Postfachs» und
 *     wird allen im Firmenbaum gezeigt. Die Unterscheidung braucht keine
 *     eigene Spalte — sie steht in der Teilnehmerliste.
 *
 * Abgelegt wird als `MeetingActivity` (Besprechung) und nicht als
 * `Appointment`: ein Projekttermin verlangt ein Projekt, das ein Termin von
 * aussen nicht kennt. Besprechungen erscheinen im selben Kalender.
 */

export interface CalendarImportResult {
    action: "created" | "updated" | "cancelled" | "ignored";
    meetingId?: string;
    /** Der Schlüssel, unter dem der Termin abgelegt ist — auch wenn er
        übersprungen wurde. Der CalDAV-Abgleich sammelt ihn, um danach die im
        Kalender GELÖSCHTEN Termine erkennen zu können. */
    icalUid?: string;
    reason?: string;
}

export interface CalendarImportContext {
    senderEmail?: string | null;
    customerId?: string | null;
    employeeId?: string | null;
    /** Mail envelope recipients. For CYON/IMAP this is the authoritative link
        between a received invitation and the ERP users it belongs to. */
    recipientEmails?: string[];
    /** IN = Posteingang (wir wurden eingeladen), OUT = Gesendet (wir haben eingeladen). */
    direction?: "IN" | "OUT";
    /** Kennung des Postfachs (`mailboxIdentity`), dem dieser Termin gehört. */
    mailbox: string;
    /**
     * Betreff der MAIL, die den Termin trug. Eine winmail.dat führt den Betreff
     * nicht immer in ihren MAPI-Eigenschaften — dann hiesse der Termin «Termin
     * aus Outlook», obwohl die Nachricht darüber «feegege» heisst. Der Betreff
     * der Einladung geht vor; dieser hier ist der Ersatz.
     */
    subject?: string | null;
    /** MAIL = aus einer Einladung, CALDAV = direkt aus dem Kalender des Kontos. */
    source: "MAIL" | "CALDAV";
}

/** Eigene Einladungen kommen als Kopie zurück — die gehören nicht importiert. */
const isOwnUid = (uid: string) => uid.startsWith("offitec-");

/**
 * DER SCHLÜSSEL EINES ÜBERNOMMENEN TERMINS.
 *
 * Für einen gewöhnlichen Termin ist es die UID. Ein aus einer Serie
 * AUFGELÖSTES Vorkommen (CalDAV liefert sie so) teilt die UID mit allen
 * anderen Vorkommen — erst die RECURRENCE-ID macht es eindeutig. Ohne den
 * Zusatz behielte eine wöchentliche Besprechung genau einen Eintrag, der bei
 * jedem Abruf auf ein anderes Datum spränge.
 */
const storageUid = (event: ParsedCalendarEvent): string =>
    (event.recurrenceId ? `${event.uid}#${event.recurrenceId}` : event.uid).slice(0, 191);

/**
 * WEM GEHÖRT DER TERMIN? Bei CYON gibt es kein Graph-Profil, deshalb wird die
 * Person allein aus den Mail-/ICS-Adressen bestimmt — aus ALLEN, die in der
 * Einladung stehen (Organisator, Absender, To/CC, ATTENDEE). Die Richtung
 * bestimmt nur die Reihenfolge:
 *
 *   IN  = zuerst die Eingeladenen (To/CC, ATTENDEE), dann der Organisator
 *   OUT = zuerst die absendende Person, dann die Eingeladenen
 *
 * Gesucht wird im ganzen Firmenbaum. Die Reihenfolge der Adressen bleibt
 * erhalten; die erste gefundene Person wird Pflicht-Urheber, alle gefundenen
 * Personen werden Teilnehmer. So ist dieselbe Einladung für jeden ihrer
 * internen Empfänger sichtbar, unabhängig vom ausgewählten Mandanten.
 *
 * ZWEI ANTWORTEN, NICHT EINE (14.09.2026). Vorher gab es nur die Liste der
 * Personen — und war sie leer, wurde der Termin WEGGEWORFEN. Das traf genau
 * den häufigsten Fall: eine Einladung geht an die Firmenadresse
 * (`sck@offitec.eu`), und die ist kein Mitarbeitendenkonto. Der Termin lag im
 * Postfach und kam nie im Kalender an, mit einer Zeile im Protokoll als
 * einziger Spur.
 *
 *   `owners`  = die Personen, an die die Einladung ADRESSIERT war. Nur sie
 *               machen den Termin persönlich; nur sie sehen ihn dann.
 *   `anchor`  = irgendeine gültige Person für die PFLICHTSPALTE
 *               `createdByEmployeeId`. Sie sagt nichts über die Sichtbarkeit —
 *               ist `owners` leer, gehört der Termin dem POSTFACH und wird
 *               allen im Firmenbaum gezeigt (siehe meeting.routes.ts).
 */
interface CalendarAssignment {
    owners: string[];
    anchor: string | null;
}

/** Aus `host|adresse` die Postfachadresse — der Rückweg zu `mailboxIdentity`. */
const mailboxAddressOf = (mailbox: string | null | undefined): string =>
    normalizeAddress(String(mailbox || "").split("|").pop() || "");

const resolveAssignment = async (
    tenantId: string,
    event: ParsedCalendarEvent,
    context: CalendarImportContext,
): Promise<CalendarAssignment> => {
    /* BEIDE RICHTUNGEN, DIESELBE FRAGE (14.09.2026, Vorgabe Samet: «es wird
       eingehende und ausgehende geben»). Vorher sah der Gesendet-Ordner NUR
       den Organisator an und der Posteingang NUR die Empfänger. Beides war zu
       eng: eine aus Outlook verschickte Besprechung gehört ebenso den intern
       Eingeladenen, und eine hereinkommende Einladung gehört auch dem
       Organisator, wenn er bei uns angestellt ist.

       Gesammelt wird darum ALLES, was an Adressen in der Einladung steht — die
       RICHTUNG bestimmt nur noch die Reihenfolge, und die entscheidet, wer
       Pflicht-Urheber wird: im Gesendet-Ordner die absendende Person, im
       Posteingang die eingeladene. */
    const organizerSide = [event.organizer?.email, context.senderEmail];
    const recipientSide = [...(context.recipientEmails || []), ...event.attendees.map((attendee) => attendee.email)];
    const candidateAddresses = (context.direction === "OUT"
        ? [...organizerSide, ...recipientSide]
        : [...recipientSide, ...organizerSide]
    ).map(normalizeAddress).filter(Boolean);

    /* DAS POSTFACH SELBST IST KEINE EMPFÄNGERIN. Seine Adresse steht in jeder
       Einladung; wäre sie zugleich ein Mitarbeitendenkonto, gehörte dieser
       Person schlagartig jeder Termin des Hauses. Für den `anchor` wird sie
       unten trotzdem nachgeschlagen.

       Beim KALENDER (CalDAV) sind es MEHRERE Adressen: der Weg bekommt keine
       Mail-Umschläge, sondern die eigenen Adressen des Kontos (IMAP-Benutzer,
       SMTP-Benutzer, Absenderadresse) als `recipientEmails`. Keine davon ist
       eine eingeladene Person — sie alle bezeichnen dasselbe Konto. */
    const mailboxAddresses = new Set([
        mailboxAddressOf(context.mailbox),
        ...(context.source === "CALDAV" ? (context.recipientEmails || []).map(normalizeAddress) : []),
    ].filter(Boolean));
    const personalAddresses = candidateAddresses.filter((address) => !mailboxAddresses.has(address));

    /* Employee.email is globally unique. Matching by the exact mail address is
       therefore both tenant-independent and safe: selecting another company
       never changes the identity behind the address. */
    const lookup = [...new Set([...personalAddresses, ...mailboxAddresses])];
    const employees = lookup.length ? await prisma.employee.findMany({
        where: {
            email: { in: lookup },
            isActive: true,
            deletedAt: null,
        },
        select: { id: true, email: true, createdAt: true },
        orderBy: { createdAt: "asc" },
    }) : [];
    const byAddress = new Map(
        employees
            .map((employee) => [normalizeAddress(employee.email), employee.id] as const)
            .filter(([address]) => Boolean(address)),
    );
    const owners = [...new Set(personalAddresses.map((address) => byAddress.get(address)).filter(Boolean) as string[])];
    if (owners.length) return { owners, anchor: owners[0]! };

    /* NIEMAND AUS DEM ERP STAND IN DER EINLADUNG — der Termin gehört dem
       Postfach. Für die Pflichtspalte reicht die Person hinter der
       Postfachadresse; gibt es sie nicht, die dienstälteste aktive Person des
       Firmenbaums. Beide werden NICHT als Teilnehmende eingetragen: sonst sähe
       es wie ihr persönlicher Termin aus, und alle anderen sähen ihn nicht. */
    const mailboxOwner = [...mailboxAddresses].map((address) => byAddress.get(address)).find(Boolean);
    if (mailboxOwner) return { owners: [], anchor: mailboxOwner };

    const treeTenantIds = await getCompanyTreeTenantIds(tenantId).catch(() => [tenantId]);
    const fallback = await prisma.employee.findFirst({
        where: {
            tenantId: { in: treeTenantIds.length ? treeTenantIds : [tenantId] },
            isActive: true,
            deletedAt: null,
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
    });
    return { owners: [], anchor: fallback?.id ?? null };
};

const employeeParticipants = (employeeIds: string[]) => ({
    deleteMany: { participantType: "EMPLOYEE" },
    create: employeeIds.map((employeeId) => ({
        id: nanoid(12),
        participantType: "EMPLOYEE",
        employeeId,
    })),
});

/**
 * Trägt ein bereits zerlegtes Kalenderobjekt in den ERP-Kalender ein.
 * `tenantId` ist der MAIL-Mandant (der Stamm des Firmenbaums).
 */
export const importCalendarEvent = async (
    tenantId: string,
    event: ParsedCalendarEvent,
    context: CalendarImportContext,
): Promise<CalendarImportResult> => {
    // Antworten (Zusage/Absage) ändern den Termin nicht — sie stehen als Mail
    // in der Kommunikation, das genügt.
    if (event.method === "REPLY") return { action: "ignored", reason: "Antwort auf eine Einladung" };
    // REGEL 3, erster Riegel: unser eigener Termin, an der UID erkannt.
    if (isOwnUid(event.uid)) return { action: "ignored", reason: "eigener Termin" };

    const uid = storageUid(event);
    const existing = await prisma.meetingActivity.findFirst({
        where: { tenantId, icalUid: uid },
        select: { id: true, icalSequence: true, externalOrigin: true, externalMailbox: true },
    });

    // REGEL 2/3, zweiter Riegel: Der Eintrag existiert, gehört aber UNS — im
    // System angelegt und von dort aus verschickt. Eine hereinkommende Fassung
    // desselben Termins (Kopie, Weiterleitung, Zusage mit Anhang, der eigene
    // Kalender) darf ihn weder überschreiben noch neben sich ein Doppel stellen.
    if (existing && !existing.externalOrigin) {
        return { action: "ignored", icalUid: uid, reason: "im System angelegter Termin" };
    }
    if (!existing) {
        // Dieselbe Frage für Projekttermine: die tragen ihre UID ebenfalls, und
        // ein Import daneben wäre genau das Doppel, das nicht sein soll. Gesucht
        // wird im ganzen Baum — der Termin steht in der Firma seines Projekts,
        // das Postfach am Stamm.
        const treeTenantIds = await getCompanyTreeTenantIds(tenantId).catch(() => [tenantId]);
        const ownAppointment = await prisma.appointment.findFirst({
            where: { tenantId: { in: treeTenantIds.length ? treeTenantIds : [tenantId] }, icalUid: uid },
            select: { id: true },
        });
        if (ownAppointment) return { action: "ignored", icalUid: uid, reason: "eigener Projekttermin" };
    }

    if (event.method === "CANCEL" || event.cancelled) {
        if (!existing) return { action: "ignored", icalUid: uid, reason: "Absage zu unbekanntem Termin" };
        await prisma.meetingActivity.delete({ where: { id: existing.id } });
        return { action: "cancelled", icalUid: uid, meetingId: existing.id };
    }

    // SerienKÖPFE bleiben aussen vor (Vorgabe 21.08.2026 bestätigt): ein
    // einzelner Eintrag an ihrer Stelle wäre falsch. Ein aus der Serie
    // AUFGELÖSTES Vorkommen ist etwas anderes und kommt durch — es hat sein
    // eigenes Datum und seinen eigenen Schlüssel.
    if (event.recurring) return { action: "ignored", icalUid: uid, reason: "Serientermin" };
    if (!event.start || !event.end) return { action: "ignored", icalUid: uid, reason: "ohne Zeitangabe" };

    const organizer = normalizeAddress(event.organizer?.email || context.senderEmail || "");
    const title = event.summary
        || String(context.subject || "").trim().slice(0, 255)
        || (context.source === "CALDAV" ? "Termin aus dem Kalender" : "Termin aus Outlook");
    const location = cleanLocation(event.location);
    const notes = [
        cleanDescription(event.description),
        location ? `Ort: ${location}` : "",
        event.attendees.length
            ? `Teilnehmende: ${event.attendees.map((a) => a.name || a.email).filter(Boolean).join(", ")}`
            : "",
    ].filter(Boolean).join("\n").slice(0, 4000) || null;

    const shared = {
        title,
        notes,
        startTime: event.start,
        endTime: event.end,
        icalSequence: event.sequence,
        externalOrigin: onlineMeetingOrigin(event.onlineUrl),
        externalOrganizer: organizer || null,
        externalMailbox: context.mailbox || null,
        externalSource: context.source,
        meetingUrl: event.onlineUrl,
    };

    const { owners: ownerIds, anchor } = await resolveAssignment(tenantId, event, context);

    if (existing) {
        /* Eine ältere Fassung überschreibt nichts: Outlook schickt Einladungen
           mehrfach, und die letzte gültige gewinnt.

           Der KALENDER ist davon ausgenommen. Er ist keine Nachricht, sondern
           der Stand des Kontos: was dort steht, gilt — auch wenn die SEQUENCE
           nicht mitgewachsen ist (Outlook zählt sie bei einer Änderung am
           eigenen Eintrag nicht immer hoch). Ohne diese Ausnahme bliebe ein per
           Mail hereingekommener Termin für immer auf seiner alten Zeit stehen,
           obwohl er im Kalender längst verschoben ist. */
        if (context.source === "MAIL" && (existing.icalSequence ?? 0) > event.sequence) {
            return { action: "ignored", icalUid: uid, reason: "ältere Fassung" };
        }
        await prisma.meetingActivity.update({
            where: { id: existing.id },
            data: {
                ...shared,
                ...(context.customerId ? { customerId: context.customerId } : {}),
                ...(ownerIds.length ? {
                    createdByEmployeeId: ownerIds[0],
                    participants: employeeParticipants(ownerIds),
                } : {}),
            },
        });
        return { action: "updated", icalUid: uid, meetingId: existing.id };
    }

    /* Ohne EINE einzige aktive Person im ganzen Firmenbaum lässt sich die
       Pflichtspalte nicht füllen — dann gibt es aber auch niemanden, dem der
       Termin gehören könnte. Jeder andere Fall kommt jetzt durch: entweder
       persönlich (`ownerIds`) oder als Termin des Postfachs. */
    if (!anchor) return { action: "ignored", icalUid: uid, reason: "keine aktive Person im Firmenbaum" };

    try {
        const created = await prisma.meetingActivity.create({
            data: {
                id: nanoid(12),
                tenantId,
                kind: "MEETING",
                ...shared,
                customerId: context.customerId || null,
                createdByEmployeeId: anchor,
                icalUid: uid,
                ccEmails: event.attendees.map((attendee) => attendee.email).filter(Boolean).slice(0, 20),
                participants: {
                    create: ownerIds.map((employeeId) => ({
                        id: nanoid(12),
                        participantType: "EMPLOYEE",
                        employeeId,
                    })),
                },
            },
            select: { id: true },
        });
        return { action: "created", icalUid: uid, meetingId: created.id };
    } catch (error: any) {
        /* REGEL 3, dritter Riegel: zwei Abrufe gleichzeitig (Zeitplan und
           «Jetzt abrufen», Postfach und Kalender) können denselben Termin im
           selben Moment anlegen wollen. Der eindeutige Schlüssel auf
           (tenantId, icalUid) lässt nur einen durch — der zweite aktualisiert
           stattdessen. */
        if (error?.code !== "P2002") throw error;
        const duplicate = await prisma.meetingActivity.findFirst({
            where: { tenantId, icalUid: uid },
            select: { id: true, externalOrigin: true },
        });
        if (!duplicate) throw error;
        if (!duplicate.externalOrigin) return { action: "ignored", icalUid: uid, reason: "im System angelegter Termin" };
        await prisma.meetingActivity.update({
            where: { id: duplicate.id },
            data: {
                ...shared,
                ...(ownerIds.length ? {
                    createdByEmployeeId: ownerIds[0],
                    participants: employeeParticipants(ownerIds),
                } : {}),
            },
        });
        return { action: "updated", icalUid: uid, meetingId: duplicate.id };
    }
};

/**
 * Der Mailweg: ein `text/calendar`-Teil aus dem Postfach. `senderEmail` ist der
 * Absender der Mail (für den Organisator-Vermerk), `customerId` die bereits
 * ermittelte Kundenzuordnung der Nachricht.
 */
export const importCalendarObject = async (
    tenantId: string,
    icsText: string,
    context: CalendarImportContext,
): Promise<CalendarImportResult> => {
    const event = parseCalendarObject(icsText);
    if (!event) return { action: "ignored", reason: "kein einzelner Termin" };
    return importCalendarEvent(tenantId, event, context);
};

/**
 * Der Mailweg für WINMAIL.DAT (14.09.2026): der TNEF-Anhang wird zerlegt
 * (`tnef.ts`), und was darin an Terminen steckt, geht denselben Weg wie eine
 * .ics. Meist ist es genau einer — die Nachricht selbst ist die Einladung.
 * Steckt eine .ics als Anhang darin, können es mehrere sein; gemeldet wird
 * das Ergebnis des ersten, damit der Aufrufer wie gewohnt EINE Antwort hat.
 */
export const importTnefObject = async (
    tenantId: string,
    payload: Buffer,
    context: CalendarImportContext,
): Promise<CalendarImportResult> => {
    const events = calendarEventsFromTnef(payload);
    if (!events.length) return { action: "ignored", reason: "winmail.dat ohne Termin" };
    let first: CalendarImportResult | null = null;
    for (const event of events) {
        const result = await importCalendarEvent(tenantId, event, context);
        first = first ?? result;
    }
    return first!;
};

/** Ein Kalenderteil aus dem Postfach, je nach Art als Text oder als TNEF gelesen. */
export const importCalendarPayload = (
    tenantId: string,
    payload: Buffer,
    kind: "ICS" | "TNEF",
    context: CalendarImportContext,
): Promise<CalendarImportResult> =>
    kind === "TNEF"
        ? importTnefObject(tenantId, payload, context)
        : importCalendarObject(tenantId, payload.toString("utf8"), context);

/**
 * DIE ALTEN ÜBERNOMMENEN TERMINE NACHTRAGEN (14.09.2026).
 *
 * Übernommene Termine ohne internen Teilnehmer sind Termine des POSTFACHS —
 * so ist die Regel gemeint. Ein Teil des Bestands ist es aber nur deshalb,
 * weil es die Regel damals noch nicht gab: die Zeilen entstanden, als der
 * Import allein `createdByEmployeeId` setzte und niemanden verknüpfte.
 *
 * Das Nachholen aus dem Postfach (`calendarOnly`) repariert sie nur, solange
 * die Einladung noch auf dem Server liegt — nach zwei Monaten, einem
 * Aufräumen in Outlook oder einem Ordnerwechsel ist sie weg, die ERP-Zeile
 * bleibt. Ihre Adressen stehen aber weiterhin IN DER ZEILE: `ccEmails` sind
 * die ATTENDEE der Einladung, `externalOrganizer` ist ihr Organisator.
 *
 * Daraus lässt sich dieselbe Zuordnung noch einmal rechnen — ohne Mailserver,
 * ohne Netz. Angefasst werden NUR Zeilen ohne internen Teilnehmer: eine
 * bereits zugeordnete Einladung bleibt, wie sie ist.
 */
export const repairImportedMeetingOwners = async (tenantId: string): Promise<number> => {
    const orphans = await prisma.meetingActivity.findMany({
        where: {
            tenantId,
            NOT: { externalOrigin: null },
            participants: { none: { participantType: "EMPLOYEE" } },
        },
        select: { id: true, ccEmails: true, externalOrganizer: true, externalMailbox: true },
        take: 500,
    });
    if (!orphans.length) return 0;

    /* EIN Nachschlagen für alle: die Adressen aller Zeilen zusammen, dann die
       Personen dazu. Je Termin einzeln zu fragen wäre bei 500 Zeilen 500 mal
       dieselbe Tabelle. */
    const addressesOf = (row: (typeof orphans)[number]): string[] => {
        const attendees = Array.isArray(row.ccEmails) ? row.ccEmails : [];
        const mailbox = mailboxAddressOf(row.externalMailbox);
        return [...attendees.map((value) => normalizeAddress(String(value ?? ""))), normalizeAddress(row.externalOrganizer || "")]
            .filter((address) => Boolean(address) && address !== mailbox);
    };
    const lookup = [...new Set(orphans.flatMap(addressesOf))];
    if (!lookup.length) return 0;

    const employees = await prisma.employee.findMany({
        where: { email: { in: lookup }, isActive: true, deletedAt: null },
        select: { id: true, email: true },
        orderBy: { createdAt: "asc" },
    });
    const byAddress = new Map(
        employees
            .map((employee) => [normalizeAddress(employee.email), employee.id] as const)
            .filter(([address]) => Boolean(address)),
    );
    if (!byAddress.size) return 0;

    let repaired = 0;
    for (const row of orphans) {
        const owners = [...new Set(addressesOf(row).map((address) => byAddress.get(address)).filter(Boolean) as string[])];
        if (!owners.length) continue;
        await prisma.meetingActivity.update({
            where: { id: row.id },
            data: {
                createdByEmployeeId: owners[0]!,
                participants: employeeParticipants(owners),
            },
        });
        repaired += 1;
    }
    if (repaired) console.log(`[KALENDER] ${repaired} übernommene Termine nachträglich einer Person zugeordnet.`);
    return repaired;
};
