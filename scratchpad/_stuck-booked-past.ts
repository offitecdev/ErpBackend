/* Welche Projekttermine sind noch BOOKED, obwohl ihr Tag vorbei ist — und warum
   hat runAutoFinishInstallationPass sie nicht abgeschlossen? */
import prisma from '../src/infrastructure/database/prisma.client';

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

(async () => {
    const now = new Date();
    const today = startOfDay(now);
    const rows = await prisma.appointment.findMany({
        where: { projectId: { not: null }, status: 'BOOKED', endTime: { lt: now }, startTime: { lt: today } },
        orderBy: { startTime: 'asc' },
        select: {
            id: true, tenantId: true, startTime: true, endTime: true, assignedTechId: true, customerId: true,
            technicianAssignments: { select: { technicianId: true } },
            reports: { select: { id: true } },
        },
    });
    const withTech = rows.filter((r) => r.assignedTechId || r.technicianAssignments.length);
    console.log('server now      :', now.toString());
    console.log('BOOKED + day over:', rows.length);
    console.log('  with technician:', withTech.length, ' without:', rows.length - withTech.length);
    console.log('  with a report  :', rows.filter((r) => r.reports.length).length);
    console.log('  oldest / newest:', rows[0]?.startTime.toISOString().slice(0, 10), '/', rows[rows.length - 1]?.startTime.toISOString().slice(0, 10));
    const sep = rows.filter((r) => r.startTime.toISOString().startsWith('2026-09-02') || r.startTime.toISOString().startsWith('2026-09-01'));
    console.log('--- rows starting 01./02.09.2026:');
    sep.forEach((r) => console.log(r.id, r.tenantId, r.startTime.toISOString(), '->', r.endTime.toISOString(),
        '| tech:', r.assignedTechId || '-', '| assignments:', r.technicianAssignments.length, '| reports:', r.reports.length, '| customer:', r.customerId));
    const byTenant: Record<string, number> = {};
    rows.forEach((r) => { byTenant[r.tenantId] = (byTenant[r.tenantId] || 0) + 1; });
    console.log('--- by tenant:', byTenant);
    await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
