/**
 * SCHREIBPROBE DES PERSONAL-UMBAUS (26.08.2026).
 *
 * Sie legt einen Feiertag an, liest ihn zurück und löscht ihn wieder — sie
 * RÄUMT ALSO HINTER SICH AUF. Die Urlaubsregel wird mit den Werten
 * zurückgeschrieben, die schon dastanden.
 *
 * BEWUSST NICHT GEPRÜFT: einen Antrag anzulegen. Das würde Meldungen und
 * echte Mails an die Verwaltung des Hauses auslösen; so etwas gehört nicht in
 * eine Probe.
 *
 * Aufruf (aus Erp_Backend):
 *   SMOKE_EMAIL=… npx ts-node -T -r dotenv/config scratchpad/smoke-personnel-write.ts
 */
import prisma from '../src/infrastructure/database/prisma.client';
import { JwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';

const BASE = process.env.SMOKE_BASE || 'http://localhost:3000/api/v1';

const main = async () => {
    const wanted = process.env.SMOKE_EMAIL?.trim().toLowerCase();
    const employee = await prisma.employee.findFirst({
        where: wanted ? { email: wanted } : { deletedAt: null, isActive: true },
        select: { id: true, tenantId: true, email: true, passwordChangedAt: true },
    });
    if (!employee) throw new Error('Keine Person gefunden.');

    const token = new JwtTokenService().generateToken('access', {
        id: employee.id,
        tenantId: employee.tenantId,
        email: employee.email,
        pwdAt: toPwdAtClaim(employee.passwordChangedAt),
    } as any);

    const call = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`${BASE}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const text = await response.text();
        console.log(`${String(response.status).padEnd(4)} ${method} ${path}\n     ${text.slice(0, 220)}`);
        return { status: response.status, text };
    };

    // ── Urlaubsregel: mit den vorhandenen Werten zurückschreiben ─────────────
    const current = await call('GET', '/personnel/leave-policy');
    const policy = JSON.parse(current.text).policy;
    await call('PUT', '/personnel/leave-policy', policy);

    // ── Feiertag: anlegen, zurücklesen, löschen ─────────────────────────────
    const probeDate = '2099-07-04';
    const probeName = 'PROBE — bitte ignorieren';
    const created = await call('POST', '/personnel/holidays', {
        date: probeDate,
        name: probeName,
        countryCode: 'TR',
        religious: false,
        halfDay: true,
    });
    const holiday = created.status === 201 ? JSON.parse(created.text) : null;

    const listed = await call('GET', '/personnel/holidays?year=2099');
    const found = listed.status === 200
        && JSON.parse(listed.text).holidays.some((row: any) => row.name === probeName);
    console.log(`     zurückgelesen: ${found ? 'ja' : 'NEIN'}`);

    if (holiday?.id) await call('DELETE', `/personnel/holidays/${holiday.id}`);

    // Sicherheitsnetz: was die Probe angelegt hat, verschwindet auf jeden Fall.
    const left = await prisma.publicHoliday.deleteMany({ where: { name: probeName } });
    console.log(`     Aufräumen: ${left.count} Restzeile(n) entfernt.`);
};

main()
    .catch((error) => { console.error('FEHLER:', error?.message || error); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
