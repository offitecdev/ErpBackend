/**
 * Der ganze Anmeldeweg über HTTP, gegen den laufenden Server auf :3000.
 *
 * Legt dafür EIN Wegwerfkonto an (Zufallsadresse, `zz-totp-selftest-…`), spielt
 * beide Hälften durch und räumt es am Ende wieder weg — auch wenn unterwegs
 * etwas schiefgeht (`finally`).
 *
 * Ausführen:  npx ts-node --transpile-only scratchpad/_verify-mfa-http.ts
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import prisma from '../src/infrastructure/database/prisma.client';
import { totpCodeForStep, currentTotpStep } from '../src/shared/totp';

const BASE = 'http://localhost:3000/api/v1';
const PASSWORD = 'Selftest!2026x';

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed += 1;
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${ok ? '' : `\n        erwartet ${JSON.stringify(expected)}\n        erhalten ${JSON.stringify(actual)}`}`);
};

// ── Ein Keksglas, wie es ein Browser führt ──────────────────────────────────
const jar = new Map<string, string>();
const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
const absorb = (response: Response) => {
    // Node bündelt mehrere Set-Cookie-Zeilen in getSetCookie().
    for (const line of (response.headers as any).getSetCookie?.() ?? []) {
        const [pair] = String(line).split(';');
        const index = pair?.indexOf('=') ?? -1;
        if (index <= 0) continue;
        const name = pair!.slice(0, index);
        const value = pair!.slice(index + 1);
        if (!value || value === 'undefined') jar.delete(name);
        else jar.set(name, value);
    }
};

const call = async (method: string, url: string, body?: unknown) => {
    const response = await fetch(`${BASE}${url}`, {
        method,
        headers: {
            'content-type': 'application/json',
            ...(jar.size ? { cookie: cookieHeader() } : {}),
            ...(jar.has('ofi_csrf') ? { 'x-csrf-token': jar.get('ofi_csrf') as string } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    absorb(response);
    const text = await response.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
    return { status: response.status, body: json };
};

const main = async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const email = `zz-totp-selftest-${suffix}@offitec.ch`;
    let employeeId = '';

    try {
        // ── Wegwerfkonto ────────────────────────────────────────────────────
        const bcrypt = require('bcrypt');
        const tenant: any[] = await prisma.$queryRawUnsafe('SELECT id FROM Tenant WHERE isActive = 1 LIMIT 1');
        const tenantId = tenant[0]?.id;
        if (!tenantId) throw new Error('Keine Firma gefunden.');

        employeeId = `zz-totp-${suffix}`;
        await prisma.employee.create({
            data: {
                id: employeeId,
                tenantId,
                firstName: 'Selbst',
                lastName: 'Test',
                email,
                passwordHash: await bcrypt.hash(PASSWORD, 12),
                isActive: true,
            },
        });
        console.log(`Wegwerfkonto ${email}\n`);

        await call('GET', '/auth/csrf');

        // ── 1. Falsches Kennwort ────────────────────────────────────────────
        let response = await call('POST', '/auth/login', { email, password: 'Falsch!2026x' });
        check('falsches Kennwort → 400', response.status, 400);
        check('… keine Sitzung', jar.has('ofi_access'), false);
        check('… kein Zwischenkeks', jar.has('ofi_mfa'), false);

        // ── 2. Richtiges Kennwort → Einrichtung verlangt ────────────────────
        response = await call('POST', '/auth/login', { email, password: PASSWORD });
        check('richtiges Kennwort → 200', response.status, 200);
        check('… verlangt den zweiten Faktor', response.body?.mfaRequired, true);
        check('… und zwar die Einrichtung', response.body?.stage, 'enroll');
        check('… QR-Adresse dabei', typeof response.body?.setup?.otpauthUri, 'string');
        check('… Zwischenkeks gesetzt', jar.has('ofi_mfa'), true);
        check('… ABER NOCH KEINE SITZUNG', [jar.has('ofi_access'), jar.has('ofi_refresh')], [false, false]);
        check('… und kein Token im Körper', JSON.stringify(response.body).includes('ofi_'), false);

        const secret: string = response.body.setup.secret;

        // Ein Zugriff mit dem Zwischenkeks allein muss ins Leere laufen.
        const meWithChallenge = await fetch(`${BASE}/auth/me`, { headers: { cookie: cookieHeader() } });
        check('geschützte Seite mit halber Anmeldung → 401', meWithChallenge.status, 401);

        // ── 3. Falscher Code ────────────────────────────────────────────────
        response = await call('POST', '/auth/mfa/verify', { code: '000000' });
        check('falscher Code → 400', response.status, 400);
        check('… mit Marke für die Oberfläche', response.body?.code, 'mfa_code_invalid');
        check('… Zwischenkeks BLEIBT (nochmal tippen)', jar.has('ofi_mfa'), true);

        // ── 4. Richtiger Code → Einrichtung + Anmeldung ─────────────────────
        const step = currentTotpStep();
        /* Bewusst MIT Leerzeichen abgetippt — so, wie ein Mensch "482 193"
           abliest. Die Formpruefung raeumt das auf (authSchemas). */
        const enrollCode = totpCodeForStep(secret, step);
        response = await call('POST', '/auth/mfa/verify', { code: `${enrollCode.slice(0, 3)} ${enrollCode.slice(3)}` });
        check('richtiger Code (mit Leerzeichen) → 200', response.status, 200);
        check('… als Einrichtung gemeldet', response.body?.enrolled, true);
        check('… Person in der Antwort', response.body?.employee?.email === undefined ? response.body?.employee?.id : 'unerwartet', employeeId);
        check('… Sitzungskeks gesetzt', [jar.has('ofi_access'), jar.has('ofi_refresh')], [true, true]);
        check('… Zwischenkeks weggeräumt', jar.has('ofi_mfa'), false);

        const me = await call('GET', '/auth/me');
        check('geschützte Seite jetzt erreichbar', me.status, 200);
        check('… und es ist die richtige Person', me.body?.email, email);

        const stored: any[] = await prisma.$queryRawUnsafe(
            'SELECT totpSecret, totpEnabledAt, totpLastStep FROM Employee WHERE id = ?', employeeId,
        );
        check('Geheimnis verschlüsselt in der Zeile', String(stored[0]?.totpSecret).startsWith('enc:v1:'), true);
        check('… Klartext steht NICHT darin', String(stored[0]?.totpSecret).includes(secret), false);
        check('… Fenster gemerkt', stored[0]?.totpLastStep, step);

        // ── 5. ZWEITE Anmeldung: nur noch der Code ──────────────────────────
        await call('POST', '/auth/logout');
        jar.clear();
        await call('GET', '/auth/csrf');

        response = await call('POST', '/auth/login', { email, password: PASSWORD });
        check('zweite Anmeldung → nur Code', response.body?.stage, 'verify');
        check('… KEIN Geheimnis mehr nach draussen', response.body?.setup, undefined);

        // Derselbe Code wie vorhin: schon verbraucht.
        response = await call('POST', '/auth/mfa/verify', { code: totpCodeForStep(secret, step) });
        check('verbrauchter Code → abgelehnt', [response.status, response.body?.code], [400, 'mfa_code_reused']);

        // Der Code des nächsten Fensters geht.
        response = await call('POST', '/auth/mfa/verify', { code: totpCodeForStep(secret, step + 1) });
        check('nächster Code → angemeldet', response.status, 200);
        check('… und nicht mehr als Einrichtung', response.body?.enrolled, false);
        check('… Sitzung steht', jar.has('ofi_access'), true);

        // ── 6. Formprüfung ──────────────────────────────────────────────────
        await call('POST', '/auth/logout');
        jar.clear();
        await call('GET', '/auth/csrf');
        await call('POST', '/auth/login', { email, password: PASSWORD });
        response = await call('POST', '/auth/mfa/verify', { code: '12' });
        check('zu kurzer Code → 400 aus der Pruefung', response.status, 400);
        check('… Zwischenkeks bleibt (Pruefung ist kein Fehlversuch)', jar.has('ofi_mfa'), true);
    } finally {
        if (employeeId) {
            await prisma.$executeRawUnsafe('DELETE FROM RefreshSession WHERE employeeId = ?', employeeId);
            await prisma.$executeRawUnsafe('DELETE FROM AuditLog WHERE employeeId = ?', employeeId);
            await prisma.$executeRawUnsafe('DELETE FROM Employee WHERE id = ?', employeeId);
            const left: any[] = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM Employee WHERE id = ?', employeeId);
            console.log(`\nWegwerfkonto entfernt (Rest: ${left[0]?.n}).`);
        }
        await prisma.$disconnect();
    }

    console.log(failed === 0 ? '\nAlle Prüfungen bestanden.' : `\n${failed} Prüfung(en) fehlgeschlagen.`);
    process.exit(failed === 0 ? 0 : 1);
};

void main().catch((error) => {
    console.error('FEHLER:', error);
    process.exit(1);
});
