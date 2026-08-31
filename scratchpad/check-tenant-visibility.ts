/* Diagnose 31.08.2026: warum sieht ein Konto NICHT alle Firmen? Nur LESEND. */
import { Prisma } from '@prisma/client';
import prisma from '../src/infrastructure/database/prisma.client';

(async () => {
    const tenants = await prisma.$queryRaw<Array<any>>(Prisma.sql`
        SELECT id, tenantName, parentTenantId, isActive, companyNumber FROM Tenant ORDER BY tenantName
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

    console.log('— DER FIRMENBAUM —');
    for (const t of tenants) {
        console.log(`  ${t.tenantName.padEnd(32)} id=${String(t.id).padEnd(14)} parent=${String(t.parentTenantId ?? 'KEINER (eigener Stamm)').padEnd(24)} aktiv=${t.isActive} wurzel=${rootOf(t.id)}`);
    }
    const roots = [...new Set(tenants.map((t) => rootOf(t.id)))];
    console.log(`\n  => ${roots.length} getrennte Firmengruppe(n): ${roots.map((r) => byId.get(r!)?.tenantName).join('  ||  ')}`);

    console.log('\n— ROLLEN MIT FIRMENWECHSEL —');
    const roles = await prisma.$queryRaw<Array<any>>(Prisma.sql`
        SELECT r.id, r.roleName, r.tenantId, r.isSystemAdmin, r.canSwitchTenant,
               (SELECT COUNT(*) FROM EmployeeRole er WHERE er.roleId = r.id) AS holders
        FROM Role r ORDER BY r.roleName
    `);
    for (const r of roles) {
        const flag = r.isSystemAdmin ? 'ADMIN (immer)' : (r.canSwitchTenant ? 'ja' : '—');
        if (r.isSystemAdmin || r.canSwitchTenant || /admin|projek|proje|manager|yönet|yonet/i.test(r.roleName)) {
            console.log(`  ${r.roleName.padEnd(24)} id=${String(r.id).padEnd(22)} firma=${String(r.tenantId).padEnd(14)} traeger=${r.holders}  firmenwechsel=${flag}`);
        }
    }

    console.log('\n— KONTEN MIT EINER SOLCHEN ROLLE —');
    const staff = await prisma.$queryRaw<Array<any>>(Prisma.sql`
        SELECT e.id, e.firstName, e.lastName, e.email, e.tenantId, e.allowedTenantIds,
               r.roleName, r.isSystemAdmin, r.canSwitchTenant
        FROM Employee e
        LEFT JOIN EmployeeRole er ON er.employeeId = e.id
        LEFT JOIN Role r ON r.id = er.roleId
        WHERE e.deletedAt IS NULL AND e.isActive = 1
        ORDER BY e.firstName
    `);
    for (const s of staff) {
        const reaches = Boolean(s.isSystemAdmin) || Boolean(s.canSwitchTenant);
        const home = byId.get(s.tenantId);
        const inTree = tenants.filter((t) => t.isActive && rootOf(t.id) === rootOf(s.tenantId));
        console.log(
            `  ${String(s.email).padEnd(34)} rolle=${String(s.roleName ?? '—').padEnd(18)} `
            + `heim=${String(home?.tenantName ?? s.tenantId).padEnd(30)} ganzerBaum=${reaches ? 'JA ' : 'nein'} `
            + `sieht=${reaches ? inTree.length : ((Array.isArray(s.allowedTenantIds) ? s.allowedTenantIds.length : 0) || 1)} von ${tenants.filter((t) => t.isActive).length}`,
        );
    }

    await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
