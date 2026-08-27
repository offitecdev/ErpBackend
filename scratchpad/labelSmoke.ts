/* Rauchprobe der Kalender-Etiketten: anlegen, umbenennen, Rolle setzen,
   an einen Termin hängen, wieder löschen — über den ECHTEN HTTP-Weg, also
   samt Rechteprüfung, Mandantenfilter und Fremdschlüssel. */
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';
import { GetUserPermissionsUseCase } from '../src/application/use-cases/auth/GetUserPermissionsUseCase';
import { RoleRepository } from '../src/infrastructure/repositories/RoleRepository';

const BASE = 'http://localhost:3000/api/v1';

const call = async (method: string, path: string, token: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* leer */ }
    return { status: res.status, body: parsed };
};

(async () => {
    /* Jemand, der die Liste auch pflegen DARF -- die Rauchprobe soll die
       Rechtepruefung nicht umgehen, sondern durch sie hindurch. */
    const MANAGE = ['projects.manage', 'crm.activities.create', 'roles.manage', 'tenants.update'];
    const permissions = new GetUserPermissionsUseCase(new RoleRepository());
    const people = await prisma.employee.findMany({
        where: { email: { not: '' } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, tenantId: true, email: true, passwordChangedAt: true, firstName: true, lastName: true },
    });
    let admin: (typeof people)[number] | null = null;
    for (const person of people) {
        const list = await permissions.execute(person.id).catch(() => [] as string[]);
        if (list.some((name) => MANAGE.includes(name))) { admin = person; break; }
    }
    if (!admin) throw new Error('Niemand darf die Etiketten pflegen.');
    const token = jwtTokenService.generateToken('access', {
        id: admin.id, tenantId: admin.tenantId, email: admin.email, pwdAt: toPwdAtClaim(admin.passwordChangedAt),
    } as any);
    console.log('als', admin.firstName, admin.lastName, '| Mandant', admin.tenantId);

    console.log('1) leere Liste          ', await call('GET', '/calendar/labels', token));

    const created = await call('POST', '/calendar/labels', token, { name: 'Offener Termin', color: '#D93025', role: 'appointment' });
    console.log('2) anlegen              ', created);
    const id = created.body?.id;
    if (!id) { await prisma.$disconnect(); return; }

    console.log('3) doppelter Name -> 409', await call('POST', '/calendar/labels', token, { name: 'offener termin' }));
    console.log('4) Besprechung          ', await call('POST', '/calendar/labels', token, { name: 'Besprechung', color: '#8e24aa', role: 'MEETING' }));
    console.log('5) umbenennen + Rolle   ', await call('PATCH', `/calendar/labels/${id}`, token, { name: 'Offen', color: '#f6bf26', role: null }));
    console.log('6) kaputte Farbe -> 400 ', await call('PATCH', `/calendar/labels/${id}`, token, { color: 'rot' }));

    const appointment = await prisma.appointment.findFirst({ where: { tenantId: admin.tenantId }, select: { id: true } });
    if (appointment) {
        console.log('7) Etikett an Termin    ', (await call('GET', '/calendar/labels', token)).status);
        await prisma.appointment.update({ where: { id: appointment.id }, data: { labelId: id } });
        console.log('   benutzt -> 409       ', await call('DELETE', `/calendar/labels/${id}`, token));
        console.log('   mit force            ', await call('DELETE', `/calendar/labels/${id}?force=true`, token));
        const after = await prisma.appointment.findUnique({ where: { id: appointment.id }, select: { labelId: true } });
        console.log('   Termin danach        ', after, '(labelId muss null sein, der Termin selbst steht noch)');
    }

    const rest = await call('GET', '/calendar/labels', token);
    console.log('8) Liste am Ende        ', rest.body);
    for (const row of rest.body || []) await call('DELETE', `/calendar/labels/${row.id}?force=true`, token);
    console.log('9) aufgeraeumt          ', await call('GET', '/calendar/labels', token));

    await prisma.$disconnect();
})().catch(async (error) => { console.error(error); await prisma.$disconnect(); process.exit(1); });
