/* Rauchtest 31.08.2026 — der Firmenwechsel als Rollenrecht. Nur LESEND:
   die neue Spalte, die Abfrage aus shared/tenantSwitchAccess.ts und die Frage,
   welche Firmen der Umschalter jedem Konto jetzt anbietet. */
import { Prisma } from '@prisma/client';
import prisma from '../src/infrastructure/database/prisma.client';
import { mayReachWholeCompanyTree } from '../src/shared/tenantSwitchAccess';
import { parseAllowedTenantIds } from '../src/presentation/utils/tenantAccess';

(async () => {
    const roles = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT id, roleName, isSystemAdmin, isPurser, canSwitchTenant FROM Role ORDER BY roleName
    `);
    console.log('— Rollen —');
    for (const r of roles) {
        console.log(`  ${r.roleName.padEnd(24)} admin=${r.isSystemAdmin} purser=${r.isPurser} firmenwechsel=${r.canSwitchTenant}`);
    }

    const tenants = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT id, tenantName, parentTenantId, isActive FROM Tenant
    `);
    const byId = new Map(tenants.map((t) => [t.id, t]));
    const rootOf = (id: string): string | null => {
        let cur = byId.get(id);
        if (!cur) return null;
        for (let d = 0; cur.parentTenantId && d < 20; d += 1) {
            const p = byId.get(cur.parentTenantId);
            if (!p) return null;
            cur = p;
        }
        return cur.id;
    };
    console.log(`\n— Firmen — ${tenants.length} (aktiv: ${tenants.filter((t) => t.isActive).length})`);
    for (const t of tenants) console.log(`  ${t.tenantName} (${t.id}) aktiv=${t.isActive}`);

    const staff = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
        SELECT e.id, e.firstName, e.lastName, e.tenantId, e.allowedTenantIds,
               (SELECT r.roleName FROM EmployeeRole er JOIN Role r ON r.id = er.roleId
                WHERE er.employeeId = e.id LIMIT 1) AS roleName
        FROM Employee e
        WHERE e.deletedAt IS NULL AND e.isActive = 1
        ORDER BY e.firstName
    `);

    console.log('\n— Was der Umschalter jedem Konto anbietet —');
    for (const person of staff) {
        const reachesAll = await mayReachWholeCompanyTree(person.id);
        const homeRoot = rootOf(person.tenantId);
        const assigned = parseAllowedTenantIds(person.allowedTenantIds) ?? [];
        const inTree = tenants.filter((t) => t.isActive && rootOf(t.id) === homeRoot);
        const offered = reachesAll
            ? inTree
            : inTree.filter((t) => (assigned.length ? assigned : [person.tenantId]).includes(t.id));
        console.log(
            `  ${(person.firstName + ' ' + person.lastName).padEnd(26)} `
            + `rolle=${String(person.roleName ?? '—').padEnd(16)} `
            + `ganzerBaum=${reachesAll ? 'JA ' : 'nein'} `
            + `→ ${offered.map((t) => t.tenantName).join(', ') || '(nichts)'}`,
        );
    }

    await prisma.$disconnect();
})().catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
});
