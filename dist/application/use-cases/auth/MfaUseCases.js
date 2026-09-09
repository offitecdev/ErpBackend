"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTooManyAttempts = exports.VerifyMfaCodeUseCase = exports.buildMfaChallenge = exports.MfaError = void 0;
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const JwtTokenService_1 = require("../../../infrastructure/services/JwtTokenService");
const totpCrypto_1 = require("../../../infrastructure/services/totpCrypto");
const totp_1 = require("../../../shared/totp");
const AuthErrors_1 = require("../../errors/AuthErrors");
const loginThrottle_1 = require("../../services/loginThrottle");
const sessionIssuer_1 = require("./sessionIssuer");
/**
 * ── DER ZWEITE FAKTOR ───────────────────────────────────────────────────────
 *
 * Die Anmeldung zerfällt seit dem 29.09.2026 in zwei Hälften:
 *
 *   1. E-Mail + Kennwort  →  KEINE Sitzung, sondern ein Zwischentoken
 *      (`mfa`, eigenes Geheimnis, zehn Minuten) im Keks `ofi_mfa`.
 *   2. Sechsstelliger Code aus der Authenticator-App  →  jetzt erst die
 *      Sitzung (Zugangs- und Erneuerungstoken, wie bisher).
 *
 * Ein gestohlenes Kennwort allein öffnet damit nichts mehr. Das ist die
 * einzige Massnahme, die gegen den Fall wirkt, gegen den weder Zähler noch
 * Sperren helfen: das Kennwort ist woanders abgeflossen und der Angreifer
 * kennt es einfach.
 *
 * ── WARUM DIE EINRICHTUNG IM ANMELDEWEG STECKT ──────────────────────────────
 * Der Faktor gilt für JEDE Anmeldung, auch die erste. Wer noch kein Geheimnis
 * hat, bekommt darum in Schritt 1 ein VORGESCHLAGENES mitgeliefert (als
 * QR-Bild und zum Abtippen) und richtet es sofort ein; geschrieben wird es
 * erst, wenn der erste Code stimmt. Es muss also niemand vorher etwas
 * verteilen, freischalten oder anlegen — und es gibt keinen Zustand
 * "eingerichtet, aber nie bestätigt".
 *
 * Der Vorschlag reist im signierten Zwischentoken mit, nicht in der Datenbank:
 * ein abgebrochener Versuch hinterlässt dann nichts, und beim nächsten Anlauf
 * wird schlicht ein neuer vorgeschlagen. Ein Geheimnis vor dem Aufrufer ist er
 * ohnehin nicht — er soll es ja gerade scannen.
 *
 * ── WAS AN DIE OBERFLÄCHE DARF ──────────────────────────────────────────────
 * Fehler tragen zusätzlich eine feste `code`-Marke. Die Meldungstexte sind
 * türkisch (wie im ganzen Anmeldeweg); die Oberfläche übersetzt anhand der
 * Marke in die Sprache der Person, statt Servertexte anzuzeigen.
 */
/** Was in der QR-Adresse als Aussteller steht — der Name neben dem Code in Aegis. */
const TOTP_ISSUER = 'Offitec Control Center';
class MfaError extends AuthErrors_1.PublicError {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'MfaError';
    }
}
exports.MfaError = MfaError;
/**
 * Der Zähler des zweiten Faktors hängt an der KENNUNG, nicht an der E-Mail:
 * wer hier steht, hat sein Kennwort schon richtig eingegeben — welches Konto
 * gemeint ist, steht damit fest, und ein eigener Schlüsselraum hält die
 * Codeversuche von den Kennwortversuchen getrennt (siehe loginThrottle).
 */
const throttleKey = (employeeId) => `mfa:${employeeId}`;
/**
 * Baut die zweite Hälfte der Anmeldung auf. Wird von `LoginUseCase` aufgerufen,
 * sobald das Kennwort stimmt und das Konto in Ordnung ist.
 */
