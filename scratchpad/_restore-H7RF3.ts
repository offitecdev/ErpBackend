/* 03.09.2026: Der abgeschlossene Termin H7RF3-zRiG (ABC Teknoloji, 09:00–15:30)
   wurde versehentlich vom 02.09. auf den 03.09. verschoben — sein Rapport
   blieb auf dem 02.09. Zurück auf den ursprünglichen Platz. */
import prisma from '../src/infrastructure/database/prisma.client';

const ID = 'H7RF3-zRiG';
const START = new Date('2026-09-02T06:00:00.000Z'); // 09:00 Ortszeit (GMT+3)
const END = new Date('2026-09-02T12:30:00.000Z');   // 15:30 Ortszeit

(async () => {
    const before = await prisma.appointment.findUnique({
        where: { id: ID },
        select: { id: true, status: true, startTime: true, endTime: true, seriesId: true, dayIndex: true, reports: { select: { id: true, workDate: true } } },
    });
    if (!before) throw new Error('Termin nicht gefunden.');
    console.log('vorher :', before.startTime.toString().slice(4, 21), '->', before.endTime.toString().slice(16, 21), '|', before.status, '| Rapport-Arbeitstag:', before.reports.map((r) => r.workDate.toISOString().slice(0, 10)).join(', ') || '-');

    const after = await prisma.appointment.update({
        where: { id: ID },
        data: { startTime: START, endTime: END },
        select: { startTime: true, endTime: true, status: true },
    });
    console.log('nachher:', after.startTime.toString().slice(4, 21), '->', after.endTime.toString().slice(16, 21), '|', after.status);

    // Die Serie neu durchnummerieren (01.09. = Tag 1, 02.09. = Tag 2).
    if (before.seriesId) {
        const days = await prisma.appointment.findMany({ where: { seriesId: before.seriesId }, orderBy: { startTime: 'asc' }, select: { id: true, startTime: true } });
        for (let index = 0; index < days.length; index += 1) {
            await prisma.appointment.update({ where: { id: days[index]!.id }, data: { dayIndex: index } });
        }
        console.log('Serie', before.seriesId, ':', days.map((d, i) => `Tag ${i + 1} = ${d.startTime.toString().slice(4, 10)}`).join(', '));
    }
    await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
