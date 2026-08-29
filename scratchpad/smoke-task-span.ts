import dotenv from 'dotenv';
dotenv.config();

import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import prisma from '../src/infrastructure/database/prisma.client';

/* Rauchprobe für die Aufgaben-Erweiterung vom 11.09.2026: Anfang/Ende,
   Anleitung und Anhänge.

   Sie fährt die ROHEN Statements des Routers gegen die echte Datenbank —
   sie sind nicht typgeprüft, ein Tippfehler in einem Spaltennamen fiele sonst
   erst im Browser auf. Geprüft wird vor allem, was neu und heikel ist:

     · die Überschneidungsbedingung (COALESCE über startAt/dueDate)
     · die drei neuen Unterabfragen (Anhänge, Schritte, erledigte Schritte)
     · der LEFT JOIN auf Tender
     · die IN-Listen der Mehrfachfilter

   Legt eine mehrtägige Testaufgabe mit Schritten an und räumt sie wieder weg. */

const overlapSql = (from: Date, to: Date) => {
    const spanStart = Prisma.sql`COALESCE(tk.startAt, tk.dueDate)`;
    const spanEnd = Prisma.sql`COALESCE(tk.dueDate, tk.startAt)`;
    const undated = Prisma.sql`(tk.startAt IS NULL AND tk.dueDate IS NULL)`;
    return Prisma.sql`(${undated} OR (${spanStart} < ${to} AND ${spanEnd} >= ${from}))`;
};

