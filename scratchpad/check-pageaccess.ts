import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';

/* Was traegt die Rolle dieses Kontos wirklich an Seitenstufen? Der Menuepunkt
   und der Seitenwaechter lesen genau diese Karte. */

(async () => {
    const roles = await prisma.role.findMany({
        select: { id: true, permissions: { select: { permission: { select: { permissionName: true } } } } },
    });
    const okRoleIds = roles.filter((role) => {
        const names = role.permissions.map((row) => row.permission.permissionName);
        return names.includes('crm.customers.view') && names.includes('crm.activities.create');
    }).map((role) => role.id);
    const user = await prisma.employee.findFirst({
        where: { deletedAt: null, bannedAt: null, isActive: true, employeeRoles: { some: { roleId: { in: okRoleIds } } } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    if (!user) throw new Error('kein Konto');
    const token = jwtTokenService.generateToken('access', {
        id: user.id, tenantId: user.tenantId, email: user.email, pwdAt: toPwdAtClaim(user.passwordChangedAt),
    } as any);

    const res = await fetch('http://localhost:3000/api/v1/auth/me/permissions', {
        headers: { Authorization: `Bearer ${token}` },
    });
    const body: any = await res.json();
    console.log('Konto:', user.email, '| Status', res.status);
    console.log('isSystemAdmin:', body.isSystemAdmin);
    console.log('Rechte:', (body.permissions || []).length);
    const access = body.pageAccess || {};
    const keys = Object.keys(access);
    console.log('pageAccess-Zeilen:', keys.length);
    for (const key of keys.filter((k) => k.startsWith('crm.'))) console.log('   ', key, '=', access[key]);
    console.log('crm.enquiries  ->', access['crm.enquiries'] ?? '(fehlt)');
    console.log('crm.activities ->', access['crm.activities'] ?? '(fehlt)');
    await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
