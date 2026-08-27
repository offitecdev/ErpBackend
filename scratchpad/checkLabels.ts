import prisma from '../src/infrastructure/database/prisma.client';

(async () => {
    const labels = await prisma.calendarLabel.findMany({ orderBy: [{ tenantId: 'asc' }, { sortOrder: 'asc' }] });
    console.log('labels:', labels.length);
    for (const l of labels) console.log(l.tenantId, l.role, l.name, l.color, l.sortOrder, l.hidden ? 'ausgeblendet' : '');
    const [a, m, t] = await Promise.all([
        prisma.appointment.groupBy({ by: ['labelId'], _count: { _all: true } }),
        prisma.meetingActivity.groupBy({ by: ['labelId'], _count: { _all: true } }),
        prisma.crmTask.groupBy({ by: ['labelId'], _count: { _all: true } }),
    ]);
    console.log('appointments by label:', a);
    console.log('meetings by label:', m);
    console.log('tasks by label:', t);
    await prisma.$disconnect();
})();
