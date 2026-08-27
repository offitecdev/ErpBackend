import { parseAppointmentDays } from '../src/presentation/controllers/appointmentSeries';
import { buildInvite } from '../src/infrastructure/services/calendarInvite';
import { buildInviteText, buildInviteHtml } from '../src/infrastructure/services/calendarInviteMail';

const iso = (d: string) => new Date(d).toISOString();

// 1) Drei Tage mit eigenen Zeiten + eine Nachtschicht.
const days = parseAppointmentDays({
    days: [
        { startTime: iso('2026-09-02T08:00:00+02:00'), endTime: iso('2026-09-02T17:00:00+02:00') },
        { startTime: iso('2026-08-31T08:00:00+02:00'), endTime: iso('2026-08-31T12:00:00+02:00') },
        { startTime: iso('2026-09-01T20:00:00+02:00'), endTime: iso('2026-09-02T02:00:00+02:00') },
    ],
});
console.log('days sorted:', days.map((d) => `${d.startTime.toISOString()} -> ${d.endTime.toISOString()}`));

const expectFail = (label: string, body: any) => {
    try { parseAppointmentDays(body); console.log('NOT REJECTED (bad):', label); }
    catch (error: any) { console.log('rejected ok:', label, '|', error.message); }
};
expectFail('same day twice', { days: [
    { startTime: iso('2026-09-02T08:00:00+02:00'), endTime: iso('2026-09-02T10:00:00+02:00') },
    { startTime: iso('2026-09-02T11:00:00+02:00'), endTime: iso('2026-09-02T12:00:00+02:00') },
] });
expectFail('longer than 24h', { days: [
    { startTime: iso('2026-09-02T08:00:00+02:00'), endTime: iso('2026-09-03T09:00:00+02:00') },
] });
expectFail('overlapping night shift', { days: [
    { startTime: iso('2026-09-01T20:00:00+02:00'), endTime: iso('2026-09-02T06:00:00+02:00') },
    { startTime: iso('2026-09-02T05:00:00+02:00'), endTime: iso('2026-09-02T12:00:00+02:00') },
] });
// Einzelner Tag, alte Form — muss weiter gehen.
console.log('single day still works:', parseAppointmentDays({
    startTime: iso('2026-09-02T08:00:00+02:00'), endTime: iso('2026-09-02T17:00:00+02:00'),
}).length === 1);

// 2) Das Kalenderobjekt: ein VEVENT je Tag, jedes mit eigener UID.
const ics = buildInvite({
    uid: 'a@x', sequence: 0, method: 'REQUEST',
    start: days[0]!.startTime, end: days[0]!.endTime,
    summary: 'Montagetermin – Beispiel',
    organizer: { email: 'buero@x.ch', name: 'Offitec' },
    attendees: [{ email: 'tech@x.ch', name: 'Muster' }],
    occurrences: days.map((d, i) => ({ uid: `day${i}@x`, sequence: 0, start: d.startTime, end: d.endTime })),
});
console.log('VEVENT count:', (ics.match(/BEGIN:VEVENT/g) || []).length, '| UIDs:', (ics.match(/^UID:.*$/gm) || []).join(','));

// 3) Die Karte in der Mail: der Einsatzplan.
const card = {
    method: 'REQUEST' as const, sequence: 0, audience: 'TEAM' as const, language: 'de' as const,
    start: days[0]!.startTime, end: days[0]!.endTime,
    schedule: days.map((d) => ({ start: d.startTime, end: d.endTime })),
    summary: 'Montagetermin – Beispiel', location: 'Musterstrasse 1, 8000 Zürich',
    details: [{ label: 'Projekt', value: 'PR-2026-00042' }], senderName: 'Offitec Verwaltungspanel',
};
const text = buildInviteText(card);
console.log('--- text ---');
console.log(text.split('\n').slice(0, 10).join('\n'));
const html = buildInviteHtml(card);
console.log('html has Einsatzplan:', html.includes('Einsatzplan'), '| day rows:', (html.match(/>\(\d\)</g) || []).length);
