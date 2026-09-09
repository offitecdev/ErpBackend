/* Nachweis der Korrekturen 14 (bcrypt gegen den Threadpool), 15 (die
   Zwischenspeicher werden auch wieder leer), 16 (Bremse am Kennwortwunsch)
   und 17 (die OSP-Webhooks fragen die Datenbank erst nach der Prüfung).

   Der Lauf legt ein eigenes Testkonto an und räumt es am Ende ab.
   WICHTIG: läuft absichtlich OHNE gesetztes UV_THREADPOOL_SIZE, also mit
   libuvs vier Plätzen — das ist der Zustand, gegen den Befund 14 geschrieben
   ist, und macht die Messung unten reproduzierbar. */
import fs from 'fs/promises';
import bcrypt from 'bcrypt';
import { nanoid } from 'nanoid';
import prisma from '../src/infrastructure/database/prisma.client';
import { BcryptCryptoService } from '../src/infrastructure/services/BcryptCryptoService';
import { TtlCache } from '../src/shared/ttlCache';
import { threadpoolAdvice, threadpoolSize } from '../src/infrastructure/config/runtime';
import { runBcryptGuarded, bcryptGateStats, resetBcryptGate } from '../src/application/services/bcryptGate';
import { TooManyAttemptsError } from '../src/application/errors/AuthErrors';
import { armedWebhookKeys, invalidateOspWebhookKeys } from '../src/presentation/routes/osp.routes';

const BASE = 'http://localhost:3000/api/v1';
const ok = (b: boolean) => (b ? 'OK  ' : 'FEHL');
const PASSWORD = 'Testtest1!';
// bcrypt(12)-Hash eines Wegwerfwerts — derselbe Blindwert wie im LoginUseCase.
const HASH = '$2b$12$pnTvvJV1RFRAnjBSDLGVEejwkDI5j2V36hQM/LjiV7wGT/Xg9yTf6';

