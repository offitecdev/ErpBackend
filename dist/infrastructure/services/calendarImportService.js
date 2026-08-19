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
const isOwnInvite = (uid) => uid.startsWith("offitec-");
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
    if (isOwnInvite(event.uid))
        return { action: "ignored", reason: "eigene Einladung" };
    const existing = await prisma_client_1.default.meetingActivity.findFirst({
        where: { tenantId, icalUid: event.uid },
        select: { id: true, icalSequence: true, externalOrigin: true },
    });
    if (event.method === "CANCEL" || event.cancelled) {
        if (!existing)
            return { action: "ignored", reason: "Absage zu unbekanntem Termin" };
        await prisma_client_1.default.meetingActivity.delete({ where: { id: existing.id } });
        return { action: "cancelled", meetingId: existing.id };
    }
    if (!event.start || !event.end)
        return { action: "ignored", reason: "ohne Zeitangabe" };
    const organizer = (0, mailCustomerMatcher_1.normalizeAddress)(event.organizer?.email || context.senderEmail || "");
    const title = event.summary || "Termin aus Outlook";
    const notes = [
        event.description || "",
        event.location ? `Ort: ${event.location}` : "",
        event.attendees.length
            ? `Teilnehmende: ${event.attendees.map((a) => a.name || a.email).filter(Boolean).join(", ")}`
            : "",
    ].filter(Boolean).join("\n").slice(0, 4000) || null;
    if (existing) {
        // Eine ältere oder gleich alte Fassung überschreibt nichts: Outlook
        // schickt Einladungen mehrfach, und die letzte gültige gewinnt.
        if ((existing.icalSequence ?? 0) > event.sequence) {
            return { action: "ignored", reason: "ältere Fassung" };
        }
        await prisma_client_1.default.meetingActivity.update({
            where: { id: existing.id },
            data: {
                title,
                notes,
                startTime: event.start,
                endTime: event.end,
                icalSequence: event.sequence,
                externalOrganizer: organizer || null,
                ...(context.customerId ? { customerId: context.customerId } : {}),
            },
        });
        return { action: "updated", meetingId: existing.id };
    }
    // Der Eintrag braucht einen Urheber; ohne bekannte Person nehmen wir die
    // erste aktive des Mandanten (die Spalte ist Pflicht und zeigt nur an, wem
    // der Eintrag "gehört").
    let createdByEmployeeId = context.employeeId || null;
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
    const created = await prisma_client_1.default.meetingActivity.create({
        data: {
            id: (0, nanoid_1.nanoid)(12),
            tenantId,
            kind: "MEETING",
            title,
            notes,
            startTime: event.start,
            endTime: event.end,
            customerId: context.customerId || null,
            createdByEmployeeId,
            icalUid: event.uid,
            icalSequence: event.sequence,
            // Herkunft merken: für solche Termine verschickt das ERP KEINE
            // eigenen Einladungen — der Organisator sitzt in Outlook.
            externalOrigin: "OUTLOOK",
            externalOrganizer: organizer || null,
            ccEmails: event.attendees.map((attendee) => attendee.email).filter(Boolean).slice(0, 20),
        },
        select: { id: true },
    });
    return { action: "created", meetingId: created.id };
};
exports.importCalendarObject = importCalendarObject;
//# sourceMappingURL=calendarImportService.js.map