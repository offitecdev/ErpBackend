import crypto from 'crypto';
import prisma from '../src/infrastructure/database/prisma.client';
(async () => {
    const rows = await prisma.enquiryForm.findMany({ select: { id: true, tenantId: true, token: true } });
    for (const row of rows) {
        if (!row.token.startsWith('smoke-')) { console.log('ok  ', row.tenantId, row.token.slice(0, 10) + '…'); continue; }
        const token = crypto.randomBytes(24).toString('base64url');
        await prisma.enquiryForm.update({ where: { id: row.id }, data: { token } });
        console.log('neu ', row.tenantId, token.slice(0, 10) + '…');
    }
    await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
