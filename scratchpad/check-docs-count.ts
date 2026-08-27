import prisma from '../src/infrastructure/database/prisma.client';
(async () => {
    const rows: any = await (prisma as any).$queryRawUnsafe('SELECT COUNT(*) AS n FROM AppointmentDocument');
    console.log('AppointmentDocument rows:', Number(rows[0].n));
    process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
