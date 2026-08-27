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

/**
 * OUTLOOK/TEAMS → ERP-KALENDER (18.08.2026, erweitert 21.08.2026).
 *
 * Die Gegenrichtung zu `calendarMailService`: wird in Outlook oder Teams ein
 * Termin angelegt und das Firmenpostfach eingeladen, kommt die Einladung als
 * `text/calendar; method=REQUEST` in den Posteingang. Der Abruf reicht sie
 * hierher weiter, und der Termin steht im ERP-Kalender.
 *
 * BEIDE RICHTUNGEN (Vorgabe 21.08.2026: «hem gelen hem giden teams
 * toplantıları da takvime yazmalı»). Der Abruf liest zwei Ordner:
 *   Posteingang → eine Einladung, die wir BEKOMMEN haben
 *   Gesendet    → eine Einladung, die aus dem Firmenpostfach RAUSGEGANGEN ist
 *                 (ein Teams-Meeting, das jemand in Outlook angesetzt hat)
 * Beide landen im selben Kalender. Der Beitrittslink der Online-Besprechung
 * wird dabei aus der Einladung gezogen und am Termin gespeichert.
 *
 * DREI REGELN, DIE DEN KALENDER SAUBER HALTEN (Vorgabe 21.08.2026):
 *
 *  1. AKTUALISIEREN — der Schlüssel ist die UID. Dieselbe Einladung ein
 *     zweites Mal (weil der Termin in Outlook verschoben wurde) ändert den
 *     vorhandenen Eintrag, statt einen zweiten anzulegen. `METHOD:CANCEL`
 *     entfernt ihn wieder.
 *  2. NUR, WAS AUS DER MAIL KAM — ein Eintrag, den jemand IM SYSTEM angelegt
 *     hat, wird von hier NIE angefasst. Nur Zeilen mit `externalOrigin`
 *     gehören dem Organisator draussen; alles andere gehört uns.
 *  3. NUR EINMAL — was wir selbst verschickt haben, kommt über den
 *     Gesendet-Ordner (und als Kopie im Posteingang) wieder herein. Solche
 *     Einladungen werden an der UID erkannt und übersprungen, sonst stünde
 *     derselbe Termin zweimal im Kalender: einmal als eigener Eintrag, einmal
 *     als Import. Zusätzlich verhindert ein eindeutiger Schlüssel auf
 *     (tenantId, icalUid) das Doppel auch bei zwei gleichzeitigen Abrufen.
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

export interface CalendarImportContext {
    senderEmail?: string | null;
    customerId?: string | null;
    employeeId?: string | null;
    /** IN = Posteingang (wir wurden eingeladen), OUT = Gesendet (wir haben eingeladen). */
    direction?: "IN" | "OUT";
}

/** Eigene Einladungen kommen als Kopie zurück — die gehören nicht importiert. */
const isOwnUid = (uid: string) => uid.startsWith("offitec-");

/**
 * Trägt ein eingegangenes Kalenderobjekt in den ERP-Kalender ein.
 * `senderEmail` ist der Absender der Mail (für den Organisator-Vermerk),
 * `customerId` die bereits ermittelte Kundenzuordnung der Nachricht.
 */
export const importCalendarObject = async (
    tenantId: string,
    icsText: string,
    context: CalendarImportContext,
): Promise<CalendarImportResult> => {
    const event: ParsedCalendarEvent | null = parseCalendarObject(icsText);
    if (!event) return { action: "ignored", reason: "kein einzelner Termin" };
    // Antworten (Zusage/Absage) ändern den Termin nicht — sie stehen als Mail
    // in der Kommunikation, das genügt.
    if (event.method === "REPLY") return { action: "ignored", reason: "Antwort auf eine Einladung" };
    // REGEL 3, erster Riegel: unsere eigene Einladung, an der UID erkannt.
    if (isOwnUid(event.uid)) return { action: "ignored", reason: "eigene Einladung" };

    const existing = await (prisma as any).meetingActivity.findFirst({
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
        const ownAppointment = await prisma.appointment.findFirst({
            where: { tenantId, icalUid: event.uid },
            select: { id: true },
        });
        if (ownAppointment) return { action: "ignored", reason: "eigener Projekttermin" };
    }

    if (event.method === "CANCEL" || event.cancelled) {
        if (!existing) return { action: "ignored", reason: "Absage zu unbekanntem Termin" };
        await (prisma as any).meetingActivity.delete({ where: { id: existing.id } });
        return { action: "cancelled", meetingId: existing.id };
    }

    // Serien bleiben aussen vor (Vorgabe 21.08.2026 bestätigt): ein einzelner
    // Eintrag an ihrer Stelle wäre falsch. Mit eigenem Grund, damit im
    // Protokoll steht, warum das wöchentliche Teams-Meeting fehlt.
    if (event.recurring) return { action: "ignored", reason: "Serientermin" };
    if (!event.start || !event.end) return { action: "ignored", reason: "ohne Zeitangabe" };

    const organizer = normalizeAddress(event.organizer?.email || context.senderEmail || "");
    const title = event.summary || "Termin aus Outlook";
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
        meetingUrl: event.onlineUrl,
    };

    if (existing) {
        // Eine ältere Fassung überschreibt nichts: Outlook schickt Einladungen
        // mehrfach, und die letzte gültige gewinnt.
        if ((existing.icalSequence ?? 0) > event.sequence) {
            return { action: "ignored", reason: "ältere Fassung" };
        }
        await (prisma as any).meetingActivity.update({
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
        const fallback = await prisma.employee.findFirst({
            where: { tenantId, isActive: true, deletedAt: null },
            select: { id: true },
            orderBy: { createdAt: "asc" },
        });
        createdByEmployeeId = fallback?.id || null;
    }
    if (!createdByEmployeeId) return { action: "ignored", reason: "kein Benutzer für die Zuordnung" };

    try {
        const created = await (prisma as any).meetingActivity.create({
            data: {
                id: nanoid(12),
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
    } catch (error: any) {
        /* REGEL 3, dritter Riegel: zwei Abrufe gleichzeitig (Zeitplan und
           «Jetzt abrufen») können dieselbe Einladung im selben Moment anlegen
           wollen. Der eindeutige Schlüssel auf (tenantId, icalUid) lässt nur
           einen durch — der zweite aktualisiert stattdessen. */
        if (error?.code !== "P2002") throw error;
        const duplicate = await (prisma as any).meetingActivity.findFirst({
            where: { tenantId, icalUid: event.uid },
            select: { id: true, externalOrigin: true },
        });
        if (!duplicate) throw error;
        if (!duplicate.externalOrigin) return { action: "ignored", reason: "im System angelegter Termin" };
        await (prisma as any).meetingActivity.update({ where: { id: duplicate.id }, data: shared });
        return { action: "updated", meetingId: duplicate.id };
    }
};
