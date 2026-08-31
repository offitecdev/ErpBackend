"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.repairImportedMeetingOwners = exports.importCalendarPayload = exports.importTnefObject = exports.importCalendarObject = exports.importCalendarEvent = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const calendarInvite_1 = require("./calendarInvite");
const mailCustomerMatcher_1 = require("./outlook/mailCustomerMatcher");
const tnef_1 = require("./tnef");
const serviceTenantScope_1 = require("../../presentation/controllers/serviceTenantScope");
/** Eigene Einladungen kommen als Kopie zurück — die gehören nicht importiert. */
const isOwnUid = (uid) => uid.startsWith("offitec-");
/**
 * DER SCHLÜSSEL EINES ÜBERNOMMENEN TERMINS.
 *
 * Für einen gewöhnlichen Termin ist es die UID. Ein aus einer Serie
 * AUFGELÖSTES Vorkommen (CalDAV liefert sie so) teilt die UID mit allen
 * anderen Vorkommen — erst die RECURRENCE-ID macht es eindeutig. Ohne den
 * Zusatz behielte eine wöchentliche Besprechung genau einen Eintrag, der bei
 * jedem Abruf auf ein anderes Datum spränge.
 */
const storageUid = (event) => (event.recurrenceId ? `${event.uid}#${event.recurrenceId}` : event.uid).slice(0, 191);
/** Aus `host|adresse` die Postfachadresse — der Rückweg zu `mailboxIdentity`. */
const mailboxAddressOf = (mailbox) => (0, mailCustomerMatcher_1.normalizeAddress)(String(mailbox || "").split("|").pop() || "");
const resolveAssignment = async (tenantId, event, context) => {
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
        : [...recipientSide, ...organizerSide]).map(mailCustomerMatcher_1.normalizeAddress).filter(Boolean);
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
        ...(context.source === "CALDAV" ? (context.recipientEmails || []).map(mailCustomerMatcher_1.normalizeAddress) : []),
    ].filter(Boolean));
    const personalAddresses = candidateAddresses.filter((address) => !mailboxAddresses.has(address));
    /* Employee.email is globally unique. Matching by the exact mail address is
       therefore both tenant-independent and safe: selecting another company
       never changes the identity behind the address. */
    const lookup = [...new Set([...personalAddresses, ...mailboxAddresses])];
    const employees = lookup.length ? await prisma_client_1.default.employee.findMany({
        where: {
            email: { in: lookup },
            isActive: true,
            deletedAt: null,
        },
        select: { id: true, email: true, createdAt: true },
        orderBy: { createdAt: "asc" },
    }) : [];
    const byAddress = new Map(employees
        .map((employee) => [(0, mailCustomerMatcher_1.normalizeAddress)(employee.email), employee.id])
        .filter(([address]) => Boolean(address)));
    const owners = [...new Set(personalAddresses.map((address) => byAddress.get(address)).filter(Boolean))];
    if (owners.length)
        return { owners, anchor: owners[0] };
    /* NIEMAND AUS DEM ERP STAND IN DER EINLADUNG — der Termin gehört dem
       Postfach. Für die Pflichtspalte reicht die Person hinter der
       Postfachadresse; gibt es sie nicht, die dienstälteste aktive Person des
       Firmenbaums. Beide werden NICHT als Teilnehmende eingetragen: sonst sähe
       es wie ihr persönlicher Termin aus, und alle anderen sähen ihn nicht. */
    const mailboxOwner = [...mailboxAddresses].map((address) => byAddress.get(address)).find(Boolean);
    if (mailboxOwner)
        return { owners: [], anchor: mailboxOwner };
    const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(tenantId).catch(() => [tenantId]);
    const fallback = await prisma_client_1.default.employee.findFirst({
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
const employeeParticipants = (employeeIds) => ({
    deleteMany: { participantType: "EMPLOYEE" },
    create: employeeIds.map((employeeId) => ({
        id: (0, nanoid_1.nanoid)(12),
        participantType: "EMPLOYEE",
        employeeId,
    })),
});
/**
 * Trägt ein bereits zerlegtes Kalenderobjekt in den ERP-Kalender ein.
 * `tenantId` ist der MAIL-Mandant (der Stamm des Firmenbaums).
 */
const importCalendarEvent = async (tenantId, event, context) => {
    // Antworten (Zusage/Absage) ändern den Termin nicht — sie stehen als Mail
    // in der Kommunikation, das genügt.
    if (event.method === "REPLY")
        return { action: "ignored", reason: "Antwort auf eine Einladung" };
    // REGEL 3, erster Riegel: unser eigener Termin, an der UID erkannt.
    if (isOwnUid(event.uid))
        return { action: "ignored", reason: "eigener Termin" };
    const uid = storageUid(event);
    const existing = await prisma_client_1.default.meetingActivity.findFirst({
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
        const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(tenantId).catch(() => [tenantId]);
        const ownAppointment = await prisma_client_1.default.appointment.findFirst({
            where: { tenantId: { in: treeTenantIds.length ? treeTenantIds : [tenantId] }, icalUid: uid },
            select: { id: true },
        });
        if (ownAppointment)
            return { action: "ignored", icalUid: uid, reason: "eigener Projekttermin" };
    }
    if (event.method === "CANCEL" || event.cancelled) {
        if (!existing)
            return { action: "ignored", icalUid: uid, reason: "Absage zu unbekanntem Termin" };
        await prisma_client_1.default.meetingActivity.delete({ where: { id: existing.id } });
        return { action: "cancelled", icalUid: uid, meetingId: existing.id };
    }
    // SerienKÖPFE bleiben aussen vor (Vorgabe 21.08.2026 bestätigt): ein
    // einzelner Eintrag an ihrer Stelle wäre falsch. Ein aus der Serie
    // AUFGELÖSTES Vorkommen ist etwas anderes und kommt durch — es hat sein
    // eigenes Datum und seinen eigenen Schlüssel.
    if (event.recurring)
        return { action: "ignored", icalUid: uid, reason: "Serientermin" };
    if (!event.start || !event.end)
        return { action: "ignored", icalUid: uid, reason: "ohne Zeitangabe" };
    const organizer = (0, mailCustomerMatcher_1.normalizeAddress)(event.organizer?.email || context.senderEmail || "");
    const title = event.summary
        || String(context.subject || "").trim().slice(0, 255)
        || (context.source === "CALDAV" ? "Termin aus dem Kalender" : "Termin aus Outlook");
    const location = (0, calendarInvite_1.cleanLocation)(event.location);
    const notes = [
        (0, calendarInvite_1.cleanDescription)(event.description),
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
        externalOrigin: (0, calendarInvite_1.onlineMeetingOrigin)(event.onlineUrl),
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
        await prisma_client_1.default.meetingActivity.update({
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
    if (!anchor)
        return { action: "ignored", icalUid: uid, reason: "keine aktive Person im Firmenbaum" };
    try {
        const created = await prisma_client_1.default.meetingActivity.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId,
                kind: "MEETING",
                ...shared,
                customerId: context.customerId || null,
                createdByEmployeeId: anchor,
                icalUid: uid,
                ccEmails: event.attendees.map((attendee) => attendee.email).filter(Boolean).slice(0, 20),
                participants: {
                    create: ownerIds.map((employeeId) => ({
                        id: (0, nanoid_1.nanoid)(12),
                        participantType: "EMPLOYEE",
                        employeeId,
                    })),
                },
            },
            select: { id: true },
        });
        return { action: "created", icalUid: uid, meetingId: created.id };
    }
    catch (error) {
        /* REGEL 3, dritter Riegel: zwei Abrufe gleichzeitig (Zeitplan und
           «Jetzt abrufen», Postfach und Kalender) können denselben Termin im
           selben Moment anlegen wollen. Der eindeutige Schlüssel auf
           (tenantId, icalUid) lässt nur einen durch — der zweite aktualisiert
           stattdessen. */
        if (error?.code !== "P2002")
            throw error;
        const duplicate = await prisma_client_1.default.meetingActivity.findFirst({
            where: { tenantId, icalUid: uid },
            select: { id: true, externalOrigin: true },
        });
        if (!duplicate)
            throw error;
        if (!duplicate.externalOrigin)
            return { action: "ignored", icalUid: uid, reason: "im System angelegter Termin" };
        await prisma_client_1.default.meetingActivity.update({
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
exports.importCalendarEvent = importCalendarEvent;
/**
 * Der Mailweg: ein `text/calendar`-Teil aus dem Postfach. `senderEmail` ist der
 * Absender der Mail (für den Organisator-Vermerk), `customerId` die bereits
 * ermittelte Kundenzuordnung der Nachricht.
 */
const importCalendarObject = async (tenantId, icsText, context) => {
    const event = (0, calendarInvite_1.parseCalendarObject)(icsText);
    if (!event)
        return { action: "ignored", reason: "kein einzelner Termin" };
    return (0, exports.importCalendarEvent)(tenantId, event, context);
};
exports.importCalendarObject = importCalendarObject;
/**
 * Der Mailweg für WINMAIL.DAT (14.09.2026): der TNEF-Anhang wird zerlegt
 * (`tnef.ts`), und was darin an Terminen steckt, geht denselben Weg wie eine
 * .ics. Meist ist es genau einer — die Nachricht selbst ist die Einladung.
 * Steckt eine .ics als Anhang darin, können es mehrere sein; gemeldet wird
 * das Ergebnis des ersten, damit der Aufrufer wie gewohnt EINE Antwort hat.
 */
const importTnefObject = async (tenantId, payload, context) => {
    const events = (0, tnef_1.calendarEventsFromTnef)(payload);
    if (!events.length)
        return { action: "ignored", reason: "winmail.dat ohne Termin" };
    let first = null;
    for (const event of events) {
        const result = await (0, exports.importCalendarEvent)(tenantId, event, context);
        first = first ?? result;
    }
    return first;
};
exports.importTnefObject = importTnefObject;
/** Ein Kalenderteil aus dem Postfach, je nach Art als Text oder als TNEF gelesen. */
const importCalendarPayload = (tenantId, payload, kind, context) => kind === "TNEF"
    ? (0, exports.importTnefObject)(tenantId, payload, context)
    : (0, exports.importCalendarObject)(tenantId, payload.toString("utf8"), context);
exports.importCalendarPayload = importCalendarPayload;
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
const repairImportedMeetingOwners = async (tenantId) => {
    const orphans = await prisma_client_1.default.meetingActivity.findMany({
        where: {
            tenantId,
            NOT: { externalOrigin: null },
            participants: { none: { participantType: "EMPLOYEE" } },
        },
        select: { id: true, ccEmails: true, externalOrganizer: true, externalMailbox: true },
        take: 500,
    });
    if (!orphans.length)
        return 0;
    /* EIN Nachschlagen für alle: die Adressen aller Zeilen zusammen, dann die
       Personen dazu. Je Termin einzeln zu fragen wäre bei 500 Zeilen 500 mal
       dieselbe Tabelle. */
    const addressesOf = (row) => {
        const attendees = Array.isArray(row.ccEmails) ? row.ccEmails : [];
        const mailbox = mailboxAddressOf(row.externalMailbox);
        return [...attendees.map((value) => (0, mailCustomerMatcher_1.normalizeAddress)(String(value ?? ""))), (0, mailCustomerMatcher_1.normalizeAddress)(row.externalOrganizer || "")]
            .filter((address) => Boolean(address) && address !== mailbox);
    };
    const lookup = [...new Set(orphans.flatMap(addressesOf))];
    if (!lookup.length)
        return 0;
    const employees = await prisma_client_1.default.employee.findMany({
        where: { email: { in: lookup }, isActive: true, deletedAt: null },
        select: { id: true, email: true },
        orderBy: { createdAt: "asc" },
    });
    const byAddress = new Map(employees
        .map((employee) => [(0, mailCustomerMatcher_1.normalizeAddress)(employee.email), employee.id])
        .filter(([address]) => Boolean(address)));
    if (!byAddress.size)
        return 0;
    let repaired = 0;
    for (const row of orphans) {
        const owners = [...new Set(addressesOf(row).map((address) => byAddress.get(address)).filter(Boolean))];
        if (!owners.length)
            continue;
        await prisma_client_1.default.meetingActivity.update({
            where: { id: row.id },
            data: {
                createdByEmployeeId: owners[0],
                participants: employeeParticipants(owners),
            },
        });
        repaired += 1;
    }
    if (repaired)
        console.log(`[KALENDER] ${repaired} übernommene Termine nachträglich einer Person zugeordnet.`);
    return repaired;
};
exports.repairImportedMeetingOwners = repairImportedMeetingOwners;
//# sourceMappingURL=calendarImportService.js.map