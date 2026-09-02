/* Welcher Monteur haengt an welchem Termin? */
import prisma from '../src/infrastructure/database/prisma.client';

(async () => {
    const appts = await prisma.appointment.findMany({
        where: { tenantId: 'main-tenant' },
        orderBy: { startTime: 'desc' },
        take: 12,
        select: {
            id: true,
            status: true,
            startTime: true,
            technicianAssignments: { select: { technician: { select: { email: true } } } },
        },
    });
    appts.forEach((a) => {
        console.log(a.id, a.status, a.startTime.toISOString().slice(0, 10), '|', a.technicianAssignments.map((t) => t.technician?.email).join(', '));
    });
    await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
