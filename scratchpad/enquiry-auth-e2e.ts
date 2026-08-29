import { nanoid } from 'nanoid';
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';

/* DIE ANGEMELDETEN WEGE der Anfragen + die Aktivitaeten-Zeitleiste, gegen den
   laufenden Server. Das Zugangsmerkmal wird mit dem EIGENEN Dienst des Servers
   ausgestellt (Bearer, wie die Swagger-Oberflaeche) — kein Kennwort wird
   angefasst oder geaendert. Es laeuft nach Minuten von selbst ab. */

const BASE = 'http://localhost:3000/api/v1';

(async () => {
    /* Ein Konto, dessen Rolle die CRM-Rechte wirklich traegt — sonst prueft der
       Lauf nur die Rechtesperre und nicht die Wege dahinter. */
    const roles = await prisma.role.findMany({
        select: { id: true, roleName: true, permissions: { select: { permission: { select: { permissionName: true } } } } },
    });
    const okRoleIds = roles
        .filter((role) => {
            const names = role.permissions.map((row) => row.permission.permissionName);
            return names.includes('crm.customers.view')
                && names.includes('crm.activities.create')
                && names.includes('crm.customers.create');
        })
        .map((role) => role.id);
    const admin = await prisma.employee.findFirst({
        where: { deletedAt: null, bannedAt: null, isActive: true, employeeRoles: { some: { roleId: { in: okRoleIds } } } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    if (!admin) throw new Error('kein Konto mit CRM-Rechten');

    const token = jwtTokenService.generateToken('access', {
        id: admin.id, tenantId: admin.tenantId, email: admin.email,
        pwdAt: toPwdAtClaim(admin.passwordChangedAt),
    } as any);
    const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    console.log('Als:', admin.email);

    const call = async (label: string, path: string, init?: RequestInit) => {
        const response = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init?.headers || {}) } });
        const text = await response.text();
        let body: any = text;
        try { body = JSON.parse(text); } catch { /* Text bleibt Text */ }
        console.log(`${label} [${response.status}]`,
            typeof body === 'object' ? JSON.stringify(body).slice(0, 240) : String(body).slice(0, 160));
        return { status: response.status, body };
    };

    // 1. Formular
    const form = await call('GET  /enquiries/form  ', '/enquiries/form');

    // 2. Anlegen
    const subject = 'AUTH ' + nanoid(6);
    const created = await call('POST /enquiries       ', '/enquiries', {
        method: 'POST',
        body: JSON.stringify({
            subject, companyName: 'Auth Test GmbH', contactName: 'Nina Nef',
            email: `nina-${nanoid(5)}@auth.example`, phone: '079 000 00 00',
            message: 'Am Telefon erfasst.',
        }),
    });
    const id = created.body?.id;
    if (!id) throw new Error('nicht angelegt');

    // 3. Lesen, Liste, Zaehler
    await call('GET  /enquiries/:id   ', `/enquiries/${id}`);
    await call('GET  /enquiries       ', '/enquiries?pageSize=3');
    await call('GET  ?status=NEW      ', '/enquiries?status=NEW&pageSize=2');
    await call('GET  ?status=OPEN     ', '/enquiries?status=OPEN&pageSize=2');
    await call('GET  ?search=         ', `/enquiries?search=${encodeURIComponent(subject)}`);
    await call('GET  /enquiries/stats ', '/enquiries/stats');

    // 4. Stand aendern -> answeredAt muss gesetzt werden
    const answered = await call('PATCH status ANSWERED ', `/enquiries/${id}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'ANSWERED' }),
    });
    console.log('   answeredAt gesetzt?', Boolean(answered.body?.answeredAt), '| closedAt leer?', answered.body?.closedAt === null);

    const back = await call('PATCH status NEW      ', `/enquiries/${id}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'NEW' }),
    });
    console.log('   answeredAt geraeumt?', back.body?.answeredAt === null);

    // 5. Betreff darf nicht leer werden
    await call('PATCH leerer Betreff  ', `/enquiries/${id}`, {
        method: 'PATCH', body: JSON.stringify({ subject: '   ' }),
    });

    // 6. Zum Kunden machen
    const converted = await call('POST /:id/convert     ', `/enquiries/${id}/convert`, { method: 'POST' });
    const customerId = converted.body?.customer?.id;
    console.log('   Anfrage jetzt:', converted.body?.enquiry?.status, '| Kunde:', converted.body?.customer?.companyName);

    // 7. Zweimal umwandeln -> 409
    await call('POST convert nochmal  ', `/enquiries/${id}/convert`, { method: 'POST' });

    // 8. Aktivitaeten
    await call('GET  /crm/activities  ', '/crm/activities?pageSize=3');
    await call('GET  ?kind=ENQUIRY    ', '/crm/activities?kind=ENQUIRY&pageSize=2');
    await call('GET  activities/stats ', '/crm/activities/stats');

    // 9. Aufraeumen
    await call('DELETE /enquiries/:id ', `/enquiries/${id}`, { method: 'DELETE' });
    if (customerId) await prisma.customer.delete({ where: { id: customerId } }).catch(() => undefined);
    console.log('aufgeraeumt. Formular-Token unveraendert:', form.body?.token === (await prisma.enquiryForm.findUnique({ where: { tenantId: admin.tenantId } }))?.token);

    await prisma.$disconnect();
})().catch(async (error) => {
    console.error('FEHLER:', error);
    await prisma.$disconnect();
    process.exit(1);
});
