import crypto from 'crypto';
import { Response } from 'express';
import { cookieSameSite, isProduction } from '../../infrastructure/config/runtime';

/**
 * Tokens travel exclusively in HttpOnly cookies — they are never part of a
 * JSON response body, so page JavaScript (and therefore XSS payloads) can
 * never read them.
 *
 * - HttpOnly: invisible to document.cookie
 * - Secure: only sent over HTTPS (disabled for local http development)
 * - SameSite=Lax: not sent on cross-site requests → CSRF mitigation
 *   (override via OFFITEC_COOKIE_SAMESITE=none for the Electron desktop
 *   build, which calls the API cross-site from file://)
 */
export const ACCESS_COOKIE = 'ofi_access';
export const REFRESH_COOKIE = 'ofi_refresh';
/**
 * CSRF double-submit cookie: deliberately NOT HttpOnly — the frontend reads it
 * and echoes it in the X-CSRF-Token header on mutations. A cross-site page can
 * make the browser SEND cookies but can never READ them, so it can't forge the
 * header. Contains only random bytes, never anything secret about the session.
 */
export const CSRF_COOKIE = 'ofi_csrf';
/**
 * Die halbe Anmeldung: Kennwort stimmt, der Einmalcode fehlt noch. Trägt das
 * `mfa`-Zwischentoken (siehe MfaUseCases) und ist genauso HttpOnly wie die
 * beiden Sitzungskeks — es gehört nicht in den Antwortkörper, wo eine
 * Skriptlücke es lesen könnte. Bei der EINRICHTUNG trägt es zusätzlich das
 * vorgeschlagene Geheimnis, das die Oberfläche als QR-Bild zeigt.
 */
export const MFA_COOKIE = 'ofi_mfa';

const ACCESS_MAX_AGE_MS = 15 * 60 * 1000;           // mirrors the 15m access TTL
const REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // mirrors the 30d refresh TTL
/** Muss zur Laufzeit von `TOKEN_TTL.mfa` in JwtTokenService passen. */
const MFA_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Beide Werte kommen aus `infrastructure/config/runtime`, wo sie beim Start
 * gegen eine feste Liste geprüft werden. Hier stand vorher
 * `process.env.OFFITEC_ENV === 'production'` — ein Vergleich auf eine
 * ungeprüfte Zeichenkette, an dem das ganze Secure-Merkmal hing.
 */
const cookieOptions = () => {
    const sameSite = cookieSameSite();
    // SameSite=None requires Secure per browser rules.
    const secure = isProduction() || sameSite === 'none';
    return { httpOnly: true, secure, sameSite, path: '/' } as const;
};

/** Frischer Zufallswert für den Doppelvorlage-Keks (double submit). */
const newCsrfValue = () => crypto.randomBytes(32).toString('hex');

/**
 * Setzt NUR den CSRF-Keks — ohne Sitzung, für die Wege VOR der Anmeldung.
 *
 * Anmeldung, QR-Anmeldung, Erneuerung und Abmeldung liegen ausserhalb von
 * `requireAuth` und wurden deshalb nie auf die Doppelvorlage geprüft. Solange
 * `SameSite=Lax` gilt, trägt das: der Browser schickt bei einem fremden POST
 * gar keinen Keks mit. Für die Schreibtischanwendung gibt es aber
 * `OFFITEC_COOKIE_SAMESITE=none` — und dann fehlt der Schutz. Damit die Prüfung
 * dort greifen KANN, braucht die Anmeldeseite einen Keks, bevor es eine
 * Sitzung gibt; den holt sie sich über `GET /auth/csrf`.
 */
export const issueCsrfCookie = (res: Response): string => {
    const base = cookieOptions();
    const value = newCsrfValue();
    res.cookie(CSRF_COOKIE, value, { ...base, httpOnly: false, maxAge: REFRESH_MAX_AGE_MS });
    return value;
};

/**
 * Setzt den Keks der halben Anmeldung. Ein FRISCHER Doppelvorlage-Keks kommt
 * mit: unter `SameSite=none` prüft `requireCsrfOnPublicAuth` auch die
 * Codeeingabe, und wer die Anmeldeseite erst nach längerer Zeit öffnet, hat
 * sonst keinen gültigen Wert zum Mitschicken.
 */
export const setMfaCookie = (res: Response, challengeToken: string) => {
    const base = cookieOptions();
    res.cookie(MFA_COOKIE, challengeToken, { ...base, maxAge: MFA_MAX_AGE_MS });
    res.cookie(CSRF_COOKIE, newCsrfValue(), { ...base, httpOnly: false, maxAge: REFRESH_MAX_AGE_MS });
};

/** Nach gelungener Codeeingabe — und bei jedem Fehlschlag, der von vorne anfängt. */
export const clearMfaCookie = (res: Response) => {
    res.clearCookie(MFA_COOKIE, cookieOptions());
};

export const setAuthCookies = (res: Response, tokens: { accessToken: string; refreshToken: string }) => {
    const base = cookieOptions();
    // Die halbe Anmeldung ist damit erledigt; ihr Keks hat nichts mehr zu suchen.
    res.clearCookie(MFA_COOKIE, base);
    res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...base, maxAge: ACCESS_MAX_AGE_MS });
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, { ...base, maxAge: REFRESH_MAX_AGE_MS });
    // Fresh CSRF token with every cookie issue (login + each refresh rotation).
    res.cookie(CSRF_COOKIE, newCsrfValue(), {
        ...base,
        httpOnly: false,
        maxAge: REFRESH_MAX_AGE_MS,
    });
};

export const clearAuthCookies = (res: Response) => {
    const base = cookieOptions();
    res.clearCookie(ACCESS_COOKIE, base);
    res.clearCookie(REFRESH_COOKIE, base);
    res.clearCookie(MFA_COOKIE, base);
    res.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false });
};
