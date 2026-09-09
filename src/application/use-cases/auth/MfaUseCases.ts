import prisma from '../../../infrastructure/database/prisma.client';
import { ITokenService } from '../../interfaces/ITokenService';
import { toPwdAtClaim } from '../../../infrastructure/services/JwtTokenService';
import { encryptTotpSecret, decryptTotpSecret } from '../../../infrastructure/services/totpCrypto';
import { RefreshSessionContext } from '../../../infrastructure/services/RefreshSessionService';
import {
    buildOtpAuthUri,
    formatSecretForReading,
    generateTotpSecret,
    verifyTotpCode,
    TOTP_DIGITS,
    TOTP_PERIOD_SECONDS,
} from '../../../shared/totp';
import { PublicError, TooManyAttemptsError } from '../../errors/AuthErrors';
import { assertLoginAllowed, recordLoginFailure, clearLoginFailures } from '../../services/loginThrottle';
import { issueEmployeeSession, SessionEmployee } from './sessionIssuer';

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

/** Feste Marken für die Oberfläche (siehe oben). */
export type MfaErrorCode =
    | 'mfa_challenge_missing'
    | 'mfa_challenge_expired'
    | 'mfa_code_invalid'
    | 'mfa_code_reused'
    | 'mfa_account_blocked';

export class MfaError extends PublicError {
    constructor(message: string, public readonly code: MfaErrorCode) {
        super(message);
        this.name = 'MfaError';
    }
}

/** Was Schritt 1 der Oberfläche mitgibt. */
export interface MfaChallenge {
    /** Gehört in den `ofi_mfa`-Keks, nie in den Antwortkörper. */
    challengeToken: string;
    /** `verify` = Code eingeben. `enroll` = erst einrichten, dann Code eingeben. */
    stage: 'verify' | 'enroll';
    issuer: string;
    account: string;
    digits: number;
    periodSeconds: number;
    /** Nur bei `enroll`: was gescannt bzw. abgetippt wird. */
    setup?: {
        otpauthUri: string;
        secret: string;
        secretGrouped: string;
    };
}

/** Die Felder, die der zweite Faktor von einer Person braucht. */
export interface MfaEmployee extends SessionEmployee {
    totpSecret?: string | null | undefined;
    totpEnabledAt?: Date | null | undefined;
    totpLastStep?: number | null | undefined;
}

/**
 * Der Zähler des zweiten Faktors hängt an der KENNUNG, nicht an der E-Mail:
 * wer hier steht, hat sein Kennwort schon richtig eingegeben — welches Konto
 * gemeint ist, steht damit fest, und ein eigener Schlüsselraum hält die
 * Codeversuche von den Kennwortversuchen getrennt (siehe loginThrottle).
 */
const throttleKey = (employeeId: string) => `mfa:${employeeId}`;

/**
 * Baut die zweite Hälfte der Anmeldung auf. Wird von `LoginUseCase` aufgerufen,
 * sobald das Kennwort stimmt und das Konto in Ordnung ist.
 */