const buildMfaChallenge = (tokenService, employee) => {
    const stored = (0, totpCrypto_1.decryptTotpSecret)(employee.totpSecret);
    // Nicht lesbar (verdrehter Hauptschlüssel, verfälschte Zeile) zählt wie
    // "nicht eingerichtet": die Anmeldung führt dann durch die Einrichtung,
    // statt mit einem Serverfehler stehenzubleiben.
    const enrolled = Boolean(employee.totpEnabledAt && stored);
    const secret = enrolled ? stored : (0, totp_1.generateTotpSecret)();
    const challengeToken = tokenService.generateToken('mfa', {
        id: employee.id,
        tenantId: employee.tenantId,
        email: employee.email,
        // Wie jedes andere Token an `passwordChangedAt` gebunden: ein
        // Kennwortwechsel zwischen den beiden Hälften macht das Zwischentoken
        // wertlos.
        pwdAt: (0, JwtTokenService_1.toPwdAtClaim)(employee.passwordChangedAt),
        mfaStage: enrolled ? 'verify' : 'enroll',
        // Nur bei der Einrichtung: der Vorschlag, den die Oberfläche gerade als
        // QR-Bild zeigt. Bei `verify` steht hier NICHTS — das eingerichtete
        // Geheimnis verlässt den Server nie wieder.
        ...(enrolled ? {} : { sec: secret }),
    });
    return {
        challengeToken,
        stage: enrolled ? 'verify' : 'enroll',
        issuer: TOTP_ISSUER,
        account: employee.email,
        digits: totp_1.TOTP_DIGITS,
        periodSeconds: totp_1.TOTP_PERIOD_SECONDS,
        ...(enrolled
            ? {}
            : {
                setup: {
                    otpauthUri: (0, totp_1.buildOtpAuthUri)({
                        secretBase32: secret,
                        account: employee.email,
                        issuer: TOTP_ISSUER,
                    }),
                    secret,
                    secretGrouped: (0, totp_1.formatSecretForReading)(secret),
                },
            }),
    };
};
exports.buildMfaChallenge = buildMfaChallenge;
/**
 * Schritt 2: den Code prüfen und — wenn er stimmt — die Sitzung ausstellen.
 */
