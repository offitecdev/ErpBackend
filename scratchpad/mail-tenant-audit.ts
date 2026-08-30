import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';

(async () => {
    const tenants = await prisma.tenant.findMany({ select: { id: true, tenantName: true, parentTenantId: true, isActive: true } });
    console.log('=== TENANTS ===');
    for (const t of tenants) console.log(t.id, '|', t.tenantName, '| parent:', t.parentTenantId, '| active:', t.isActive);

    const msgs = await prisma.mailMessage.groupBy({ by: ['tenantId'], _count: { _all: true } });
    console.log('=== MailMessage by tenant ===', JSON.stringify(msgs));

    const cats = await prisma.mailCategory.groupBy({ by: ['tenantId'], _count: { _all: true } });
    console.log('=== MailCategory by tenant ===', JSON.stringify(cats));

    const settings = await prisma.mailSetting.findMany({ select: { tenantId: true, imapHost: true, imapUser: true, smtpHost: true, fromEmail: true, imapCaptureEnabled: true } });
    console.log('=== MailSetting ===');
    for (const s of settings) console.log(JSON.stringify(s));

    const cust = await prisma.customer.groupBy({ by: ['tenantId'], _count: { _all: true } });
    console.log('=== Customer by tenant ===', JSON.stringify(cust));
    const proj = await prisma.project.groupBy({ by: ['tenantId'], _count: { _all: true } });
    console.log('=== Project by tenant ===', JSON.stringify(proj));
    const emp = await prisma.employee.groupBy({ by: ['tenantId'], _count: { _all: true } });
    console.log('=== Employee by tenant ===', JSON.stringify(emp));
    await prisma.$disconnect();
})();
