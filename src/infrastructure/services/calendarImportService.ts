import { nanoid } from "nanoid";
import prisma from "../database/prisma.client";
import { parseCalendarObject, type ParsedCalendarEvent } from "./calendarInvite";
import { normalizeAddress } from "./outlook/mailCustomerMatcher";

/**
 * OUTLOOK → ERP-KALENDER (18.08.2026).
 *
 * Die Gegenrichtung zu `calendarMailService`: wird in Outlook ein Termin
 * angelegt und das Firmenpostfach eingeladen, kommt die Einladung als
 * `text/calendar; method=REQUEST` in den Posteingang. Der Abruf reicht sie
 * hierher weiter, und der Termin steht im ERP-Kalender.
 *
 * Der Schlüssel ist die UID: dieselbe Einladung ein zweites Mal (weil der
 * Termin in Outlook verschoben wurde) AKTUALISIERT den Eintrag, statt einen
 * zweiten anzulegen. `METHOD:CANCEL` entfernt ihn wieder.
 *
 * Abgelegt wird als `MeetingActivity` (Besprechung) und nicht als
 * `Appointment`: ein Projekttermin verlangt ein Projekt, das eine Einladung von
 * aussen nicht kennt. Besprechungen erscheinen im selben Kalender.
 *
 * WICHTIG — was NICHT geht: ein Termin, den jemand in Outlook nur für sich
 * selbst einträgt (ohne das Firmenpostfach einzuladen), erzeugt keine Mail und
 * kann auf diesem Weg nicht ankommen. Dafür bräuchte es ein Kalenderprotokoll
 * (CalDAV bzw. Exchange) mit eigenen Zugangsdaten.
 */

export interface CalendarImportResult {
    action: "created" | "updated" | "cancelled" | "ignored";
    meetingId?: string;
    reason?: string;
}

/** Eigene Einladungen kommen als Kopie zurück — die gehören nicht importiert. */
const isOwnInvite = (uid: string) => uid.startsWith("offitec-");

/**
 * Trägt ein eingegangenes Kalenderobjekt in den ERP-Kalender ein.
 * `senderEmail` ist der Absender der Mail (für den Organisator-Vermerk),
 * `customerId` die bereits ermittelte Kundenzuordnung der Nachricht.
 */
export const importCalendarObject = async (
    tenantId: string,
    icsText: string,
    context: { senderEmail?: string | null; customerId?: string | null; employeeId?: string | null },
): Promise<CalendarImportResult> => {
    const event: ParsedCalendarEvent | null = parseCalendarObject(icsText);
    if (!event) return { action: "ignored", reason: "kein einzelner Termin" };
    // Antworten (Zusage/Absage) ändern den Termin nicht — sie stehen als Mail
    // in der Kommunikation, das genügt.
    if (event.method === "REPLY") return { action: "ignored", reason: "Antwort auf eine Einladung" };
    if (isOwnInvite(event.uid)) return { action: "ignored", reason: "eigene Einladung" };

    const existing = await (prisma as any).meetingActivity.findFirst({
        where: { tenantId, icalUid: event.uid },
        select: { id: true, icalSequence: true, externalOrigin: true },
    });

    if (event.method === "CANCEL" || event.cancelled) {
        if (!existing) return { action: "ignored", reason: "Absage zu unbekanntem Termin" };
        await (prisma as any).meetingActivity.delete({ where: { id: existing.id } });
        return { action: "cancelled", meetingId: existing.id };
    }

    if (!event.start || !event.end) return { action: "ignored", reason: "ohne Zeitangabe" };

    const organizer = normalizeAddress(event.organizer?.email || context.senderEmail || "");
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
        await (prisma as any).meetingActivity.update({
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
        const fallback = await prisma.employee.findFirst({
            where: { tenantId, isActive: true, deletedAt: null },
            select: { id: true },
            orderBy: { createdAt: "asc" },
        });
        createdByEmployeeId = fallback?.id || null;
    }
    if (!createdByEmployeeId) return { action: "ignored", reason: "kein Benutzer für die Zuordnung" };

    const created = await (prisma as any).meetingActivity.create({
        data: {
            id: nanoid(12),
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
