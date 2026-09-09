/**
 * Prüft die BEIDEN Hälften der Anmeldung als Ablauf — ohne Datenbank und ohne
 * Netz. Die Datenzugriffsschicht wird vor dem Laden der Anwendungsschicht durch
 * eine Attrappe im Modulzwischenspeicher ersetzt; alles darüber (Zwischentoken,
 * Einrichtung, Codeprüfung, Wiederholungsschutz, Sperre) ist echt.
 *
 * Ausführen:  npx ts-node --transpile-only scratchpad/_verify-mfa-flow.ts
 */
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

// ── Attrappe der Datenzugriffsschicht ───────────────────────────────────────
// MUSS vor jedem Modul stehen, das prisma.client lädt.
type Row = Record<string, any>;
const rows = new Map<string, Row>();

const prismaStub = {
    employee: {
        findUnique: async ({ where }: any) => {
            const row = rows.get(where.id);
            return row ? { ...row } : null;
        },
        update: async ({ where, data }: any) => {
            const row = rows.get(where.id);
            if (!row) throw new Error('Zeile fehlt');
            Object.assign(row, data);
            return { ...row };
        },
    },
    refreshSession: {
        create: async () => ({}),
        findUnique: async () => null,
        update: async () => ({}),
        updateMany: async () => ({ count: 0 }),
    },
};

const prismaPath = require.resolve('../src/infrastructure/database/prisma.client');
require.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: { __esModule: true, default: prismaStub },
} as any;

