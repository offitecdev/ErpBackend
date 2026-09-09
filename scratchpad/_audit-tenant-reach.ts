/* READ-ONLY: Firmenbaum + Reichweite der Administratorkonten. */
import prisma from '../src/infrastructure/database/prisma.client';

(async () => {
    const tenants = await prisma.tenant.findMany({
        select: { id: true, tenantName: true, parentTenantId: true, isActive: true },
    });
    const byId = new Map(tenants.map((t) => [t.id, t]));
    const rootOf = (id: string): string => {
        let cur = byId.get(id);
        for (let d = 0; cur?.parentTenantId && d < 20; d += 1) cur = byId.get(cur.parentTenantId);
        return cur?.id ?? id;
    };
    console.log('=== TENANTS ===');
    for (const t of tenants) {
        console.log(`${t.id}  parent=${t.parentTenantId ?? '-'}  root=${rootOf(t.id)}  active=${t.isActive}  ${t.tenantName}`);
    }
    const roots = [...new Set(tenants.filter((t) => t.isActive).map((t) => rootOf(t.id)))];
    console.log(`\nactive tenants=${tenants.filter((t) => t.isActive).length}  distinct roots=${roots.length}`);

    console.log('\n=== PEOPLE WITH roles.manage / admin role ===');
    const admins = await prisma.employee.findMany({
        where: {
            deletedAt: null,
            employeeRoles: { some: { role: { OR: [{ isSystemAdmin: true }, { permissions: { some: { permission: { permissionName: 'roles.manage' } } } }] } } },
        },
        select: { id: true, email: true, tenantId: true, allowedTenantIds: true, isActive: true,
                  employeeRoles: { select: { role: { select: { roleName: true, isSystemAdmin: true, canSwitchTenant: true } } } } },
    });
    for (const a of admins) {
        const assigned = Array.isArray(a.allowedTenantIds) ? (a.allowedTenantIds as string[]) : null;
        const reachRoots = new Set([rootOf(a.tenantId), ...(assigned ?? []).map(rootOf)]);
        console.log(`${a.email}  active=${a.isActive}  home=${byId.get(a.tenantId)?.tenantName ?? a.tenantId} (root ${rootOf(a.tenantId)})`);
        console.log(`   role=${a.employeeRoles.map((r) => `${r.role.roleName}[admin=${r.role.isSystemAdmin},switch=${r.role.canSwitchTenant}]`).join(',')}`);
        console.log(`   assigned=${JSON.stringify(assigned)}  -> reaches roots: ${[...reachRoots].join(', ')}`);
    }

    console.log('\n=== employees whose allowedTenantIds cross their home root ===');
    const all = await prisma.employee.findMany({
        where: { deletedAt: null },
        select: { id: true, email: true, tenantId: true, allowedTenantIds: true },
    });
    let crossing = 0;
    for (const e of all) {
        const assigned = Array.isArray(e.allowedTenantIds) ? (e.allowedTenantIds as string[]) : null;
        if (!assigned?.length) continue;
        const foreign = assigned.filter((id) => rootOf(id) !== rootOf(e.tenantId));
        if (foreign.length) {
            crossing += 1;
            console.log(`${e.email}  home root=${rootOf(e.tenantId)}  foreign=${foreign.map((id) => byId.get(id)?.tenantName ?? id).join(', ')}`);
        }
    }
    console.log(`total crossing = ${crossing} of ${all.length}`);
    await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
