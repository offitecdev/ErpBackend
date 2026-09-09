"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appointmentDayTodayWhere = exports.appointmentDayOverWhere = exports.labelRoleForAppointmentDay = exports.statusForAppointmentDay = exports.appointmentDayIsOver = void 0;
const startOfDay = (date) => {
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    return day;
};
const startOfNextDay = (date) => {
    const day = startOfDay(date);
    day.setDate(day.getDate() + 1);
    return day;
};
/** Ist dieser Tag vorbei? (zu Ende UND sein Anfangstag liegt vor heute) */
const appointmentDayIsOver = (span, now = new Date()) => {
    const start = new Date(span.startTime);
    const end = new Date(span.endTime);
    return end.getTime() < now.getTime() && start.getTime() < startOfDay(now).getTime();
};
exports.appointmentDayIsOver = appointmentDayIsOver;
/** Der Status, mit dem ein Tag geschrieben wird: vorbei ⇒ abgeschlossen, sonst offen. */
const statusForAppointmentDay = (span, now = new Date()) => (0, exports.appointmentDayIsOver)(span, now) ? "COMPLETED" : "BOOKED";
exports.statusForAppointmentDay = statusForAppointmentDay;
/**
 * Die Etikett-Rolle, die zum Tag passt: vorbei ⇒ DONE; heute — oder gestern
 * begonnen und noch nicht zu Ende — ⇒ ONGOING; sonst PLANNED.
 */
const labelRoleForAppointmentDay = (span, now = new Date()) => {
    if ((0, exports.appointmentDayIsOver)(span, now))
        return 'DONE';
    return new Date(span.startTime).getTime() < startOfNextDay(now).getTime() ? 'ONGOING' : 'PLANNED';
};
exports.labelRoleForAppointmentDay = labelRoleForAppointmentDay;
/**
 * Dieselben Fragen als Prisma-Bedingungen, für den Tagesabschluss, der die
 * Zeilen SUCHT. Müssen den Funktionen oben genau entsprechen — deshalb stehen
 * sie daneben und nicht im Dienst.
 */
const appointmentDayOverWhere = (now = new Date()) => ({
    endTime: { lt: now },
    startTime: { lt: startOfDay(now) },
});
exports.appointmentDayOverWhere = appointmentDayOverWhere;
/**
 * «Heute oder noch am Laufen» — gilt nur NACH dem Abschliessen der vorbeien
 * Tage (appointmentDayOverWhere): danach sind die offenen Zeilen, die vor
 * morgen beginnen, genau die laufenden.
 */
const appointmentDayTodayWhere = (now = new Date()) => ({
    startTime: { lt: startOfNextDay(now) },
});
exports.appointmentDayTodayWhere = appointmentDayTodayWhere;
//# sourceMappingURL=appointmentDay.js.map