export const buildMfaChallenge = (tokenService: ITokenService, employee: MfaEmployee): MfaChallenge => {
    const stored = decryptTotpSecret(employee.totpSecret);
    // Nicht lesbar (verdrehter Hauptschlüssel, verfälschte Zeile) zählt wie
    // "nicht eingerichtet": die Anmeldung führt dann durch die Einrichtung,
    // statt mit einem Serverfehler stehenzubleiben.
    const enrolled = Boolean(employee.totpEnabledAt && stored);
    const secret = enrolled ? (stored as string) : generateTotpSecret();

    const challengeToken = tokenService.generateToken('mfa', {
        id: employee.id,
        tenantId: employee.tenantId,
        email: employee.email,
        // Wie jedes andere Token an `passwordChangedAt` gebunden: ein
        // Kennwortwechsel zwischen den beiden Hälften macht das Zwischentoken
        // wertlos.
        pwdAt: toPwdAtClaim(employee.passwordChangedAt),
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
        digits: TOTP_DIGITS,
        periodSeconds: TOTP_PERIOD_SECONDS,
        ...(enrolled
            ? {}
            : {
                  setup: {
                      otpauthUri: buildOtpAuthUri({
                          secretBase32: secret,
                          account: employee.email,
                          issuer: TOTP_ISSUER,
                      }),
                      secret,
                      secretGrouped: formatSecretForReading(secret),
                  },
              }),
    };
};

/**
 * Schritt 2: den Code prüfen und — wenn er stimmt — die Sitzung ausstellen.
 */
export class VerifyMfaCodeUseCase {
    constructor(private tokenService: ITokenService) {}

    async execute(challengeToken: string, rawCode: string, context: RefreshSessionContext = {}) {
        const token = String(challengeToken || '').trim();
        if (!token) {
            throw new MfaError('Doğrulama oturumu bulunamadı. Lütfen tekrar giriş yapın.', 'mfa_challenge_missing');
        }

        // Abgelaufen / verfälscht / für einen anderen Zweck ausgestellt: alles
        // dasselbe nach draussen — "fang von vorne an".
        let decoded;
        try {
            decoded = this.tokenService.verifyToken('mfa', token);
        } catch {
            throw new MfaError('Doğrulama süresi doldu. Lütfen tekrar giriş yapın.', 'mfa_challenge_expired');
        }

        const stage = decoded.mfaStage === 'enroll' ? 'enroll' : 'verify';

        /* Die Sperre steht VOR der Rechnung, und sie zählt je Konto — sechs
           Stellen sind eine Million Möglichkeiten, mit dem Toleranzfenster drei
           Treffer je Million Versuche. Ohne Zähler wäre das in Stunden zu
           durchsuchen; mit ihm hört es nach fünf Fehlversuchen für Minuten auf
           (und die Wartezeit verdoppelt sich). */
        assertLoginAllowed(throttleKey(decoded.id));

        // Der Zustand kommt frisch aus der Datenbank: zwischen Kennwort- und
        // Codeeingabe können Minuten liegen, in denen jemand das Konto gesperrt,
        // gelöscht oder das Kennwort gewechselt hat.
        const employee = await prisma.employee.findUnique({
            where: { id: decoded.id },
            select: {
                id: true, tenantId: true, email: true, firstName: true, lastName: true,
                passwordChangedAt: true, isActive: true, deletedAt: true, bannedAt: true,
                totpSecret: true, totpEnabledAt: true, totpLastStep: true,
            },
        });

        const blocked = () =>
            new MfaError('Oturum geçersiz. Lütfen tekrar giriş yapın.', 'mfa_account_blocked');

        if (!employee || employee.deletedAt || employee.bannedAt || !employee.isActive) throw blocked();
        // Kennwortwechsel seit Schritt 1 → das Zwischentoken gehört zu einer
        // Anmeldung, die es nicht mehr gibt.
        if (toPwdAtClaim(employee.passwordChangedAt) !== decoded.pwdAt) throw blocked();

        /* WELCHES Geheimnis gilt — und die Stelle, an der ein Angreifer sonst
           den zweiten Faktor AUSTAUSCHEN könnte: ein selbst mitgebrachtes
           `enroll`-Token darf niemals ein bereits eingerichtetes Konto
           übernehmen. Die Datenbank entscheidet, nicht das Token. */
        const storedSecret = decryptTotpSecret(employee.totpSecret);
        const alreadyEnrolled = Boolean(employee.totpEnabledAt && storedSecret);

        if (alreadyEnrolled && stage === 'enroll') throw blocked();
        if (!alreadyEnrolled && stage === 'verify') throw blocked();

        const secret = alreadyEnrolled ? (storedSecret as string) : String(decoded.sec || '');
        if (!secret) throw blocked();

        const matchedStep = verifyTotpCode(secret, rawCode, {
            // Ein Code gilt genau einmal. Bei der Einrichtung gibt es noch
            // nichts zu wiederholen.
            notBeforeStep: alreadyEnrolled ? employee.totpLastStep ?? null : null,
        });

        if (matchedStep === null) {
            recordLoginFailure(throttleKey(employee.id));
            /* Ein Code, der zu einem SCHON BENUTZTEN Fenster gehört, ist ein
               eigener Fall: technisch richtig gerechnet, aber verbraucht. Die
               Oberfläche sagt dann "warte auf den nächsten Code", statt den
               Menschen denselben falsch abgetippten Sechser suchen zu lassen. */
            const withoutReplayGuard = verifyTotpCode(secret, rawCode);
            if (alreadyEnrolled && withoutReplayGuard !== null) {
                throw new MfaError(
                    'Bu kod zaten kullanıldı. Uygulamadaki bir sonraki kodu bekleyin.',
                    'mfa_code_reused',
                );
            }
            throw new MfaError('Kod hatalı. Uygulamadaki güncel kodu girin.', 'mfa_code_invalid');
        }

        // Der Code stimmte — der Zähler dieses Kontos ist erledigt.
        clearLoginFailures(throttleKey(employee.id));

        /* Beim ersten richtigen Code wird die Einrichtung erst WAHR: jetzt
           wandert das Geheimnis verschlüsselt in die Zeile. Bis hierher stand
           es nur im Zwischentoken — ein abgebrochener Versuch hat nichts
           hinterlassen. */
        await prisma.employee.update({
            where: { id: employee.id },
            data: {
                totpLastStep: matchedStep,
                ...(alreadyEnrolled
                    ? {}
                    : { totpSecret: encryptTotpSecret(secret), totpEnabledAt: new Date() }),
            },
        });

        const session = await issueEmployeeSession(this.tokenService, employee, context);
        return { ...session, enrolled: !alreadyEnrolled };
    }
}

/** Für den Aufrufer: eine zu-viele-Versuche-Antwort ist keine falsche Eingabe. */
export const isTooManyAttempts = (error: unknown): error is TooManyAttemptsError =>
    error instanceof TooManyAttemptsError;
