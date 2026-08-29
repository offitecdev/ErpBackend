import dotenv from 'dotenv';
dotenv.config();

import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import prisma from '../src/infrastructure/database/prisma.client';

/* Rauchprobe fuer den SCHNELLWEG des Umterminierens (11.09.2026): eine
   Anweisung, die Rechtepruefung im WHERE, und seit heute auch startAt und
   allDay in ihren SET-Spalten. Sie ist roh und darum nicht typgeprueft. */
(async () => {
    const tenant = await prisma.tenant.findFirst({ select: { id: true } });
    const employee = await prisma.employee.findFirst({ select: { id: true } });
    if (!tenant || !employee) throw new Error('kein Mandant/keine Person');

    const id = nanoid(12);
    await prisma.crmTask.create({
        data: {
            id, tenantId: tenant.id, kind: 'TASK', title: 'Rauchprobe Schnellweg',
            createdByEmployeeId: employee.id,
            assignees: { create: [{ id: nanoid(12), employeeId: employee.id }] },
        },
    });

    const startAt = new Date();
    const dueDate = new Date(startAt.getTime() + 2 * 86400000);
    const sets: Prisma.Sql[] = [
        Prisma.sql`tk.updatedAt = NOW(3)`,
        Prisma.sql`tk.startAt = ${startAt}`,
        Prisma.sql`tk.dueDate = ${dueDate}`,
        Prisma.sql`tk.allDay = ${false}`,
    ];
    const affected = await prisma.$executeRaw(Prisma.sql`
        UPDATE CrmTask tk
           SET ${Prisma.join(sets, ', ')}
         WHERE tk.id = ${id}
           AND tk.tenantId = ${tenant.id}
           AND (tk.createdByEmployeeId = ${employee.id}
                OR tk.assigneeEmployeeId = ${employee.id}
                OR EXISTS (SELECT 1 FROM CrmTaskAssignee ta WHERE ta.taskId = tk.id AND ta.employeeId = ${employee.id}))
    `);
    console.log('Schnellweg getroffene Zeilen (soll 1):', affected);

    const saved = await prisma.crmTask.findUnique({ where: { id }, select: { startAt: true, dueDate: true, allDay: true } });
    console.log('gespeichert:', saved?.startAt?.toISOString(), '→', saved?.dueDate?.toISOString(), '· ganztägig:', saved?.allDay);

    // Eine FREMDE Person darf ihn nicht treffen.
    const stranger = await prisma.$executeRaw(Prisma.sql`
        UPDATE CrmTask tk SET tk.allDay = 1
         WHERE tk.id = ${id} AND tk.tenantId = ${tenant.id}
           AND (tk.createdByEmployeeId = 'nobody'
                OR tk.assigneeEmployeeId = 'nobody'
                OR EXISTS (SELECT 1 FROM CrmTaskAssignee ta WHERE ta.taskId = tk.id AND ta.employeeId = 'nobody'))
    `);
    console.log('Fremde getroffene Zeilen (soll 0):', stranger);

    await prisma.crmTask.delete({ where: { id } });
    console.log('OK');
    await prisma.$disconnect();
})().catch(async (error) => {
    console.error('FEHLER:', error);
    await prisma.$disconnect();
    process.exit(1);
});
