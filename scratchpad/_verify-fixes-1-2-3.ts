/* Nachweis der drei Sicherheitskorrekturen (nur lesend bis auf einen
   PATCH-Versuch, der genau NICHTS ändern darf). */
import { Prisma } from '@prisma/client';
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';
import { getAssignableTenantIds } from '../src/presentation/controllers/serviceTenantScope';

const BASE = 'http://localhost:3000/api/v1';
const ok = (b: boolean) => (b ? 'OK  ' : 'FEHL');

const tokenFor = async (email: string) => {
    const p = await prisma.employee.findUnique({
        where: { email }, select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    if (!p) throw new Error('kein Konto ' + email);
    return { id: p.id, token: jwtTokenService.generateToken('access', {
        id: p.id, tenantId: p.tenantId, email: p.email, pwdAt: toPwdAtClaim(p.passwordChangedAt),
    } as any) };
};

(async () => {
    const tenants = await prisma.tenant.findMany({ where: { isActive: true }, select: { id: true, tenantName: true, parentTenantId: true } });
    const foreign = tenants.find((t) => t.id === 'GZrxF3v4')!;
    const admin = await tokenFor('mak@offitec.eu');        // Administrator (isSystemAdmin)
    const manager = await tokenFor('ba@gmail.com');        // roles.manage, KEIN Administrator
    const alt = await tokenFor('admin@offitec.com');       // roles.manage + canSwitchTenant, kein Administrator

    console.log('════ FIX 1 — Zuteilbare Firmen ════');
    for (const [label, who] of [['Administrator mak@', admin], ['Manager ba@', manager], ['Admin-Rolle admin@', alt]] as const) {
        const home = (await prisma.employee.findUnique({ where: { id: who.id }, select: { tenantId: true } }))!.tenantId;
        const list = await getAssignableTenantIds(home, home, who.id);
        const hasForeign = list.includes(foreign.id);
        const expected = label.startsWith('Administrator');
        console.log(`${ok(hasForeign === expected)} ${label.padEnd(20)} ${list.length} Firmen, fremde Gruppe "${foreign.tenantName}" ${hasForeign ? 'ENTHALTEN' : 'nicht enthalten'}`);
    }

    console.log('\n════ FIX 1 — Zuteilung über die API ════');
    const victim = await prisma.employee.findFirst({ where: { email: 'sahin@offitec.ch' }, select: { id: true, allowedTenantIds: true, tenantId: true } });
    if (victim) {
        for (const [label, who] of [['Manager ba@', manager], ['Administrator mak@', admin]] as const) {
            const res = await fetch(`${BASE}/employees/${victim.id}/authorization`, {
                method: 'PUT',
                headers: { Authorization: `Bearer ${who.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ allowedTenantIds: [victim.tenantId, foreign.id] }),
            });
            const body: any = await res.json().catch(() => ({}));
            const blocked = res.status === 400;
            const expectBlocked = label.startsWith('Manager');
            console.log(`${ok(blocked === expectBlocked)} ${label.padEnd(20)} PUT allowedTenantIds[fremde Gruppe] -> ${res.status} ${body.error ?? 'angenommen'}`);
        }
        // Zurücksetzen auf den vorgefundenen Wert (der Administrator-Lauf oben
        // schreibt). Json-Spalte: `null` hiesse "nicht ändern" — nur DbNull leert.
        await prisma.employee.update({
            where: { id: victim.id },
            data: { allowedTenantIds: Array.isArray(victim.allowedTenantIds)
                ? (victim.allowedTenantIds as any)
                : Prisma.DbNull } as any,
        });
        console.log('     (Zuteilung von sahin@ zurückgesetzt)');
    }

    console.log('\n════ FIX 2 — QR-Schlüssel ════');
    const listRes = await fetch(`${BASE}/personnel/staff?page=1&pageSize=5`, { headers: { Authorization: `Bearer ${admin.token}` } });
    const listBody: any = await listRes.json();
    const raw = JSON.stringify(listBody);
    console.log(`${ok(!raw.includes('qrToken') && !raw.includes('OFITEC-STAFF:'))} GET /personnel/staff  -> ${listBody.data?.length ?? 0} Zeilen, kein qrToken im Körper`);

    const meRes = await fetch(`${BASE}/personnel/me`, { headers: { Authorization: `Bearer ${admin.token}` } });
    const meRaw = JSON.stringify(await meRes.json());
    console.log(`${ok(!meRaw.includes('qrToken'))} GET /personnel/me     -> kein qrToken im Körper`);

    const someone = listBody.data?.[0];
    if (someone) {
        const ovRes = await fetch(`${BASE}/personnel/staff/${someone.id}/overview`, { headers: { Authorization: `Bearer ${admin.token}` } });
        const ovRaw = JSON.stringify(await ovRes.json());
        console.log(`${ok(!ovRaw.includes('qrToken'))} GET .../overview      -> kein qrToken im Körper`);

        const qrRes = await fetch(`${BASE}/personnel/staff/${someone.id}/qr`, { headers: { Authorization: `Bearer ${admin.token}` } });
        const qrBody: any = await qrRes.json();
        const got = typeof qrBody.qrToken === 'string' || qrBody.qrToken === null;
        console.log(`${ok(qrRes.ok && got)} GET .../qr            -> ${qrRes.status}, Schlüssel ${qrBody.qrToken ? 'geliefert' : '(keiner vergeben)'}`);
    }

    console.log('\n════ FIX 3 — Massenzuweisung ════');
    const target = await prisma.employee.findFirst({
        where: { email: 'mak@offitec.eu' },
        select: { id: true, passwordHash: true, qrToken: true, bannedAt: true, deletedAt: true, passwordChangedAt: true, title: true },
    });
    if (target) {
        const res = await fetch(`${BASE}/employees/${target.id}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: target.title ?? 'unverändert',
                passwordHash: '$2b$12$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                qrToken: 'OFITEC-STAFF:ANGRIFF-TESTWERT-0001',
                bannedAt: null,
                deletedAt: null,
                passwordChangedAt: '2000-01-01T00:00:00.000Z',
                staffNumber: 99999,
                tenantId: foreign.id,
            }),
        });
        const after = (await prisma.employee.findUnique({
            where: { id: target.id },
            select: { passwordHash: true, qrToken: true, passwordChangedAt: true, tenantId: true, staffNumber: true },
        }))!;
        console.log(`     PATCH /employees/:id -> ${res.status}`);
        console.log(`${ok(after.passwordHash === target.passwordHash)} passwordHash unverändert`);
        console.log(`${ok(after.qrToken === target.qrToken)} qrToken unverändert`);
        console.log(`${ok(String(after.passwordChangedAt) === String(target.passwordChangedAt))} passwordChangedAt unverändert`);
        console.log(`${ok(after.tenantId !== foreign.id)} tenantId unverändert`);
        console.log(`${ok(after.staffNumber !== 99999)} staffNumber unverändert`);
    }

    await prisma.$disconnect();
})().catch(async (e) => { console.error('FEHLER:', e); await prisma.$disconnect(); process.exit(1); });
