import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';
(async () => {
    const rows = await (prisma as any).meetingActivity.findMany({
        where: { NOT: { externalOrigin: null } },
        select: { title: true, startTime: true, externalOrganizer: true, ccEmails: true, externalMailbox: true, externalSource: true, icalUid: true, createdAt: true,
            createdBy: { select: { email: true } }, participants: { select: { participantType: true, employee: { select: { email: true } } } } },
        orderBy: { createdAt: 'desc' }, take: 3,
    });
    for (const r of rows) console.log(r.createdAt.toISOString().slice(0, 16), '|', r.title, '|', r.startTime.toISOString().slice(0, 16), '| org', r.externalOrganizer, '| cc', JSON.stringify(r.ccEmails), '| box', r.externalMailbox, '| uid', String(r.icalUid).slice(0, 40), '| Teilnehmer', r.participants.map((p: any) => p.employee?.email || p.participantType).join(','));
    const mails = await prisma.mailMessage.findMany({
        where: { OR: [{ subject: { contains: 'feegege' } }, { sentAt: { gte: new Date(Date.now() - 3 * 3600_000) } }] },
        select: { subject: true, direction: true, fromAddress: true, toRecipients: true, ccRecipients: true, attachments: true, sentAt: true },
        orderBy: { sentAt: 'desc' }, take: 8,
    });
    console.log('\nJüngste Mails (3 h):');
    for (const m of mails) console.log(' ', m.sentAt?.toISOString().slice(0, 16), m.direction, '|', m.subject, '| von', m.fromAddress, '| an', (m.toRecipients as any[] || []).map((p) => p.address).join(','), '| cc', (m.ccRecipients as any[] || []).map((p) => p.address).join(','), '|', JSON.stringify(m.attachments || []).slice(0, 100));
    await prisma.$disconnect();
})();
