/* Bestandsaufnahme: wem gehören die übernommenen Termine? */
import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';

(async () => {
    const meetings = await (prisma as any).meetingActivity.findMany({
        select: {
            id: true, tenantId: true, title: true, startTime: true,
            externalOrigin: true, externalMailbox: true, externalSource: true,
            externalOrganizer: true, icalUid: true, createdByEmployeeId: true,
            createdBy: { select: { firstName: true, lastName: true, email: true } },
            participants: { select: { participantType: true, employeeId: true } },
        },
        orderBy: { startTime: 'desc' },
        take: 2000,
    });
    const external = meetings.filter((m: any) => m.externalOrigin);
    const own = meetings.filter((m: any) => !m.externalOrigin);
    const noEmpParticipant = external.filter((m: any) => !m.participants.some((p: any) => p.participantType === 'EMPLOYEE' && p.employeeId));
    console.log('MeetingActivity gesamt:', meetings.length, '| von aussen:', external.length, '| im System angelegt:', own.length);
    console.log('von aussen OHNE Personen-Teilnehmer:', noEmpParticipant.length);
    const bySource = new Map<string, number>();
    for (const m of external) bySource.set(m.externalSource || '(leer)', (bySource.get(m.externalSource || '(leer)') || 0) + 1);
    console.log('Quellen:', [...bySource.entries()]);
    const byOwner = new Map<string, number>();
    for (const m of external) {
        const key = m.createdBy ? `${m.createdBy.firstName} ${m.createdBy.lastName} <${m.createdBy.email}>` : '(kein Urheber)';
        byOwner.set(key, (byOwner.get(key) || 0) + 1);
    }
    console.log('Urheber der übernommenen Termine:');
    for (const [k, v] of [...byOwner.entries()].sort((a, b) => b[1] - a[1])) console.log('   ', v, k);
    console.log('\nBeispiele (10 neueste von aussen):');
    for (const m of external.slice(0, 10)) {
        console.log('  ', m.startTime?.toISOString?.().slice(0, 16), '|', String(m.title).slice(0, 46),
            '| tenant', m.tenantId, '| src', m.externalSource, '| box', m.externalMailbox,
            '| owner', m.createdBy?.email, '| emp-parts', m.participants.filter((p: any) => p.participantType === 'EMPLOYEE').length);
    }
    const [mails, calMails] = await Promise.all([
        prisma.mailMessage.count(),
        prisma.mailMessage.count({ where: { attachments: { not: Prisma_JsonNull() } } }).catch(() => -1),
    ]);
    console.log('\nMailMessage gesamt:', mails, '| mit Anhangsliste:', calMails);
    const settings = await prisma.mailSetting.findMany({ select: { tenantId: true, imapUser: true, imapInboxFolder: true, imapLastUid: true, imapSentLastUid: true, imapWindowMonths: true, imapLastSummary: true } });
    for (const s of settings) console.log('Postfach', s.tenantId, s.imapUser, '| Ordner', s.imapInboxFolder, '| lastUid', String(s.imapLastUid), '| sentUid', String(s.imapSentLastUid), '| Fenster', s.imapWindowMonths, 'Monate |', s.imapLastSummary);
    await prisma.$disconnect();
})();
