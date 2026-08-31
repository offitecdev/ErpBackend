/* Wer sieht welchen Termin? Spiegelt die OR-Bedingung aus meeting.routes.ts. */
import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';
import { getMailTenantId } from '../src/presentation/controllers/serviceTenantScope';
import { currentMailboxIdentity } from '../src/infrastructure/services/mailboxIdentity';

const where = (tenantId: string, mailTenantId: string, mailbox: string, employeeId: string) => ({
    OR: [
        { tenantId, externalOrigin: null },
        { NOT: { externalOrigin: null }, participants: { some: { employeeId } } },
        ...(mailbox ? [{
            tenantId: mailTenantId,
            externalMailbox: mailbox,
            NOT: { externalOrigin: null },
            participants: { none: { participantType: 'EMPLOYEE' } },
        }] : []),
    ],
});

(async () => {
    const people = await prisma.employee.findMany({
        where: { isActive: true, deletedAt: null, email: { in: ['sahin@offitec.ch', 'mb@offitec.ch', 'mak@offitec.eu', 'admin@offitec.com', 'teknisyen-tr@offitec.com'] } },
        select: { id: true, email: true, tenantId: true, firstName: true, lastName: true },
    });
    for (const person of people) {
        const mailTenantId = await getMailTenantId(person.tenantId).catch(() => person.tenantId);
        const mailbox = await currentMailboxIdentity(person.tenantId).catch(() => '');
        const rows = await (prisma as any).meetingActivity.findMany({
            where: where(person.tenantId, mailTenantId, mailbox, person.id),
            select: { title: true, externalOrigin: true, externalMailbox: true, tenantId: true },
            orderBy: { startTime: 'asc' },
        });
        console.log(`\n${person.firstName} ${person.lastName} <${person.email}> — tenant ${person.tenantId} | mail-tenant ${mailTenantId} | box ${mailbox || '(keins)'}`);
        for (const row of rows) {
            console.log('   ', row.externalOrigin ? `[aussen ${row.externalOrigin}]` : '[intern]', row.title);
        }
        if (!rows.length) console.log('    (nichts)');
    }
    await prisma.$disconnect();
})();
