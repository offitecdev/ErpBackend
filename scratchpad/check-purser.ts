/* Rauchtest 27.08.2026: die neuen SQL-Wege des Purser-Umbaus gegen die echte
   Datenbank — Spalte isPurser, roleName-Unterabfrage der Personalliste,
   Purser-Zählung und die Freigeber-Abfrage. Nur LESEND. */
import { Prisma } from '@prisma/client';
import prisma from '../src/infrastructure/database/prisma.client';

const APPROVER_PERMISSIONS = ['leaves.approve', 'roles.manage', 'users.manage'];

(async () => {
    const roles = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT id, roleName, isSystemAdmin, isPurser FROM Role LIMIT 5
    `);
    console.log('roles sample:', roles.map((r) => `${r.roleName} admin=${r.isSystemAdmin} purser=${r.isPurser}`));

    const staff = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT e.id, e.firstName, e.lastName,
               (
                   SELECT r.roleName FROM EmployeeRole er JOIN Role r ON r.id = er.roleId
                   WHERE er.employeeId = e.id LIMIT 1
               ) AS roleName
        FROM Employee e WHERE e.deletedAt IS NULL LIMIT 5
    `);
    console.log('staff sample:', staff.map((s) => `${s.firstName} ${s.lastName} -> ${s.roleName}`));

    const pursers = await prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
        SELECT COUNT(DISTINCT e.id) AS total
        FROM Employee e
        JOIN EmployeeRole er ON er.employeeId = e.id
        JOIN Role r ON r.id = er.roleId
        WHERE e.deletedAt IS NULL AND e.isActive = 1 AND r.isPurser = 1
    `);
    console.log('purser holders:', Number(pursers[0]?.total ?? 0));

    const approvers = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT e.id, e.firstName, e.lastName, e.staffNumber
        FROM Employee e
        WHERE e.deletedAt IS NULL AND e.isActive = 1
          AND EXISTS (
                SELECT 1 FROM EmployeeRole er
                JOIN RolePermission rp ON rp.roleId = er.roleId
                JOIN Permission p ON p.id = rp.permissionId
                WHERE er.employeeId = e.id
                  AND p.permissionName IN (${Prisma.join(APPROVER_PERMISSIONS)})
          )
        ORDER BY e.firstName ASC LIMIT 10
    `);
    console.log('approver pool:', approvers.map((a) => `${a.firstName} ${a.lastName} #${a.staffNumber}`));

    await prisma.$disconnect();
})().catch((error) => { console.error('FAILED:', error?.message || error); process.exit(1); });
