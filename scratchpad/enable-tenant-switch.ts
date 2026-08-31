/* Vorgabe 31.08.2026: «admin und projektmanager» bekommen den Firmenwechsel.
   Gesetzt wird ueber die ECHTE API (als Administrator), damit die Rechte- und
   Reichweiten-Caches der laufenden Anwendung sofort mitgeleert werden — ein
   direkter Schreibzugriff auf die Tabelle wuerde bis zu 60 s alt bedient. */
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';

const BASE = 'http://localhost:3000/api/v1';
const WANTED = ['Admin', 'Projektmanager'];

(async () => {
    const admin = await prisma.employee.findFirst({
        where: { deletedAt: null, isActive: true, employeeRoles: { some: { role: { isSystemAdmin: true } } } },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    if (!admin) throw new Error('keine Person mit Administratorrolle');
    const token = jwtTokenService.generateToken('access', {
        id: admin.id, tenantId: admin.tenantId, email: admin.email,
        pwdAt: toPwdAtClaim(admin.passwordChangedAt),
    } as any);

    for (const roleName of WANTED) {
        const role = await prisma.role.findFirst({
            where: { roleName },
            select: { id: true, roleName: true, canSwitchTenant: true },
        });
        if (!role) { console.log(`  ${roleName}: nicht gefunden`); continue; }
        const response = await fetch(`${BASE}/role-templates/${role.id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ canSwitchTenant: true }),
        });
        const body: any = await response.json().catch(() => ({}));
        console.log(`  ${roleName.padEnd(16)} vorher=${role.canSwitchTenant} -> [${response.status}] ${JSON.stringify(body).slice(0, 160)}`);
    }

    console.log('\n— Kontrolle: was der Umschalter jetzt anbietet —');
    const holders = await prisma.employee.findMany({
        where: { deletedAt: null, isActive: true, employeeRoles: { some: { role: { OR: [{ isSystemAdmin: true }, { canSwitchTenant: true }] } } } },
        select: { id: true, email: true, passwordChangedAt: true, tenantId: true },
    });
    for (const person of holders) {
        const personToken = jwtTokenService.generateToken('access', {
            id: person.id, tenantId: person.tenantId, email: person.email,
            pwdAt: toPwdAtClaim(person.passwordChangedAt),
        } as any);
        const res = await fetch(`${BASE}/tenants`, { headers: { Authorization: `Bearer ${personToken}` } });
        const body: any = await res.json();
        console.log(`  ${person.email.padEnd(30)} -> ${(body.tenants ?? []).map((t: any) => t.tenantName).join(' | ')}`);
    }

    await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
