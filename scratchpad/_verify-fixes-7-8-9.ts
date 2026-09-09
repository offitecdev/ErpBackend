/* Nachweis der Korrekturen 7 (Kontosperre), 8 (keine inneren Meldungen nach
   draussen) und 9 (getrennte Postweg-Zähler).

   Der Lauf legt ein eigenes Testkonto an und räumt es am Ende ab. Für Fix 9
   wird bewusst eine NICHT vorhandene Adresse benutzt — dann versucht der Server
   gar keinen Mailversand. */
import { nanoid } from 'nanoid';
import prisma from '../src/infrastructure/database/prisma.client';
import { BcryptCryptoService } from '../src/infrastructure/services/BcryptCryptoService';
import { PublicError, toPublicMessage, GENERIC_ERROR_MESSAGE } from '../src/application/errors/AuthErrors';
import {
    assertLoginAllowed, recordLoginFailure, clearLoginFailures,
    resetLoginThrottle, loginThrottleSize,
} from '../src/application/services/loginThrottle';
import { TooManyAttemptsError } from '../src/application/errors/AuthErrors';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';

const BASE = 'http://localhost:3000/api/v1';
const ok = (b: boolean) => (b ? 'OK  ' : 'FEHL');
const PASSWORD = 'Testtest1!';

const locked = (email: string): TooManyAttemptsError | null => {
    try { assertLoginAllowed(email); return null; } catch (e) { return e as TooManyAttemptsError; }
};

const login = (email: string, password: string) => fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
});

