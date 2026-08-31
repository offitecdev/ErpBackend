/* E2E 31.08.2026 — der Firmenwechsel als Rollenrecht.
 *
 * Zwei Ebenen, weil beide zaehlen:
 *   HTTP        — GET /tenants ist die Liste, die der Umschalter im Kopf zeigt.
 *   im Prozess  — requireAuth selbst, mit gefaelschtem Request: nur so sieht
 *                 man, WELCHE Firma der Server bei einem x-tenant-id bedient
 *                 (keine Antwort traegt das nach aussen).
 *
 * Das Zugangsmerkmal stellt der EIGENE Dienst aus (Bearer, wie Swagger); kein
 * Kennwort wird angefasst. `Role.canSwitchTenant` wird kurz umgelegt und am
 * Ende auf den vorgefundenen Wert zurueckgesetzt — auch bei einem Abbruch. */
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';
import { requireAuth } from '../src/presentation/middlewares/AuthMiddleware';
import { clearTenantSwitchAccessCache } from '../src/shared/tenantSwitchAccess';
import { clearAuthIdentityCache } from '../src/shared/authIdentityCache';

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

const companiesOffered = async (token: string): Promise<string> => {
    const response = await fetch(`${BASE}/tenants`, { headers: { Authorization: `Bearer ${token}` } });
    const body: any = await response.json();
    if (!response.ok) throw new Error(`GET /tenants ${response.status} ${JSON.stringify(body)}`);
    return (body.tenants ?? []).map((tenant: any) => tenant.tenantName).join(' | ');
};

/** requireAuth mit gefaelschtem Request: welche Firma bedient der Server? */
const servedTenant = async (token: string, requestedTenantId: string): Promise<string> => {
    // Die Caches leeren, damit der Lauf die frische Entscheidung misst und
    // nicht die von vor dem Umlegen der Flagge.
    clearTenantSwitchAccessCache();
    clearAuthIdentityCache();
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
        select: { id: true, firstName: true, lastName: true },
    });
    if (!admin) throw new Error('keine Person mit Administratorrolle');

    const pmRole = await prisma.role.findFirst({
        where: { roleName: 'Projektmanager' },
        select: { id: true, roleName: true, canSwitchTenant: true, employees: { select: { employeeId: true }, take: 1 } },
    });
    if (!pmRole?.employees.length) throw new Error('keine Projektmanager-Rolle mit Traegerin/Traeger');

    const pmId = pmRole.employees[0]!.employeeId;
    const pm = (await prisma.employee.findUnique({
        where: { id: pmId },
        select: { firstName: true, lastName: true, tenantId: true, allowedTenantIds: true },
    }))!;

    /* Eine Firma im EIGENEN Baum, in die der Projektmanager nicht zugeteilt
       ist. (Ein fremder Baum wird ohnehin mit 401 abgewiesen — das ist die
       harte Grenze und bleibt unberuehrt.) */
    const tenants = await prisma.tenant.findMany({
        where: { isActive: true },
        select: { id: true, tenantName: true, parentTenantId: true },
    });
    const byId = new Map(tenants.map((t) => [t.id, t]));
    const rootOf = (id: string): string | null => {
        let cur = byId.get(id);
        if (!cur) return null;
        for (let d = 0; cur.parentTenantId && d < 20; d += 1) {
            const p = byId.get(cur.parentTenantId);
            if (!p) return null;
            cur = p;
        }
        return cur.id;
    };
    const homeRoot = rootOf(pm.tenantId);
    const sister = tenants.find((t) => t.id !== pm.tenantId && rootOf(t.id) === homeRoot)!;
    const stranger = tenants.find((t) => rootOf(t.id) !== homeRoot);

    const adminToken = await tokenFor(admin.id);
    const pmToken = await tokenFor(pmId);

    console.log(`Administrator : ${admin.firstName} ${admin.lastName}`);
    console.log(`Projektmanager: ${pm.firstName} ${pm.lastName}  (eigene Firma ${pm.tenantId}, Zuteilung ${JSON.stringify(pm.allowedTenantIds)})`);
    console.log(`Schwesterfirma im eigenen Baum: ${sister.tenantName} (${sister.id})`);
    if (stranger) console.log(`Fremder Baum                  : ${stranger.tenantName} (${stranger.id})`);
    console.log(`Rolle "${pmRole.roleName}": canSwitchTenant=${pmRole.canSwitchTenant}\n`);

    const originally = Boolean(pmRole.canSwitchTenant);
    let restored = false;
    const setFlag = async (value: boolean) => {
        const response = await fetch(`${BASE}/role-templates/${pmRole.id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ canSwitchTenant: value }),
        });
        const body: any = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`PUT /role-templates ${response.status} ${JSON.stringify(body).slice(0, 300)}`);
        return body;
    };

    try {
        console.log('1) VORHER');
        console.log('   Administrator  -> ', await companiesOffered(adminToken));
        console.log('   Projektmanager -> ', await companiesOffered(pmToken));
        console.log(`   PM verlangt ${sister.tenantName} -> bedient: ${await servedTenant(pmToken, sister.id)}`);

        console.log('\n2) Firmenwechsel fuer die Rolle EINSCHALTEN (ueber die API, als Administrator)');
        console.log('   Antwort:', JSON.stringify(await setFlag(true)));
        console.log('   Projektmanager -> ', await companiesOffered(pmToken));
        console.log(`   PM verlangt ${sister.tenantName} -> bedient: ${await servedTenant(pmToken, sister.id)}`);
        if (stranger) {
            console.log(`   PM verlangt ${stranger.tenantName} (FREMDER Baum) -> ${await servedTenant(pmToken, stranger.id)}`);
        }

        console.log('\n3) Wieder AUSSCHALTEN — der Entzug muss sofort greifen, nicht erst nach der TTL');
        await setFlag(originally);
        restored = true;
        console.log('   Projektmanager -> ', await companiesOffered(pmToken));
        console.log(`   PM verlangt ${sister.tenantName} -> bedient: ${await servedTenant(pmToken, sister.id)}`);
    } finally {
        if (!restored) {
            await prisma.role.update({ where: { id: pmRole.id }, data: { canSwitchTenant: originally } });
            console.log(`\n(zurueckgesetzt auf canSwitchTenant=${originally})`);
        }
        await prisma.$disconnect();
    }
})().catch(async (error) => {
    console.error('FEHLER:', error);
    await prisma.$disconnect();
    process.exit(1);
});
