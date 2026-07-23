"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearAuthCookies = exports.setAuthCookies = exports.CSRF_COOKIE = exports.REFRESH_COOKIE = exports.ACCESS_COOKIE = void 0;
const crypto_1 = __importDefault(require("crypto"));
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
exports.ACCESS_COOKIE = 'ofi_access';
exports.REFRESH_COOKIE = 'ofi_refresh';
/**
 * CSRF double-submit cookie: deliberately NOT HttpOnly — the frontend reads it
 * and echoes it in the X-CSRF-Token header on mutations. A cross-site page can
 * make the browser SEND cookies but can never READ them, so it can't forge the
 * header. Contains only random bytes, never anything secret about the session.
 */
exports.CSRF_COOKIE = 'ofi_csrf';
const ACCESS_MAX_AGE_MS = 15 * 60 * 1000; // mirrors the 15m access TTL
const REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // mirrors the 30d refresh TTL
const cookieOptions = () => {
    const sameSiteEnv = (process.env.OFFITEC_COOKIE_SAMESITE || 'lax').toLowerCase();
    const sameSite = (['lax', 'strict', 'none'].includes(sameSiteEnv) ? sameSiteEnv : 'lax');
    // SameSite=None requires Secure per browser rules.
    const secure = process.env.OFFITEC_ENV === 'production' || sameSite === 'none';
    return { httpOnly: true, secure, sameSite, path: '/' };
};
const setAuthCookies = (res, tokens) => {
    const base = cookieOptions();
    res.cookie(exports.ACCESS_COOKIE, tokens.accessToken, { ...base, maxAge: ACCESS_MAX_AGE_MS });
    res.cookie(exports.REFRESH_COOKIE, tokens.refreshToken, { ...base, maxAge: REFRESH_MAX_AGE_MS });
    // Fresh CSRF token with every cookie issue (login + each refresh rotation).
    res.cookie(exports.CSRF_COOKIE, crypto_1.default.randomBytes(32).toString('hex'), {
        ...base,
        httpOnly: false,
        maxAge: REFRESH_MAX_AGE_MS,
    });
};
exports.setAuthCookies = setAuthCookies;
const clearAuthCookies = (res) => {
    const base = cookieOptions();
    res.clearCookie(exports.ACCESS_COOKIE, base);
    res.clearCookie(exports.REFRESH_COOKIE, base);
    res.clearCookie(exports.CSRF_COOKIE, { ...base, httpOnly: false });
};
exports.clearAuthCookies = clearAuthCookies;
//# sourceMappingURL=authCookies.js.map