/* eslint-disable @typescript-eslint/no-var-requires */
const { JwtTokenService } = require('../src/infrastructure/services/JwtTokenService');
const { buildMfaChallenge, VerifyMfaCodeUseCase, MfaError } = require('../src/application/use-cases/auth/MfaUseCases');
const { encryptTotpSecret, decryptTotpSecret } = require('../src/infrastructure/services/totpCrypto');
const { totpCodeForStep, currentTotpStep, generateTotpSecret } = require('../src/shared/totp');
const { resetLoginThrottle } = require('../src/application/services/loginThrottle');

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failed += 1;
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${ok ? '' : `\n        erwartet ${JSON.stringify(expected)}\n        erhalten ${JSON.stringify(actual)}`}`);
};

const tokenService = new JwtTokenService();
const verifyUseCase = new VerifyMfaCodeUseCase(tokenService);

const EMPLOYEE_ID = 'emp-test-1';
const baseRow = () => ({
    id: EMPLOYEE_ID,
    tenantId: 'tenant-1',
    email: 'anna@offitec.ch',
    firstName: 'Anna',
    lastName: 'Muster',
    passwordChangedAt: new Date('2026-01-02T03:04:05.000Z'),
    isActive: true,
    deletedAt: null,
    bannedAt: null,
    totpSecret: null,
    totpEnabledAt: null,
    totpLastStep: null,
});

const seed = (overrides: Row = {}) => {
    rows.clear();
    rows.set(EMPLOYEE_ID, { ...baseRow(), ...overrides });
    resetLoginThrottle();
    return rows.get(EMPLOYEE_ID)!;
};

/** Fängt den Fehler ab und gibt seine Marke zurück (oder 'kein-fehler'). */
const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
    try {
        await run();
        return 'kein-fehler';
    } catch (error: any) {
        if (error instanceof MfaError) return error.code;
        return `${error?.name || 'Error'}: ${error?.message}`;
    }
};

const main = async () => {
    // ── 1. ERSTE ANMELDUNG: Einrichtung ─────────────────────────────────────
    let row = seed();
    let challenge = buildMfaChallenge(tokenService, row);
    check('erste Anmeldung → Einrichtung', challenge.stage, 'enroll');
    check('… mit QR-Adresse', /^otpauth:\/\/totp\/Offitec%20ERP:anna%40offitec\.ch\?secret=[A-Z2-7]{32}&/.test(challenge.setup.otpauthUri), true);
    check('… Geheimnis in Vierergruppen zum Abtippen', challenge.setup.secretGrouped, (challenge.setup.secret.match(/.{1,4}/g) || []).join(' '));
    check('… und noch NICHTS in der Datenbank', [row.totpSecret, row.totpEnabledAt], [null, null]);

    // Falscher Code bei der Einrichtung: nichts wird geschrieben.
    check('Einrichtung, falscher Code', await codeOf(() => verifyUseCase.execute(challenge.challengeToken, '000000')), 'mfa_code_invalid');
    check('… Konto bleibt uneingerichtet', [row.totpSecret, row.totpEnabledAt], [null, null]);

    // Richtiger Code: jetzt erst wird geschrieben.
    let step = currentTotpStep();
    let result = await verifyUseCase.execute(challenge.challengeToken, totpCodeForStep(challenge.setup.secret, step));
    check('Einrichtung, richtiger Code → angemeldet', Boolean(result.accessToken && result.refreshToken), true);
    check('… als Einrichtung gemeldet', result.enrolled, true);
    check('… Person in der Antwort', result.employee.id, EMPLOYEE_ID);
    check('… Geheimnis liegt verschlüsselt in der Zeile', String(row.totpSecret).startsWith('enc:v1:'), true);
    check('… und lässt sich zurücklesen', decryptTotpSecret(row.totpSecret), challenge.setup.secret);
    check('… Zeitpunkt gesetzt', row.totpEnabledAt instanceof Date, true);
    check('… Fenster gemerkt', row.totpLastStep, step);
    check('… das Klartextgeheimnis steht NICHT in der Zeile', String(row.totpSecret).includes(challenge.setup.secret), false);

    // ── 2. ZWEITE ANMELDUNG: nur noch der Code ──────────────────────────────
    const secret = generateTotpSecret();
    row = seed({ totpSecret: encryptTotpSecret(secret), totpEnabledAt: new Date(), totpLastStep: null });
    challenge = buildMfaChallenge(tokenService, row);
    check('eingerichtetes Konto → nur Code', challenge.stage, 'verify');
    check('… KEIN Geheimnis mehr nach draussen', challenge.setup, undefined);

    step = currentTotpStep();
    result = await verifyUseCase.execute(challenge.challengeToken, totpCodeForStep(secret, step));
    check('richtiger Code → angemeldet', Boolean(result.accessToken), true);
    check('… nicht als Einrichtung gemeldet', result.enrolled, false);
    check('… Fenster fortgeschrieben', row.totpLastStep, step);

    // ── 3. WIEDERHOLUNGSSCHUTZ ──────────────────────────────────────────────
    challenge = buildMfaChallenge(tokenService, row);
    check(
        'derselbe Code ein zweites Mal',
        await codeOf(() => verifyUseCase.execute(challenge.challengeToken, totpCodeForStep(secret, step))),
        'mfa_code_reused',
    );

    // ── 4. FALSCHER CODE, ZU VIELE VERSUCHE ─────────────────────────────────
    row = seed({ totpSecret: encryptTotpSecret(secret), totpEnabledAt: new Date() });
    challenge = buildMfaChallenge(tokenService, row);
    const attempts: string[] = [];
    for (let index = 0; index < 6; index += 1) {
        attempts.push(await codeOf(() => verifyUseCase.execute(challenge.challengeToken, '000000')));
    }
    check('fünf Fehlversuche zählen als falscher Code', attempts.slice(0, 5), Array(5).fill('mfa_code_invalid'));
    check('der sechste wird abgewiesen', attempts[5]?.startsWith('TooManyAttemptsError:'), true);
    // Auch der RICHTIGE Code kommt während der Sperre nicht durch.
    check(
        'Sperre gilt auch für den richtigen Code',
        (await codeOf(() => verifyUseCase.execute(challenge.challengeToken, totpCodeForStep(secret, currentTotpStep())))).startsWith('TooManyAttemptsError:'),
        true,
    );

    // ── 5. WAS NICHT GEHEN DARF ─────────────────────────────────────────────
    // (a) Ein selbst mitgebrachtes Einrichtungstoken darf ein eingerichtetes
    //     Konto NICHT übernehmen — sonst tauschte man den zweiten Faktor aus.
    row = seed({ totpSecret: encryptTotpSecret(secret), totpEnabledAt: new Date() });
    const foreignSecret = generateTotpSecret();
    const forgedEnroll = tokenService.generateToken('mfa', {
        id: EMPLOYEE_ID,
        tenantId: 'tenant-1',
        email: 'anna@offitec.ch',
        pwdAt: Math.floor(new Date('2026-01-02T03:04:05.000Z').getTime() / 1000),
        mfaStage: 'enroll',
        sec: foreignSecret,
    });
    check(
        'fremdes Einrichtungstoken auf eingerichtetem Konto',
        await codeOf(() => verifyUseCase.execute(forgedEnroll, totpCodeForStep(foreignSecret, currentTotpStep()))),
        'mfa_account_blocked',
    );
    check('… Geheimnis unverändert', decryptTotpSecret(row.totpSecret), secret);

    // (b) Ein Zugangstoken ist kein Zwischentoken (eigenes Geheimnis + typ).
    const accessToken = tokenService.generateToken('access', {
        id: EMPLOYEE_ID, tenantId: 'tenant-1', email: 'anna@offitec.ch', pwdAt: 0,
    });
    check(
        'Zugangstoken statt Zwischentoken',
        await codeOf(() => verifyUseCase.execute(accessToken, '000000')),
        'mfa_challenge_expired',
    );

    // (c) Kennwortwechsel zwischen den beiden Hälften entwertet das Zwischentoken.
    row = seed({ totpSecret: encryptTotpSecret(secret), totpEnabledAt: new Date() });
    challenge = buildMfaChallenge(tokenService, row);
    row.passwordChangedAt = new Date('2026-06-01T00:00:00.000Z');
    check(
        'Kennwortwechsel zwischen den Hälften',
        await codeOf(() => verifyUseCase.execute(challenge.challengeToken, totpCodeForStep(secret, currentTotpStep()))),
        'mfa_account_blocked',
    );

    // (d) Konto inzwischen gesperrt / gelöscht / stillgelegt.
    for (const [name, patch] of [
        ['gesperrt', { bannedAt: new Date() }],
        ['gelöscht', { deletedAt: new Date() }],
        ['stillgelegt', { isActive: false }],
    ] as const) {
        row = seed({ totpSecret: encryptTotpSecret(secret), totpEnabledAt: new Date() });
        challenge = buildMfaChallenge(tokenService, row);
        Object.assign(row, patch);
        check(
            `Konto zwischenzeitlich ${name}`,
            await codeOf(() => verifyUseCase.execute(challenge.challengeToken, totpCodeForStep(secret, currentTotpStep()))),
            'mfa_account_blocked',
        );
    }

    // (e) Gar kein Zwischentoken.
    check('kein Zwischentoken', await codeOf(() => verifyUseCase.execute('', '000000')), 'mfa_challenge_missing');

    // (f) Unlesbares Geheimnis (verdrehter Hauptschlüssel) → Einrichtung statt
    //     Serverfehler; niemand bleibt ausgesperrt.
    row = seed({ totpSecret: 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', totpEnabledAt: new Date() });
    check('unlesbares Geheimnis → Einrichtung', buildMfaChallenge(tokenService, row).stage, 'enroll');

    // ── 6. TOLERANZ DER TELEFONUHR ──────────────────────────────────────────
    row = seed({ totpSecret: encryptTotpSecret(secret), totpEnabledAt: new Date() });
    challenge = buildMfaChallenge(tokenService, row);
    result = await verifyUseCase.execute(challenge.challengeToken, totpCodeForStep(secret, currentTotpStep() - 1));
    check('Code aus dem vorigen Fenster geht durch', Boolean(result.accessToken), true);

    row = seed({ totpSecret: encryptTotpSecret(secret), totpEnabledAt: new Date() });
    challenge = buildMfaChallenge(tokenService, row);
    check(
        'Code von vor zwei Fenstern nicht',
        await codeOf(() => verifyUseCase.execute(challenge.challengeToken, totpCodeForStep(secret, currentTotpStep() - 2))),
        'mfa_code_invalid',
    );

    console.log(failed === 0 ? '\nAlle Prüfungen bestanden.' : `\n${failed} Prüfung(en) fehlgeschlagen.`);
    process.exit(failed === 0 ? 0 : 1);
};

void main();
