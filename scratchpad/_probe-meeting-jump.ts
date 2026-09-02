import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';

const BASE = 'http://localhost:3000/api/v1';

/* Springt der Klick auf eine Besprechung in den Kalender ins LEERE? Die
   Zeitleiste und der Kalender muessen dieselbe Besprechung sehen — sonst
   oeffnet sich dort keine Karte. */
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

    const list = await fetch(`${BASE}/crm/activities?kind=MEETING&pageSize=20`, { headers: H }).then((r) => r.json());
    console.log('Besprechungen in der Zeitleiste:', list.total);
    for (const row of list.data) {
        // Der Kalender laedt die Woche um den Termin — genau das prueft der Sprung.
        const day = new Date(row.occurredAt);
        const start = new Date(day); start.setDate(day.getDate() - 3);
        const end = new Date(day); end.setDate(day.getDate() + 3);
        const meetings = await fetch(`${BASE}/meetings?start=${start.toISOString()}&end=${end.toISOString()}`, { headers: H }).then((r) => r.json());
        const hit = Array.isArray(meetings) && meetings.some((m: any) => m.id === row.id);
        console.log(hit ? 'OK  ' : 'FEHLT', row.id, '|', String(row.title).slice(0, 30), '|', row.occurredAt);
    }
    await prisma.$disconnect();
})().catch(async (e) => { console.error('FEHLER', e); await prisma.$disconnect(); process.exit(1); });
