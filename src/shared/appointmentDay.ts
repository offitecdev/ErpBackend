/**
 * DER TAG ENTSCHEIDET, WAS EIN TERMIN IST.
 *
 * Vorgabe Samet (03.09.2026): «Ein Termin vom 31. August darf am 3. September
 * nicht als laufend dastehen — der Kalender zeigt ihn von selbst als
 * abgeschlossen. Ein Termin, der HEUTE angelegt wird, bleibt laufend, bis der
 * Tag zu Ende ist — oder bis der Monteur oder der Verantwortliche ihn
 * abschliesst.»
 *
 * Also der TAG, nicht die Uhrzeit:
 *   · Tag vorbei   ⇒ abgeschlossen  (COMPLETED, Etikett «abgeschlossen»)
 *   · heute        ⇒ laufend        (BOOKED,    Etikett «laufend»)
 *   · noch bevor   ⇒ geplant        (BOOKED,    Etikett «geplant»)
 *
 * «Vorbei» heisst: der Termin ist zu Ende UND der Tag, an dem er begann, ist
 * um. Beides — eine Nachtmontage von 20:00 bis 02:00 ist EIN Termin über
 * Mitternacht und darf um 00:00 nicht als abgeschlossen gelten, solange noch
 * gearbeitet wird; bis dahin ist sie «laufend». «Heute» ist der Tag der
 * Server-Uhr, wie überall im Terminwesen (localDayKey, startOfDay).
 *
 * Gefragt wird an drei Stellen: beim Anlegen, beim Verschieben eines offenen
 * Tages, und im Tagesabschluss um Mitternacht (MaintenanceReminderService),
 * der nachführt, was seit dem Schreiben weiterging — gestern wird vorbei,
 * heute wird laufend. Abgeschlossen wird ausserdem durch «Fertig und senden»
 * des Monteurs und «Abschliessen» des Verantwortlichen; ein abgeschlossener
 * Tag wird nicht mehr verschoben (ProjectController).
 */
import type { CalendarLabelRole } from './calendarLabels';

const startOfDay = (date: Date): Date => {
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    return day;
};

const startOfNextDay = (date: Date): Date => {
    const day = startOfDay(date);
    day.setDate(day.getDate() + 1);
    return day;
};

export interface AppointmentDaySpan {
    startTime: Date | string;
    endTime: Date | string;
}

/** Ist dieser Tag vorbei? (zu Ende UND sein Anfangstag liegt vor heute) */
export const appointmentDayIsOver = (span: AppointmentDaySpan, now: Date = new Date()): boolean => {
    const start = new Date(span.startTime);
    const end = new Date(span.endTime);
    return end.getTime() < now.getTime() && start.getTime() < startOfDay(now).getTime();
};

/** Der Status, mit dem ein Tag geschrieben wird: vorbei ⇒ abgeschlossen, sonst offen. */
export const statusForAppointmentDay = (span: AppointmentDaySpan, now: Date = new Date()): "COMPLETED" | "BOOKED" =>
    appointmentDayIsOver(span, now) ? "COMPLETED" : "BOOKED";

/**
 * Die Etikett-Rolle, die zum Tag passt: vorbei ⇒ DONE; heute — oder gestern
 * begonnen und noch nicht zu Ende — ⇒ ONGOING; sonst PLANNED.
 */
export const labelRoleForAppointmentDay = (span: AppointmentDaySpan, now: Date = new Date()): CalendarLabelRole => {
    if (appointmentDayIsOver(span, now)) return 'DONE';
    return new Date(span.startTime).getTime() < startOfNextDay(now).getTime() ? 'ONGOING' : 'PLANNED';
};

/**
 * Dieselben Fragen als Prisma-Bedingungen, für den Tagesabschluss, der die
 * Zeilen SUCHT. Müssen den Funktionen oben genau entsprechen — deshalb stehen
 * sie daneben und nicht im Dienst.
 */
export const appointmentDayOverWhere = (now: Date = new Date()) => ({
    endTime: { lt: now },
    startTime: { lt: startOfDay(now) },
});

/**
 * «Heute oder noch am Laufen» — gilt nur NACH dem Abschliessen der vorbeien
 * Tage (appointmentDayOverWhere): danach sind die offenen Zeilen, die vor
 * morgen beginnen, genau die laufenden.
 */
export const appointmentDayTodayWhere = (now: Date = new Date()) => ({
    startTime: { lt: startOfNextDay(now) },
});