(async () => {
    const crypto = new BcryptCryptoService();
    /* Das Testkonto gehört in die Firma der VERWALTUNG — sonst antwortet die
       Zugangsfläche unten mit 404 (Person ausserhalb des Personalkreises) und
       die Prüfung auf durchgereichte Datenbankmeldungen liefe ins Leere. */
    const admin = (await prisma.employee.findFirst({
        where: { deletedAt: null, isActive: true, employeeRoles: { some: { role: { isSystemAdmin: true } } } },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    }))!;
    const email = `sec-test-${nanoid(6).toLowerCase()}@offitec.test`;
    const person = await prisma.employee.create({
        data: {
            id: nanoid(), tenantId: admin.tenantId, firstName: 'Sicherheits', lastName: 'Test',
            email, passwordHash: await crypto.hashPassword(PASSWORD), isActive: true,
        },
        select: { id: true, email: true },
    });

    try {
        // ════════════════════ FIX 7 — Kontosperre ════════════════════
        console.log('════ FIX 7 — Sperre je KONTO (nicht je Anschluss) ════');
        resetLoginThrottle();

        // Vier Fehlversuche sind noch keine Sperre, der fünfte macht zu.
        for (let i = 0; i < 4; i += 1) recordLoginFailure('Opfer@Offitec.CH');
        console.log(`${ok(locked('opfer@offitec.ch') === null)} 4 Fehlversuche sperren noch nicht`);
        recordLoginFailure('opfer@offitec.ch');
        const lock = locked('OPFER@offitec.ch');
        console.log(`${ok(Boolean(lock))} der 5. Fehlversuch sperrt — unabhängig von Gross-/Kleinschreibung`);
        console.log(`${ok((lock?.retryAfterSeconds ?? 0) > 0)} die Sperre nennt eine Wartezeit (${lock?.retryAfterSeconds}s)`);

        // Wachsende Wartezeit: mehr Fehlversuche = längere Sperre.
        const first = locked('opfer@offitec.ch')!.retryAfterSeconds;
        for (let i = 0; i < 3; i += 1) recordLoginFailure('opfer@offitec.ch');
        const later = locked('opfer@offitec.ch')!.retryAfterSeconds;
        console.log(`${ok(later > first)} die Wartezeit wächst mit jedem weiteren Versuch (${first}s → ${later}s)`);

        // Eine UNBEKANNTE Adresse sperrt genauso — sonst wäre die Sperre selbst
        // die Auskunft, welche Adressen es gibt.
        for (let i = 0; i < 5; i += 1) recordLoginFailure('gibtesnicht@nirgends.test');
        console.log(`${ok(Boolean(locked('gibtesnicht@nirgends.test')))} auch eine unbekannte Adresse sperrt (keine Konto-Auskunft)`);

        // Ein anderes Konto bleibt davon unberührt, und ein richtiges Kennwort räumt auf.
        console.log(`${ok(locked('jemand.anderes@offitec.ch') === null)} ein anderes Konto ist nicht mitgesperrt`);
        clearLoginFailures('opfer@offitec.ch');
        console.log(`${ok(locked('opfer@offitec.ch') === null)} richtiges Kennwort löscht den Zähler`);

        resetLoginThrottle();
        console.log(`${ok(loginThrottleSize() === 0)} Zähler lässt sich leeren (Speicher bleibt begrenzt)`);

        // Und dasselbe über die Schnittstelle: fünf falsche Kennwörter, dann 429.
        let lastStatus = 0; let lastBody: any = {}; let retryAfter: string | null = null;
        for (let i = 0; i < 6; i += 1) {
            const res = await login(person.email, 'Falschesss1!');
            lastStatus = res.status; lastBody = await res.json().catch(() => ({}));
            retryAfter = res.headers.get('retry-after');
        }
        const isAccountLock = lastStatus === 429 && String(lastBody.error || '').includes('dakika sonra');
        console.log(`${ok(isAccountLock)} über die Schnittstelle: nach 5 Fehlversuchen 429 (${lastBody.error})`);
        console.log(`${ok(Boolean(retryAfter))} die Antwort trägt Retry-After (${retryAfter})`);

        // ════════════════════ FIX 8 — keine inneren Meldungen ════════════════════
        console.log('\n════ FIX 8 — innere Meldungen bleiben innen ════');
        console.log(`${ok(toPublicMessage(new PublicError('Sichtbarer Satz.'), 'test') === 'Sichtbarer Satz.')} ein PublicError wird durchgereicht`);
        const internal = toPublicMessage(new Error('JWT secret eksik: OFFITEC_JWT_ACCESS_SECRET tanımlanmamış.'), 'test');
        console.log(`${ok(internal === GENERIC_ERROR_MESSAGE)} ein gewöhnlicher Error wird zum festen Satz`);
        console.log(`${ok(!internal.includes('OFFITEC_JWT'))} der Name der Umgebungsvariable erscheint nicht`);

        // Der echte Fall: doppelte E-Mail auf der Zugangsfläche. Früher kam
        // "Unique constraint failed on the constraint: `Employee_email_key`".
        {
            const token = jwtTokenService.generateToken('access', {
                id: admin.id, tenantId: admin.tenantId, email: admin.email, pwdAt: toPwdAtClaim(admin.passwordChangedAt),
            } as any);
            const res = await fetch(`${BASE}/employees/${person.id}/authorization`, {
                method: 'PUT',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: admin.email }),   // schon vergeben
            });
            const body: any = await res.json().catch(() => ({}));
            const text = String(body.error || '');
            const leaks = /constraint|Employee_email_key|prisma|Invalid `prisma/i.test(text);
            const reached = res.status !== 404;   // 404 hiesse: gar nicht bis zum Schreibversuch gekommen
            console.log(`${ok(reached)} der Aufruf erreicht den Schreibversuch (Status ${res.status}, nicht 404)`);
            console.log(`${ok(!leaks && reached)} doppelte E-Mail verrät keine Tabellen-/Spaltennamen mehr → "${text}"`);
        }

        // ════════════════════ FIX 9 — getrennte Postweg-Zähler ════════════════════
        console.log('\n════ FIX 9 — Postwege: je Postfach statt je Büro ════');
        const stranger = `nicht-vorhanden-${nanoid(6).toLowerCase()}@offitec.test`;
        const other = `nicht-vorhanden-${nanoid(6).toLowerCase()}@offitec.test`;
        const resetRequest = (to: string) => fetch(`${BASE}/auth/password-reset/request`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: to }),
        });

        const codes: number[] = [];
        for (let i = 0; i < 4; i += 1) codes.push((await resetRequest(stranger)).status);
        console.log(`${ok(codes.slice(0, 3).every((c) => c === 200))} 3 Anfragen für dasselbe Postfach gehen durch (${codes.join(', ')})`);
        console.log(`${ok(codes[3] === 429)} die 4. für DASSELBE Postfach wird gebremst`);

        const otherStatus = (await resetRequest(other)).status;
        console.log(`${ok(otherStatus === 200)} ein ANDERES Postfach vom selben Anschluss geht weiter (früher: Büro gesperrt)`);

        // Die Bestätigung hat einen eigenen Zähler — sie darf nicht mitgesperrt sein.
        const confirm = await fetch(`${BASE}/auth/password-reset/confirm`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: 'unbrauchbar', newPassword: 'Testtest1!' }),
        });
        console.log(`${ok(confirm.status === 400)} die Bestätigung läuft auf eigenem Zähler (${confirm.status}, nicht 429)`);
    } finally {
        await (prisma as any).refreshSession.deleteMany({ where: { employeeId: person.id } });
        await prisma.employee.delete({ where: { id: person.id } });
        console.log('\n(Testkonto entfernt)');
        await prisma.$disconnect();
    }
})().catch(async (e) => { console.error('FEHLER:', e); await prisma.$disconnect(); process.exit(1); });
