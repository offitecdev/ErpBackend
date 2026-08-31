"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.importCalendarObject = exports.importCalendarEvent = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const calendarInvite_1 = require("./calendarInvite");
const mailCustomerMatcher_1 = require("./outlook/mailCustomerMatcher");
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
/**
 * WEM GEHÖRT DER TERMIN? Bei CYON gibt es kein Graph-Profil, deshalb wird die
 * Person allein aus den Mail-/ICS-Adressen bestimmt:
 *
 *   IN  = unsere Adressen in To/CC beziehungsweise ATTENDEE
 *   OUT = unsere Adresse als ORGANIZER/Absender
 *
 * Gesucht wird im ganzen Firmenbaum. Die Reihenfolge der Adressen bleibt
 * erhalten; die erste gefundene Person wird Pflicht-Urheber, alle gefundenen
 * Personen werden Teilnehmer. So ist dieselbe Einladung für jeden ihrer
 * internen Empfänger sichtbar, unabhängig vom ausgewählten Mandanten.
 */
const resolveOwners = async (tenantId, event, context) => {
    const candidateAddresses = (context.direction === "OUT"
        ? [event.organizer?.email, context.senderEmail]
        : [...(context.recipientEmails || []), ...event.attendees.map((attendee) => attendee.email)]).map(mailCustomerMatcher_1.normalizeAddress).filter(Boolean);
    /* Employee.email is globally unique. Matching by the exact mail address is
       therefore both tenant-independent and safe: selecting another company
       never changes the identity behind the address. */
    const employees = candidateAddresses.length ? await prisma_client_1.default.employee.findMany({
        where: {
            email: { in: [...new Set(candidateAddresses)] },
            isActive: true,
            deletedAt: null,
        },
        select: { id: true, email: true, createdAt: true },
        orderBy: { createdAt: "asc" },
    }) : [];
    const byAddress = new Map(employees
        .map((employee) => [(0, mailCustomerMatcher_1.normalizeAddress)(employee.email), employee.id])
        .filter(([address]) => Boolean(address)));
    const matched = [...new Set(candidateAddresses.map((address) => byAddress.get(address)).filter(Boolean))];
    if (matched.length)
        return matched;
    /* CalDAV has no mail envelope. Keep its old fallback so that an explicitly
       configured calendar does not silently stop importing. MAIL invitations
       never fall back to an arbitrary employee: that would expose a personal
       meeting to the wrong person. */
    if (context.source === "CALDAV") {
        const mailboxAddress = (0, mailCustomerMatcher_1.normalizeAddress)(context.recipientEmails?.[0] || "");
        if (mailboxAddress) {
            const mailboxOwner = byAddress.get(mailboxAddress);
            if (mailboxOwner)
                return [mailboxOwner];
        }
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
        return fallback?.id ? [fallback.id] : [];
    }
    return [];
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
    const title = event.summary || (context.source === "CALDAV" ? "Termin aus dem Kalender" : "Termin aus Outlook");
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
    const ownerIds = await resolveOwners(tenantId, event, context);
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
    const createdByEmployeeId = ownerIds[0] || null;
    if (!createdByEmployeeId)
        return { action: "ignored", icalUid: uid, reason: "kein Benutzer für die Zuordnung" };
    try {
        const created = await prisma_client_1.default.meetingActivity.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId,
                kind: "MEETING",
                ...shared,
                customerId: context.customerId || null,
                createdByEmployeeId,
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
//# sourceMappingURL=calendarImportService.js.map