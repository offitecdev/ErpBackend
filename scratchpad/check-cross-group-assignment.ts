/* E2E 31.08.2026 — «Eine Auswahl muss getroffen werden, sie muss angegeben
   werden»: die Zugangsflaeche fuehrt JEDE Firma (Untergesellschaft oder eigene
   Gruppe), und ein ausdruecklicher Haken oeffnet sie wirklich.

   Der Lauf haengt einer Testperson kurz eine Firma der ZWEITEN Gruppe an und
   setzt ihre Zuteilung am Ende auf den vorgefundenen Wert zurueck — auch bei
   einem Abbruch. Kein Kennwort wird angefasst. */
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';
import { requireAuth } from '../src/presentation/middlewares/AuthMiddleware';
import { clearTenantSwitchAccessCache } from '../src/shared/tenantSwitchAccess';
import { clearAuthIdentityCache } from '../src/shared/authIdentityCache';
import { invalidateTenantTree } from '../src/shared/tenantTree';

const BASE = 'http://localhost:3000/api/v1';

const tokenFor = async (employeeId: string) => {
    const person = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    if (!person) throw new Error('Konto nicht gefunden: ' + employeeId);
    return jwtTokenService.generateToken('access', {
        id: person.id, tenantId: person.tenantId, email: person.email,
        pwdAt: toPwdAtClaim(person.passwordChangedAt),
    } as any);
};

const offered = async (token: string): Promise<string> => {
    const response = await fetch(`${BASE}/tenants`, { headers: { Authorization: `Bearer ${token}` } });
    const body: any = await response.json();
    if (!response.ok) throw new Error(`GET /tenants ${response.status} ${JSON.stringify(body)}`);
    return (body.tenants ?? []).map((t: any) => t.tenantName).join(' | ');
};

const servedTenant = async (token: string, requestedTenantId: string): Promise<string> => {
    clearTenantSwitchAccessCache();
    clearAuthIdentityCache();
    invalidateTenantTree();
    const req: any = {
        headers: { authorization: `Bearer ${token}` },
        method: 'GET',
        cookies: {},
        header: (name: string) => (name.toLowerCase() === 'x-tenant-id' ? requestedTenantId : undefined),
    };
    let failure = '';
    const res: any = {
        status: (code: number) => ({ json: (body: any) => { failure = `[${code}] ${body?.error ?? ''}`; } }),
        cookie: () => {}, clearCookie: () => {},
    };
    await new Promise<void>((resolve) => { void requireAuth(req, res, () => resolve()).then(() => resolve()); });
    if (failure) return `ABGELEHNT ${failure}`;
    return req.user?.tenantId ?? '(kein req.user)';
};

(async () => {
    const admin = await prisma.employee.findFirst({
        where: { deletedAt: null, isActive: true, employeeRoles: { some: { role: { isSystemAdmin: true } } } },
        select: { id: true, email: true },
    });
    if (!admin) throw new Error('keine Person mit Administratorrolle');
    const adminToken = await tokenFor(admin.id);

    const subject = await prisma.employee.findFirst({
        where: { email: 'sahin@offitec.ch', deletedAt: null },
        select: { id: true, email: true, tenantId: true, allowedTenantIds: true },
    });
    if (!subject) throw new Error('Testperson sahin@offitec.ch nicht gefunden');

    const tenants = await prisma.tenant.findMany({
        where: { isActive: true },
        select: { id: true, tenantName: true, parentTenantId: true },
    });
    const byId = new Map(tenants.map((t) => [t.id, t]));
    const rootOf = (id: string): string => {
        let cur = byId.get(id)!;
        for (let d = 0; cur?.parentTenantId && d < 20; d += 1) cur = byId.get(cur.parentTenantId)!;
        return cur?.id ?? id;
    };
    const otherGroup = tenants.find((t) => rootOf(t.id) !== rootOf(subject.tenantId));
    if (!otherGroup) throw new Error('keine zweite Firmengruppe vorhanden');

    console.log(`Verwaltung : ${admin.email}`);
    console.log(`Testperson : ${subject.email} (heim ${subject.tenantId}, Zuteilung ${JSON.stringify(subject.allowedTenantIds)})`);
    console.log(`Zweite Gruppe: ${otherGroup.tenantName} (${otherGroup.id})\n`);

    const original = Array.isArray(subject.allowedTenantIds) ? (subject.allowedTenantIds as string[]) : null;
    let restored = false;

    try {
        // 1. Was bietet die Zugangsflaeche ueberhaupt an?
        const accessResponse = await fetch(`${BASE}/employees/${subject.id}/authorization`, {
            headers: { Authorization: `Bearer ${adminToken}` },
        });
        const access: any = await accessResponse.json();
        if (!accessResponse.ok) throw new Error(`GET authorization ${accessResponse.status} ${JSON.stringify(access)}`);
        console.log('1) Zugangsflaeche bietet an:', access.companies.map((c: any) => c.tenantName).join(' | '));
        console.log(`   => ${access.companies.length} von ${tenants.length} aktiven Firmen`);
        const role = access.roles.find((r: any) => r.id === access.roleId);
        console.log(`   Rolle "${role?.roleName}" canSwitchTenant=${role?.canSwitchTenant}`);

        console.log('\n2) VORHER');
        console.log('   Umschalter ->', await offered(await tokenFor(subject.id)));
        console.log(`   verlangt ${otherGroup.tenantName} -> ${await servedTenant(await tokenFor(subject.id), otherGroup.id)}`);

        // 2. Die zweite Gruppe ausdruecklich anhaken.
        console.log(`\n3) ${otherGroup.tenantName} ausdruecklich zuteilen (ueber die API, als Verwaltung)`);
        const put = await fetch(`${BASE}/employees/${subject.id}/authorization`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ allowedTenantIds: [subject.tenantId, otherGroup.id] }),
        });
        const putBody: any = await put.json().catch(() => ({}));
        if (!put.ok) throw new Error(`PUT authorization ${put.status} ${JSON.stringify(putBody)}`);
        console.log('   Antwort:', JSON.stringify(putBody));

        const subjectToken = await tokenFor(subject.id);
        console.log('   Umschalter ->', await offered(subjectToken));
        console.log(`   verlangt ${otherGroup.tenantName} -> ${await servedTenant(subjectToken, otherGroup.id)}`);

        // 3. Zuruecknehmen.
        console.log('\n4) Zuteilung zuruecknehmen');
        const undo = await fetch(`${BASE}/employees/${subject.id}/authorization`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ allowedTenantIds: original ?? [] }),
        });
        if (!undo.ok) throw new Error(`PUT undo ${undo.status}`);
        restored = true;
        const back = await tokenFor(subject.id);
        console.log('   Umschalter ->', await offered(back));
        console.log(`   verlangt ${otherGroup.tenantName} -> ${await servedTenant(back, otherGroup.id)}`);
    } finally {
        if (!restored) {
            await prisma.employee.update({
                where: { id: subject.id },
                data: { allowedTenantIds: original ?? undefined } as any,
            });
            console.log('\n(Zuteilung direkt zurueckgesetzt)');
        }
        await prisma.$disconnect();
    }
})().catch(async (e) => { console.error('FEHLER:', e); await prisma.$disconnect(); process.exit(1); });
