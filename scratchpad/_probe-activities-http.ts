import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';

const BASE = 'http://localhost:3000/api/v1';

(async () => {
    const roles = await prisma.role.findMany({
        select: { id: true, permissions: { select: { permission: { select: { permissionName: true } } } } },
    });
    const okRoleIds = roles
        .filter((role) => role.permissions.map((r) => r.permission.permissionName).includes('crm.customers.view'))
        .map((role) => role.id);
    const admin = await prisma.employee.findFirst({
        where: { deletedAt: null, bannedAt: null, isActive: true, employeeRoles: { some: { roleId: { in: okRoleIds } } } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    if (!admin) throw new Error('kein Konto mit CRM-Rechten');
    const token = jwtTokenService.generateToken('access', {
        id: admin.id, tenantId: admin.tenantId, email: admin.email, pwdAt: toPwdAtClaim(admin.passwordChangedAt),
    } as any);
    const H = { Authorization: `Bearer ${token}` };
    console.log('Als:', admin.email, '| Mandant', admin.tenantId);

    const call = async (label: string, path: string) => {
        const response = await fetch(`${BASE}${path}`, { headers: H });
        const body: any = await response.json().catch(() => ({}));
        if (Array.isArray(body?.data)) {
            console.log(`${label} [${response.status}] total=${body.total}`);
            for (const row of body.data.slice(0, 5)) {
                console.log('   ', row.kind, '|', String(row.title).slice(0, 42), '| Kunde:', row.customer?.companyName ?? '—', '| link', row.linkId, '|', row.occurredAt);
            }
        } else {
            console.log(`${label} [${response.status}]`, JSON.stringify(body).slice(0, 400));
        }
        return body;
    };

    await call('stats        ', '/crm/activities/stats');
    await call('alle         ', '/crm/activities?pageSize=5');
    await call('kind=MAIL    ', '/crm/activities?kind=MAIL&pageSize=5');
    await call('kind=MEETING ', '/crm/activities?kind=MEETING&pageSize=5');
    await call('suche mail   ', '/crm/activities?kind=MAIL&search=a&pageSize=3');
    await call('suche meeting', '/crm/activities?kind=MEETING&search=a&pageSize=3');
    await prisma.$disconnect();
})().catch(async (e) => { console.error('FEHLER', e); await prisma.$disconnect(); process.exit(1); });
