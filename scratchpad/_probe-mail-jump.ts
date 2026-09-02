import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';

const BASE = 'http://localhost:3000/api/v1';

/* Oeffnet der Klick auf eine Mail in der Zeitleiste wirklich GENAU diese
   Nachricht? Geprueft wird der Weg, den die Oberflaeche geht: /crm/mail?id=…
   laedt die Nachricht ueber /mail/messages/:id. */
(async () => {
    const roles = await prisma.role.findMany({ select: { id: true, permissions: { select: { permission: { select: { permissionName: true } } } } } });
    const okRoleIds = roles.filter((r) => r.permissions.map((p) => p.permission.permissionName).includes('crm.customers.view')).map((r) => r.id);
    const admin = await prisma.employee.findFirst({
        where: { deletedAt: null, bannedAt: null, isActive: true, employeeRoles: { some: { roleId: { in: okRoleIds } } } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    if (!admin) throw new Error('kein Konto');
    const token = jwtTokenService.generateToken('access', { id: admin.id, tenantId: admin.tenantId, email: admin.email, pwdAt: toPwdAtClaim(admin.passwordChangedAt) } as any);
    const H = { Authorization: `Bearer ${token}` };

    const list = await fetch(`${BASE}/crm/activities?kind=MAIL&pageSize=8`, { headers: H }).then((r) => r.json());
    console.log('Kundenpost in der Zeitleiste:', list.total);
    let incoming = 0;
    for (const row of list.data) {
        const response = await fetch(`${BASE}/mail/messages/${row.id}`, { headers: H });
        const detail: any = await response.json();
        const same = detail?.id === row.id;
        if (row.statusText === 'IN') incoming += 1;
        console.log(same ? 'OK   ' : 'FEHLT', `[${response.status}]`, row.statusText, '|', String(row.title).slice(0, 34),
            '| Kunde', detail?.customer?.companyName ?? '—', '| Ordner', detail?.deleted ? 'Papierkorb' : detail?.direction === 'OUT' ? 'Ausgang' : 'Eingang');
    }
    console.log('davon eingehend:', incoming, 'von', list.data.length);
    await prisma.$disconnect();
})().catch(async (e) => { console.error('FEHLER', e); await prisma.$disconnect(); process.exit(1); });
