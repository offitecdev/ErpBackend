/* Nachweis der Korrekturen 4 (Selbst-Freischaltung) und 6 (Sitzungsführung).
   Läuft NUR nach der Migration `20260922090000_auth_hardening`.
   Der Lauf legt ein eigenes Testkonto an und räumt es am Ende wieder ab. */
import { nanoid } from 'nanoid';
import prisma from '../src/infrastructure/database/prisma.client';
import { BcryptCryptoService } from '../src/infrastructure/services/BcryptCryptoService';
import { EmployeeRepository } from '../src/infrastructure/repositories/EmployeeRepository';
import { RequestAccountActivationUseCase, ActivateAccountUseCase } from '../src/application/use-cases/auth/AccountActivationUseCases';
import { JwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';
import { AuthMailService } from '../src/infrastructure/services/AuthMailService';
import { REUSE_GRACE_MS } from '../src/infrastructure/services/RefreshSessionService';

const BASE = 'http://localhost:3000/api/v1';
const ok = (b: boolean) => (b ? 'OK  ' : 'FEHL');
const PASSWORD = 'Testtest1!';

const cookiesFrom = (res: Response): Record<string, string> => {
    const jar: Record<string, string> = {};
    for (const raw of (res.headers as any).getSetCookie?.() ?? []) {
        const pair = String(raw).split(';')[0] ?? '';
        const index = pair.indexOf('=');
        if (index > 0) jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
    }
    return jar;
};
const header = (jar: Record<string, string>) =>
    Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

(async () => {
    const crypto = new BcryptCryptoService();
    const repo = new EmployeeRepository();
    const tenant = (await prisma.tenant.findFirst({ where: { isActive: true }, select: { id: true } }))!;
    const email = `sec-test-${nanoid(6).toLowerCase()}@offitec.test`;

    const person = await prisma.employee.create({
        data: {
            id: nanoid(), tenantId: tenant.id, firstName: 'Sicherheits', lastName: 'Test',
            email, passwordHash: await crypto.hashPassword(PASSWORD), isActive: true,
        },
        select: { id: true, email: true },
    });
    console.log(`Testkonto: ${person.email}\n`);

    try {
        // ════ FIX 4 ════
        console.log('════ FIX 4 — Selbst-Freischaltung nach Stilllegung ════');
        const tokenService = new JwtTokenService();
        const mails: string[] = [];
        const spyMail = {
            sendActivationMail: async (_t: string, to: string) => { mails.push(to); },
        } as unknown as AuthMailService;
        const request = new RequestAccountActivationUseCase(repo, tokenService, spyMail);
        const activate = new ActivateAccountUseCase(repo, tokenService);

        // (a) Noch nie freigeschaltet: der Link darf kommen.
        await repo.update(person.id, { isActive: false, deactivatedAt: null } as any);
        await request.execute(person.email);
        console.log(`${ok(mails.length === 1)} nie freigeschaltetes Konto bekommt den Aktivierungslink`);

        // (b) Von der Verwaltung stillgelegt: kein Link mehr.
        await repo.update(person.id, { isActive: true } as any);   // leert deactivatedAt
        await repo.update(person.id, { isActive: false } as any);  // setzt sie wieder
        const marked = await prisma.employee.findUnique({ where: { id: person.id }, select: { deactivatedAt: true } });
        console.log(`${ok(Boolean(marked?.deactivatedAt))} Stilllegung setzt deactivatedAt`);
        mails.length = 0;
        await request.execute(person.email);
        console.log(`${ok(mails.length === 0)} stillgelegtes Konto bekommt KEINEN Aktivierungslink`);

        // (c) Ein VOR der Stilllegung ausgestellter Link greift auch nicht mehr.
        const stale = tokenService.generateToken('activation', {
            id: person.id, tenantId: tenant.id, email: person.email, pwdAt: 0,
        });
        let refused = false;
        try { await activate.execute(stale); } catch { refused = true; }
        const still = await prisma.employee.findUnique({ where: { id: person.id }, select: { isActive: true } });
        console.log(`${ok(refused && !still?.isActive)} alter Aktivierungslink schaltet ein stillgelegtes Konto nicht frei`);

        // (d) Die Verwaltung öffnet es wieder — die Marke fällt.
        await repo.update(person.id, { isActive: true } as any);
        const cleared = await prisma.employee.findUnique({ where: { id: person.id }, select: { deactivatedAt: true } });
        console.log(`${ok(cleared?.deactivatedAt === null)} Reaktivierung durch die Verwaltung leert deactivatedAt`);

        // ════ FIX 6 ════
        console.log('\n════ FIX 6 — Sitzungsführung ════');
        const login = async () => {
            const res = await fetch(`${BASE}/auth/login`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: person.email, password: PASSWORD }),
            });
            return { res, jar: cookiesFrom(res) };
        };
        const refresh = (jar: Record<string, string>) => fetch(`${BASE}/auth/refresh`, {
            method: 'POST', headers: { Cookie: header(jar) },
        });

        const first = await login();
        console.log(`${ok(first.res.status === 200 && Boolean(first.jar.ofi_refresh))} Anmeldung liefert ein Erneuerungstoken`);
        const rows = await (prisma as any).refreshSession.count({ where: { employeeId: person.id } });
        console.log(`${ok(rows === 1)} Anmeldung legt genau eine Sitzungszeile an`);

        // (a) Wettlauf zweier Rahmen: sofortiger zweiter Tausch desselben Tokens
        //     wird getragen — sonst meldete die geteilte Ansicht beide ab.
        const stolen = { ...first.jar };
        const rotated = await refresh(first.jar);
        const rotatedJar = { ...first.jar, ...cookiesFrom(rotated) };
        console.log(`${ok(rotated.status === 200)} Erneuerung gelingt`);
        const raced = await refresh(stolen);
        console.log(`${ok(raced.status === 200)} zweiter Tausch INNERHALB der Schonfrist gilt als Wettlauf (geteilte Ansicht)`);

        // (b) Derselbe Vorgang NACH der Schonfrist ist eine Wiedereinspielung:
        //     das Token wird abgewiesen UND die ganze Anmeldung fällt.
        //     Statt zu warten wird der Tausch künstlich zurückdatiert.
        await (prisma as any).refreshSession.updateMany({
            where: { employeeId: person.id, revokedReason: 'rotated' },
            data: { revokedAt: new Date(Date.now() - 10 * REUSE_GRACE_MS) },
        });
        const replay = await refresh(stolen);
        console.log(`${ok(replay.status === 401)} dasselbe Token NACH der Schonfrist wird abgewiesen (früher: 30 Tage gültig)`);
        const afterReplay = await refresh(rotatedJar);
        console.log(`${ok(afterReplay.status === 401)} der Wiedereinspielversuch legt die GANZE Anmeldung still`);
        const familyOpen = await (prisma as any).refreshSession.count({
            where: { employeeId: person.id, revokedAt: null },
        });
        console.log(`${ok(familyOpen === 0)} keine offene Zeile der Familie bleibt übrig`);

        // (c) Abmelden beendet die Sitzung wirklich.
        const second = await login();
        const stolenAfterLogout = { ...second.jar };
        const out = await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { Cookie: header(second.jar) } });
        const afterLogout = await refresh(stolenAfterLogout);
        console.log(`${ok(out.status === 200 && afterLogout.status === 401)} nach dem Abmelden ist das Erneuerungstoken tot (früher: 30 Tage gültig)`);

        // (d) Sperren beendet alle offenen Anmeldungen.
        const third = await login();
        await repo.update(person.id, { bannedAt: new Date(), isActive: false } as any);
        await new Promise((r) => setTimeout(r, 300));
        const open = await (prisma as any).refreshSession.count({ where: { employeeId: person.id, revokedAt: null } });
        const afterBan = await refresh(third.jar);
        console.log(`${ok(open === 0 && afterBan.status === 401)} Sperre entwertet jede offene Sitzung`);
    } finally {
        await (prisma as any).refreshSession.deleteMany({ where: { employeeId: person.id } });
        await prisma.employee.delete({ where: { id: person.id } });
        console.log('\n(Testkonto entfernt)');
        await prisma.$disconnect();
    }
})().catch(async (e) => { console.error('FEHLER:', e); await prisma.$disconnect(); process.exit(1); });
