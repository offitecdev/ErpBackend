"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.importCalendarObject = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const calendarInvite_1 = require("./calendarInvite");
const mailCustomerMatcher_1 = require("./outlook/mailCustomerMatcher");
/** Eigene Einladungen kommen als Kopie zurück — die gehören nicht importiert. */
const isOwnUid = (uid) => uid.startsWith("offitec-");
/**
 * Trägt ein eingegangenes Kalenderobjekt in den ERP-Kalender ein.
 * `senderEmail` ist der Absender der Mail (für den Organisator-Vermerk),
 * `customerId` die bereits ermittelte Kundenzuordnung der Nachricht.
 */
const importCalendarObject = async (tenantId, icsText, context) => {
    const event = (0, calendarInvite_1.parseCalendarObject)(icsText);
    if (!event)
        return { action: "ignored", reason: "kein einzelner Termin" };
    // Antworten (Zusage/Absage) ändern den Termin nicht — sie stehen als Mail
    // in der Kommunikation, das genügt.
    if (event.method === "REPLY")
        return { action: "ignored", reason: "Antwort auf eine Einladung" };
    // REGEL 3, erster Riegel: unsere eigene Einladung, an der UID erkannt.
    if (isOwnUid(event.uid))
        return { action: "ignored", reason: "eigene Einladung" };
    const existing = await prisma_client_1.default.meetingActivity.findFirst({
        where: { tenantId, icalUid: event.uid },
        select: { id: true, icalSequence: true, externalOrigin: true },
    });
    // REGEL 2/3, zweiter Riegel: Der Eintrag existiert, gehört aber UNS — im
    // System angelegt und von dort aus verschickt. Eine hereinkommende Fassung
    // desselben Termins (Kopie, Weiterleitung, Zusage mit Anhang) darf ihn
    // weder überschreiben noch neben sich ein Doppel stellen.
    if (existing && !existing.externalOrigin) {
        return { action: "ignored", reason: "im System angelegter Termin" };
    }
    if (!existing) {
        // Dieselbe Frage für Projekttermine: die tragen ihre UID ebenfalls, und
        // ein Import daneben wäre genau das Doppel, das nicht sein soll.
        const ownAppointment = await prisma_client_1.default.appointment.findFirst({
            where: { tenantId, icalUid: event.uid },
            select: { id: true },
        });
        if (ownAppointment)
            return { action: "ignored", reason: "eigener Projekttermin" };
    }
    if (event.method === "CANCEL" || event.cancelled) {
        if (!existing)
            return { action: "ignored", reason: "Absage zu unbekanntem Termin" };
        await prisma_client_1.default.meetingActivity.delete({ where: { id: existing.id } });
        return { action: "cancelled", meetingId: existing.id };
    }
    // Serien bleiben aussen vor (Vorgabe 21.08.2026 bestätigt): ein einzelner
    // Eintrag an ihrer Stelle wäre falsch. Mit eigenem Grund, damit im
    // Protokoll steht, warum das wöchentliche Teams-Meeting fehlt.
    if (event.recurring)
        return { action: "ignored", reason: "Serientermin" };
    if (!event.start || !event.end)
        return { action: "ignored", reason: "ohne Zeitangabe" };
    const organizer = (0, mailCustomerMatcher_1.normalizeAddress)(event.organizer?.email || context.senderEmail || "");
    const title = event.summary || "Termin aus Outlook";
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
        meetingUrl: event.onlineUrl,
    };
    if (existing) {
        // Eine ältere Fassung überschreibt nichts: Outlook schickt Einladungen
        // mehrfach, und die letzte gültige gewinnt.
        if ((existing.icalSequence ?? 0) > event.sequence) {
            return { action: "ignored", reason: "ältere Fassung" };
        }
        await prisma_client_1.default.meetingActivity.update({
            where: { id: existing.id },
            data: {
                ...shared,
                ...(context.customerId ? { customerId: context.customerId } : {}),
            },
        });
        return { action: "updated", meetingId: existing.id };
    }
    /* Der Eintrag braucht einen Urheber; die Spalte ist Pflicht und zeigt nur
       an, wem der Eintrag "gehört".
       Im Posteingang ist die erkannte Person der ABSENDER, also der
       Organisator — die passt. Im Gesendet-Ordner ist sie eine EMPFÄNGERIN;
       sie zum Urheber zu machen wäre schlicht falsch, dort nehmen wir die
       Rückfallperson. */
    let createdByEmployeeId = context.direction === "OUT" ? null : (context.employeeId || null);
    if (!createdByEmployeeId) {
        const fallback = await prisma_client_1.default.employee.findFirst({
            where: { tenantId, isActive: true, deletedAt: null },
            select: { id: true },
            orderBy: { createdAt: "asc" },
        });
        createdByEmployeeId = fallback?.id || null;
    }
    if (!createdByEmployeeId)
        return { action: "ignored", reason: "kein Benutzer für die Zuordnung" };
    try {
        const created = await prisma_client_1.default.meetingActivity.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId,
                kind: "MEETING",
                ...shared,
                customerId: context.customerId || null,
                createdByEmployeeId,
                icalUid: event.uid,
                // Herkunft merken: für solche Termine verschickt das ERP KEINE
                // eigenen Einladungen — der Organisator sitzt in Outlook.
                ccEmails: event.attendees.map((attendee) => attendee.email).filter(Boolean).slice(0, 20),
            },
            select: { id: true },
        });
        return { action: "created", meetingId: created.id };
    }
    catch (error) {
        /* REGEL 3, dritter Riegel: zwei Abrufe gleichzeitig (Zeitplan und
           «Jetzt abrufen») können dieselbe Einladung im selben Moment anlegen
           wollen. Der eindeutige Schlüssel auf (tenantId, icalUid) lässt nur
           einen durch — der zweite aktualisiert stattdessen. */
        if (error?.code !== "P2002")
            throw error;
        const duplicate = await prisma_client_1.default.meetingActivity.findFirst({
            where: { tenantId, icalUid: event.uid },
            select: { id: true, externalOrigin: true },
        });
        if (!duplicate)
            throw error;
        if (!duplicate.externalOrigin)
            return { action: "ignored", reason: "im System angelegter Termin" };
        await prisma_client_1.default.meetingActivity.update({ where: { id: duplicate.id }, data: shared });
        return { action: "updated", meetingId: duplicate.id };
    }
};
exports.importCalendarObject = importCalendarObject;
//# sourceMappingURL=calendarImportService.js.map