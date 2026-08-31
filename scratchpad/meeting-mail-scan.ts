import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';

(async () => {
    const employees = await prisma.employee.findMany({
        where: { isActive: true, deletedAt: null },
        select: { id: true, email: true, firstName: true, lastName: true, tenantId: true },
        orderBy: { createdAt: 'asc' },
    });
    console.log('Aktive Mitarbeitende:', employees.length);
    for (const e of employees) console.log('  ', e.tenantId, '|', e.email, '|', e.firstName, e.lastName);

    const mails = await prisma.mailMessage.findMany({
        select: { id: true, tenantId: true, subject: true, fromAddress: true, toRecipients: true, ccRecipients: true, direction: true, sentAt: true, attachments: true, hasAttachments: true },
        orderBy: { sentAt: 'desc' },
        take: 400,
    });
    const looksCalendar = (m: any) => {
        const s = JSON.stringify(m.attachments || []);
        return /calendar|\.ics/i.test(s) || /einladung|termin|meeting|besprechung|invitation|abgesagt|verschoben/i.test(String(m.subject || ''));
    };
    const cal = mails.filter(looksCalendar);
    console.log('\nMails gesamt (letzte 400):', mails.length, '| terminverdächtig:', cal.length);
    for (const m of cal.slice(0, 40)) {
        const to = (m.toRecipients as any[] || []).map((p: any) => p.address).join(',');
        const cc = (m.ccRecipients as any[] || []).map((p: any) => p.address).join(',');
        console.log('  ', m.sentAt?.toISOString?.().slice(0, 16), m.direction, '|', String(m.subject).slice(0, 50), '| von', m.fromAddress, '| an', to, cc ? `| cc ${cc}` : '', '|', JSON.stringify(m.attachments || []).slice(0, 90));
    }
    await prisma.$disconnect();
})();
