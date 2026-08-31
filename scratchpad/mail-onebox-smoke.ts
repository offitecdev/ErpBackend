/* NUR-LESEN-Rundgang über die Postfachwege, angemeldet als eine Person aus
   `main-tenant` (Offitec GmbH) — die Firma, in der das Postfach zuletzt nur
   45 Nachrichten zeigte. Das Zugangsmerkmal stellt der Dienst des Servers
   selbst aus (wie enquiry-auth-e2e.ts); kein Kennwort wird angefasst. */
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
        .filter((role) => role.permissions.some((row) => row.permission.permissionName === 'crm.customers.view'))
        .map((role) => role.id);
    const user = await prisma.employee.findFirst({
        where: {
            tenantId: 'main-tenant', deletedAt: null, bannedAt: null, isActive: true,
            employeeRoles: { some: { roleId: { in: okRoleIds } } },
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    if (!user) throw new Error('kein Konto in main-tenant mit crm.customers.view');

    const token = jwtTokenService.generateToken('access', {
        id: user.id, tenantId: user.tenantId, email: user.email,
        pwdAt: toPwdAtClaim(user.passwordChangedAt),
    } as any);
    const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    console.log('Als:', user.email, '| Firma:', user.tenantId, '\n');

    const call = async (label: string, path: string) => {
        const response = await fetch(`${BASE}${path}`, { headers: H });
        const text = await response.text();
        let body: any = text;
        try { body = JSON.parse(text); } catch { /* Text bleibt Text */ }
        const shape = typeof body === 'object' && body
            ? (Array.isArray(body.data)
                ? `total=${body.total ?? '?'} auf dieser Seite=${body.data.length}`
                : JSON.stringify(body).slice(0, 200))
            : String(body).slice(0, 160);
        console.log(`${label} [${response.status}] ${shape}`);
    };

    await call('GET /mail/messages?inbox   ', '/mail/messages?folder=inbox&pageSize=3');
    await call('GET /mail/messages?sent    ', '/mail/messages?folder=sent&pageSize=3');
    await call('GET /mail/messages/stats   ', '/mail/messages/stats');
    await call('GET /mail/categories       ', '/mail/categories');
    await call('GET /mail/inbox/status     ', '/mail/inbox/status');
    await call('GET /mail/address-book     ', '/mail/address-book?limit=5');
    await call('GET /crm/interactions      ', '/crm/interactions?pageSize=3');
    await call('GET /crm/activities?MAIL   ', '/crm/activities?kind=MAIL&pageSize=3');
    await call('GET /crm/activities/stats  ', '/crm/activities/stats');

    await prisma.$disconnect();
})();