(async () => {
    const tenant = await prisma.tenant.findFirst({ select: { id: true, tenantName: true } });
    if (!tenant) throw new Error('kein Mandant');
    const employee = await prisma.employee.findFirst({ where: { tenantId: tenant.id }, select: { id: true } })
        ?? await prisma.employee.findFirst({ select: { id: true } });
    if (!employee) throw new Error('keine Person');
    const tenantId = tenant.id;
    console.log('Mandant:', tenant.tenantName, tenantId);

    // ── 1. Eine MEHRTÄGIGE Aufgabe mit Anleitung anlegen ──────────────────
    const id = nanoid(12);
    const startAt = new Date();
    startAt.setHours(0, 0, 0, 0);
    const dueDate = new Date(startAt);
    dueDate.setDate(dueDate.getDate() + 3);
    dueDate.setHours(23, 59, 0, 0);

    await prisma.crmTask.create({
        data: {
            id,
            tenantId,
            kind: 'TASK',
            title: 'Rauchprobe mehrtägig',
            startAt,
            allDay: true,
            dueDate,
            createdByEmployeeId: employee.id,
            assignees: { create: [{ id: nanoid(12), employeeId: employee.id }] },
            steps: {
                create: [
                    { id: nanoid(12), position: 0, text: 'Erster Schritt', done: true },
                    { id: nanoid(12), position: 1, text: 'Zweiter Schritt', done: false },
                ],
            },
        },
    });
    console.log('Aufgabe angelegt:', id, startAt.toISOString(), '→', dueDate.toISOString());

    // ── 2. Ein Fenster, das NUR den ersten Tag enthält ────────────────────
    //     Vor der Umstellung wäre die Aufgabe hier unsichtbar gewesen: ihr
    //     Endtermin liegt drei Tage später.
    const windowFrom = new Date(startAt);
    const windowTo = new Date(startAt);
    windowTo.setDate(windowTo.getDate() + 1);

    const conditions: Prisma.Sql[] = [
        Prisma.sql`tk.tenantId = ${tenantId}`,
        Prisma.sql`tk.kind = 'TASK'`,
        overlapSql(windowFrom, windowTo),
        Prisma.sql`(tk.assigneeEmployeeId IN (${Prisma.join([employee.id])})
            OR EXISTS (SELECT 1 FROM CrmTaskAssignee ta WHERE ta.taskId = tk.id AND ta.employeeId IN (${Prisma.join([employee.id])})))`,
    ];
    const whereSql = Prisma.join(conditions, ' AND ');

    const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT tk.id, tk.kind, tk.title, tk.labelId, tk.customerId, tk.contactId, tk.assigneeEmployeeId,
               tk.startAt, tk.allDay, tk.dueDate, tk.status, tk.completedAt, tk.tenderId,
               tk.createdByEmployeeId, tk.createdAt,
               tk.linkUrl, tk.meta, tk.entityType, tk.entityId,
               cu.companyName AS customerName,
               ct.firstName AS contactFirstName, ct.lastName AS contactLastName,
               a.firstName AS assigneeFirstName, a.lastName AS assigneeLastName,
               e.firstName AS byFirstName, e.lastName AS byLastName,
               td.tenderNumber AS tenderNumber,
               (SELECT COUNT(*) FROM CrmTaskNote n WHERE n.taskId = tk.id) AS noteCount,
               (SELECT COUNT(*) FROM CrmTaskDocument d WHERE d.taskId = tk.id) AS documentCount,
               (SELECT COUNT(*) FROM CrmTaskStep st WHERE st.taskId = tk.id) AS stepCount,
               (SELECT COUNT(*) FROM CrmTaskStep st WHERE st.taskId = tk.id AND st.done = 1) AS stepDoneCount
        FROM CrmTask tk
        LEFT JOIN Customer cu ON cu.id = tk.customerId
        LEFT JOIN CustomerContact ct ON ct.id = tk.contactId
        LEFT JOIN Employee a ON a.id = tk.assigneeEmployeeId
        LEFT JOIN Tender td ON td.id = tk.tenderId
        JOIN Employee e ON e.id = tk.createdByEmployeeId
        WHERE ${whereSql}
        ORDER BY (COALESCE(tk.startAt, tk.dueDate) IS NULL) ASC, COALESCE(tk.startAt, tk.dueDate) ASC,
                 FIELD(tk.status, 'OPEN', 'INCOMPLETE', 'DONE') ASC,
                 tk.createdAt ASC, tk.id ASC
        LIMIT 25 OFFSET 0
    `);

    const found = rows.find((row) => row.id === id);
    console.log('Zeilen im Ein-Tages-Fenster:', rows.length);
    console.log('mehrtägige Aufgabe gefunden:', Boolean(found));
    if (found) {
        console.log('  Schritte:', Number(found.stepCount), 'davon erledigt:', Number(found.stepDoneCount));
        console.log('  Anhänge:', Number(found.documentCount), '· ganztägig:', Boolean(found.allDay));
    }

    // ── 3. Ein Fenster VOR der Aufgabe darf sie NICHT zeigen ──────────────
    const beforeFrom = new Date(startAt);
    beforeFrom.setDate(beforeFrom.getDate() - 10);
    const beforeTo = new Date(startAt);
    beforeTo.setDate(beforeTo.getDate() - 5);
    const outside = await prisma.$queryRaw<Array<{ n: bigint | number }>>(Prisma.sql`
        SELECT COUNT(*) AS n FROM CrmTask tk
        WHERE tk.id = ${id} AND ${overlapSql(beforeFrom, beforeTo)}
    `);
    console.log('im Fenster davor sichtbar (soll 0):', Number(outside[0]?.n ?? 0));

    // ── 4. Der Verfalldienst darf sie NICHT kippen (Ende in der Zukunft) ──
    const flipped = await prisma.$executeRaw(Prisma.sql`
        UPDATE CrmTask
           SET status = 'INCOMPLETE', updatedAt = NOW(3)
         WHERE kind = 'TASK' AND status = 'OPEN' AND dueDate IS NOT NULL
           AND DATE(dueDate) < CURDATE() AND id = ${id}
    `);
    console.log('vom Verfalldienst gekippt (soll 0):', flipped);

    // ── 5. Aufräumen: Schritte und Anhänge hängen per Cascade daran ───────
    await prisma.crmTask.delete({ where: { id } });
    const rest = await prisma.crmTaskStep.count({ where: { taskId: id } });
    console.log('Schritte nach dem Löschen (soll 0):', rest);
    console.log('OK');
    await prisma.$disconnect();
})().catch(async (error) => {
    console.error('FEHLER:', error);
    await prisma.$disconnect();
    process.exit(1);
});