let failures = 0;
const check = (passed: boolean, label: string) => {
    if (!passed) failures += 1;
    console.log(`${ok(passed)} ${label}`);
};
const note = (label: string) => console.log(`     ${label}`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wie lange braucht ein Dateizugriff, während `parallel` bcrypt-Aufgaben laufen? */
const fileLatencyUnderLoad = async (parallel: number, guarded: boolean): Promise<number> => {
    const burst = Array.from({ length: parallel }, (_, i) =>
        guarded
            ? runBcryptGuarded(`ip-${i}`, () => bcrypt.compare('x', HASH)).catch(() => false)
            : bcrypt.compare('x', HASH));
    // Einen Wimpernschlag warten, damit die Aufgaben tatsächlich im Pool sind.
    await sleep(20);
    const started = Date.now();
    await fs.readFile('package.json');
    const elapsed = Date.now() - started;
    await Promise.all(burst);
    return elapsed;
};

(async () => {
    const crypto = new BcryptCryptoService();

    // ═══════════════ FIX 14 — bcrypt darf den Pool nicht auffressen ══════════
    console.log('════ FIX 14 — die Anmeldung belegt nicht mehr den ganzen Threadpool ════');

    const pool = threadpoolAdvice();
    note(`Threadpool: ${pool.effective} Plaetze, empfohlen ${pool.recommended}; Schranke: ${bcryptGateStats().globalLimit} gleichzeitig`);
    check(threadpoolSize() === 4, 'ohne Umgebungsvariable meldet der Code ehrlich VIER Plaetze (nicht den Wunschwert)');
    check(bcryptGateStats().globalLimit === 2, 'bei vier Plaetzen sind hoechstens 2 bcrypt-Aufgaben erlaubt — 2 bleiben frei');
    check(pool.shouldRaise, 'und der Start meldet, dass UV_THREADPOOL_SIZE gehoben werden sollte');

    // Die eigentliche Messung: was macht ein Dateizugriff daneben?
    resetBcryptGate();
    const unguarded = await fileLatencyUnderLoad(12, false);
    await sleep(300);
    resetBcryptGate();
    const guarded = await fileLatencyUnderLoad(12, true);
    note(`Dateizugriff neben 12 Vergleichen: ohne Schranke ${unguarded} ms, mit Schranke ${guarded} ms`);
    check(unguarded > 200, `ohne Schranke wartet der Dateizugriff auf den Pool (${unguarded} ms)`);
    check(guarded < unguarded / 2, `mit Schranke kommt er durch (${guarded} ms, mehr als doppelt so schnell)`);

    // Grenze je Aufrufer: der fuenfte gleichzeitige Vergleich wird abgewiesen.
    resetBcryptGate();
    let rejected = 0;
    const sameKey = Array.from({ length: 6 }, () =>
        runBcryptGuarded('einer-und-derselbe', () => bcrypt.compare('x', HASH))
            .catch((e) => { if (e instanceof TooManyAttemptsError) rejected += 1; return false; }));
    await Promise.all(sameKey);
    check(rejected === 2, `von 6 gleichzeitigen Vergleichen EINES Aufrufers werden 2 abgewiesen (4 erlaubt, ${rejected} abgewiesen)`);

    resetBcryptGate();
    let otherRejected = 0;
    const manyKeys = Array.from({ length: 6 }, (_, i) =>
        runBcryptGuarded(`aufrufer-${i}`, () => bcrypt.compare('x', HASH))
            .catch(() => { otherRejected += 1; return false; }));
    await Promise.all(manyKeys);
    check(otherRejected === 0, 'sechs VERSCHIEDENE Aufrufer werden nicht abgewiesen, nur angestellt');
    check(bcryptGateStats().inFlight === 0, 'nach dem Lauf ist die Schranke wieder leer (kein Leck im Zaehler)');

    // ═══════════════ FIX 15 — die Zwischenspeicher werden wieder leer ════════
    console.log('\n════ FIX 15 — Zwischenspeicher mit Kehrbesen und Deckel ════');

    const cache = new TtlCache<string>({ name: 'test', ttlMs: 50, staleGraceMs: 100, sweepIntervalMs: 60_000, maxEntries: 1000 });
    cache.set('a', 'eins');
    check(cache.get('a')?.value === 'eins', 'ein Eintrag laesst sich lesen');
    await sleep(80);
    check(cache.get('a') !== undefined, 'ein ABGELAUFENER Eintrag bleibt lesbar (stale-while-revalidate braucht das)');
    check((cache.get('a')?.expiresAt ?? 0) < Date.now(), '... ist aber als abgelaufen erkennbar');
    check(cache.sweep() === 0, 'der Kehrbesen nimmt ihn noch nicht (Schonfrist laeuft)');
    await sleep(120);
    check(cache.sweep() === 1, 'nach der Schonfrist raeumt er ihn weg (frueher: blieb bis zum Neustart)');
    check(cache.size === 0, 'der Zwischenspeicher ist leer');

    for (let i = 0; i < 5000; i += 1) cache.set(`k${i}`, 'x');
    check(cache.size <= 1000, `die harte Obergrenze haelt: 5000 gesetzt, ${cache.size} behalten`);
    check(cache.get('k4999') !== undefined, 'der JUENGSTE Eintrag ist noch da');
    check(cache.get('k0') === undefined, 'der aelteste ist herausgefallen');
    cache.stop();

    // ═══════════════ FIX 16 + 17 brauchen ein Konto bzw. die Datenbank ═══════
    const admin = (await prisma.employee.findFirst({
        where: { deletedAt: null, isActive: true, employeeRoles: { some: { role: { isSystemAdmin: true } } } },
        select: { tenantId: true },
    }))!;
    const email = `perf-test-${nanoid(6).toLowerCase()}@offitec.test`;
    const person = await prisma.employee.create({
        data: {
            id: nanoid(), tenantId: admin.tenantId, firstName: 'Leistungs', lastName: 'Test',
            email, passwordHash: await crypto.hashPassword(PASSWORD), isActive: true,
        },
        select: { id: true },
    });

    try {
        console.log('\n════ FIX 16 — der Kennwortwunsch ist kein unbegrenztes Kennwortorakel ════');

        const loginRes = await fetch(`${BASE}/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: PASSWORD }),
        });
        const cookies = (loginRes.headers.getSetCookie?.() || [])
            .map((c) => c.split(';')[0]).join('; ');
        const csrf = /ofi_csrf=([^;]+)/.exec(cookies)?.[1] || '';
        check(loginRes.status === 200 && Boolean(cookies), 'Testkonto angemeldet');

        const postRequest = (currentPassword: string, newPassword: string) => fetch(`${BASE}/password-requests`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookies, 'X-CSRF-Token': csrf },
            body: JSON.stringify({ currentPassword, newPassword }),
        });

        // Der GELUNGENE Weg zuerst: er kostet den Zaehler nichts.
        const goodStarted = Date.now();
        const good = await postRequest(PASSWORD, 'NeuesKennwort1!');
        const goodMs = Date.now() - goodStarted;
        check(good.status === 201 || good.status === 200, `ein berechtigter Wunsch geht durch (${good.status})`);

        const badStarted = Date.now();
        const bad = await postRequest('FalschFalsch1!', 'NeuesKennwort1!');
        const badMs = Date.now() - badStarted;
        check(bad.status === 400, 'ein falsches bisheriges Kennwort wird abgewiesen (400)');
        note(`Dauer: richtig ${goodMs} ms (2 Vergleiche + 1 Hash), falsch ${badMs} ms (1 Vergleich)`);
        check(badMs * 1.5 < goodMs, 'der falsche Weg kostet spuerbar weniger — der zweite Vergleich laeuft erst nach dem ersten');

        let sawTooMany = false;
        let attempts = 0;
        for (let i = 0; i < 14 && !sawTooMany; i += 1) {
            attempts += 1;
            const res = await postRequest('FalschFalsch1!', 'NeuesKennwort1!');
            if (res.status === 429) sawTooMany = true;
        }
        check(sawTooMany, `nach ${attempts} Fehlversuchen bremst der Zaehler (429) — frueher: unbegrenzt`);
        check(attempts <= 12, `und zwar bald genug (${attempts} Versuche)`);

        // ═══════════════ FIX 17 — OSP-Webhooks ═══════════════════════════════
        console.log('\n════ FIX 17 — die Webhooks fragen die Datenbank erst nach der Pruefung ════');

        invalidateOspWebhookKeys();
        const first = await armedWebhookKeys();
        const second = await armedWebhookKeys();
        check(first === second, 'der zweite Aufruf liefert DIESELBE Liste — keine zweite Datenbankabfrage');
        invalidateOspWebhookKeys();
        const third = await armedWebhookKeys();
        check(third !== first, 'nach dem Leeren wird frisch gelesen (ein geaenderter Schluessel gilt sofort)');

        const anon = await fetch(`${BASE}/osp/webhook`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        check([401, 503].includes(anon.status), `ein Aufruf ohne Schluessel wird abgewiesen (${anon.status})`);
        const policy = anon.headers.get('ratelimit-policy') || '';
        check(policy.startsWith('120;'), `die Webhook-Adresse traegt jetzt eine Bremse (${policy || 'keine'}) — frueher: unbegrenzt`);
    } finally {
        await (prisma as any).passwordChangeRequest.deleteMany({ where: { employeeId: person.id } });
        await (prisma as any).refreshSession.deleteMany({ where: { employeeId: person.id } });
        await prisma.employee.delete({ where: { id: person.id } });
        console.log('\n(Testkonto entfernt)');
    }

    console.log(`\n${failures === 0 ? 'Alle Pruefungen bestanden.' : `${failures} FEHLGESCHLAGEN.`}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