class VerifyMfaCodeUseCase {
    tokenService;
    constructor(tokenService) {
        this.tokenService = tokenService;
    }
    async execute(challengeToken, rawCode, context = {}) {
        const token = String(challengeToken || '').trim();
        if (!token) {
            throw new MfaError('Doğrulama oturumu bulunamadı. Lütfen tekrar giriş yapın.', 'mfa_challenge_missing');
        }
        // Abgelaufen / verfälscht / für einen anderen Zweck ausgestellt: alles
        // dasselbe nach draussen — "fang von vorne an".
        let decoded;
        try {
            decoded = this.tokenService.verifyToken('mfa', token);
        }
        catch {
            throw new MfaError('Doğrulama süresi doldu. Lütfen tekrar giriş yapın.', 'mfa_challenge_expired');
        }
        const stage = decoded.mfaStage === 'enroll' ? 'enroll' : 'verify';
        /* Die Sperre steht VOR der Rechnung, und sie zählt je Konto — sechs
           Stellen sind eine Million Möglichkeiten, mit dem Toleranzfenster drei
           Treffer je Million Versuche. Ohne Zähler wäre das in Stunden zu
           durchsuchen; mit ihm hört es nach fünf Fehlversuchen für Minuten auf
           (und die Wartezeit verdoppelt sich). */
        (0, loginThrottle_1.assertLoginAllowed)(throttleKey(decoded.id));
        // Der Zustand kommt frisch aus der Datenbank: zwischen Kennwort- und
        // Codeeingabe können Minuten liegen, in denen jemand das Konto gesperrt,
        // gelöscht oder das Kennwort gewechselt hat.
        const employee = await prisma_client_1.default.employee.findUnique({
            where: { id: decoded.id },
            select: {
                id: true, tenantId: true, email: true, firstName: true, lastName: true,
                passwordChangedAt: true, isActive: true, deletedAt: true, bannedAt: true,
                totpSecret: true, totpEnabledAt: true, totpLastStep: true,
            },
        });
        const blocked = () => new MfaError('Oturum geçersiz. Lütfen tekrar giriş yapın.', 'mfa_account_blocked');
        if (!employee || employee.deletedAt || employee.bannedAt || !employee.isActive)
            throw blocked();
        // Kennwortwechsel seit Schritt 1 → das Zwischentoken gehört zu einer
        // Anmeldung, die es nicht mehr gibt.
        if ((0, JwtTokenService_1.toPwdAtClaim)(employee.passwordChangedAt) !== decoded.pwdAt)
            throw blocked();
        /* WELCHES Geheimnis gilt — und die Stelle, an der ein Angreifer sonst
           den zweiten Faktor AUSTAUSCHEN könnte: ein selbst mitgebrachtes
           `enroll`-Token darf niemals ein bereits eingerichtetes Konto
           übernehmen. Die Datenbank entscheidet, nicht das Token. */
        const storedSecret = (0, totpCrypto_1.decryptTotpSecret)(employee.totpSecret);
        const alreadyEnrolled = Boolean(employee.totpEnabledAt && storedSecret);
        if (alreadyEnrolled && stage === 'enroll')
            throw blocked();
        if (!alreadyEnrolled && stage === 'verify')
            throw blocked();
        const secret = alreadyEnrolled ? storedSecret : String(decoded.sec || '');
        if (!secret)
            throw blocked();
        const matchedStep = (0, totp_1.verifyTotpCode)(secret, rawCode, {
            // Ein Code gilt genau einmal. Bei der Einrichtung gibt es noch
            // nichts zu wiederholen.
            notBeforeStep: alreadyEnrolled ? employee.totpLastStep ?? null : null,
        });
        if (matchedStep === null) {
            (0, loginThrottle_1.recordLoginFailure)(throttleKey(employee.id));
            /* Ein Code, der zu einem SCHON BENUTZTEN Fenster gehört, ist ein
               eigener Fall: technisch richtig gerechnet, aber verbraucht. Die
               Oberfläche sagt dann "warte auf den nächsten Code", statt den
               Menschen denselben falsch abgetippten Sechser suchen zu lassen. */
            const withoutReplayGuard = (0, totp_1.verifyTotpCode)(secret, rawCode);
            if (alreadyEnrolled && withoutReplayGuard !== null) {
                throw new MfaError('Bu kod zaten kullanıldı. Uygulamadaki bir sonraki kodu bekleyin.', 'mfa_code_reused');
            }
            throw new MfaError('Kod hatalı. Uygulamadaki güncel kodu girin.', 'mfa_code_invalid');
        }
        // Der Code stimmte — der Zähler dieses Kontos ist erledigt.
        (0, loginThrottle_1.clearLoginFailures)(throttleKey(employee.id));
        /* Beim ersten richtigen Code wird die Einrichtung erst WAHR: jetzt
           wandert das Geheimnis verschlüsselt in die Zeile. Bis hierher stand
           es nur im Zwischentoken — ein abgebrochener Versuch hat nichts
           hinterlassen. */
        await prisma_client_1.default.employee.update({
            where: { id: employee.id },
            data: {
                totpLastStep: matchedStep,
                ...(alreadyEnrolled
                    ? {}
                    : { totpSecret: (0, totpCrypto_1.encryptTotpSecret)(secret), totpEnabledAt: new Date() }),
            },
        });
        const session = await (0, sessionIssuer_1.issueEmployeeSession)(this.tokenService, employee, context);
        return { ...session, enrolled: !alreadyEnrolled };
    }
}
exports.VerifyMfaCodeUseCase = VerifyMfaCodeUseCase;
/** Für den Aufrufer: eine zu-viele-Versuche-Antwort ist keine falsche Eingabe. */
const isTooManyAttempts = (error) => error instanceof AuthErrors_1.TooManyAttemptsError;
exports.isTooManyAttempts = isTooManyAttempts;
//# sourceMappingURL=MfaUseCases.js.map