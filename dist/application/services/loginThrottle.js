"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loginThrottleSize = exports.resetLoginThrottle = exports.clearLoginFailures = exports.recordLoginFailure = exports.assertLoginAllowed = void 0;
const AuthErrors_1 = require("../errors/AuthErrors");
/**
 * ── SPERRE JE KONTO, NICHT JE ADRESSE ───────────────────────────────────────
 *
 * `loginRateLimiter` zählt Fehlversuche PRO IP: 20 in 15 Minuten. Gegen einen
 * Angreifer auf EINEM Anschluss reicht das — gegen den üblichen Fall aber
 * nicht: wer ein Kennwort raten will, verteilt die Versuche auf viele
 * Anschlüsse (Botnetz, offene Weiterleitungen, Mobilfunk-Adressen). Jede
 * Adresse blieb dann unter der Schwelle, und auf DAS EINE Konto prasselten
 * beliebig viele Versuche ein. Eine Kontosperre gab es nicht, eine zweite
 * Stufe (MFA) auch nicht.
 *
 * Dieser Zähler hängt deshalb am KONTO, quer über alle Adressen. Nach
 * `MAX_FAILURES` Fehlversuchen wird zugemacht, und zwar mit wachsender
 * Wartezeit: der elfte Versuch kostet eine halbe Stunde. Raten hört damit auf,
 * eine Frage der Anzahl zu sein, und wird eine Frage der Zeit.
 *
 * ── GEZÄHLT WIRD DIE EINGEGEBENE ADRESSE, NICHT DAS GEFUNDENE KONTO ─────────
 * Sonst wäre die Sperre selbst eine Auskunft: nur echte Konten liessen sich
 * sperren, und wer eine Sperre auslösen kann, wüsste damit, dass es die Adresse
 * gibt. Gezählt wird darum die Zeichenkette, die geschickt wurde — ob es dazu
 * ein Konto gibt, spielt hier keine Rolle.
 *
 * ── WARUM IM SPEICHER ───────────────────────────────────────────────────────
 * Wie beim IP-Zähler (RateLimitMiddleware) und der IT-Schleuse: ein Neustart
 * setzt zurück. Für einen verteilten Rateangriff ist das unerheblich — er läuft
 * über Stunden, Neustarts sind selten. Für mehrere Instanzen gilt dieselbe
 * Anmerkung wie dort: dann gehört der Zähler in eine gemeinsame Ablage.
 *
 * ── DER SCHLÜSSEL KOMMT VOM ANGREIFER ───────────────────────────────────────
 * Beliebig viele erfundene Adressen hiessen ohne Grenze beliebig viele
 * Einträge — der Zähler wäre selbst der Angriff. Darum wird beim Schreiben
 * aufgeräumt und die Menge hart gedeckelt (ältester Eintrag fliegt).
 */
/** Ab hier wird zugemacht. */
const MAX_FAILURES = 5;
/** Fehlversuche, die länger zurückliegen, zählen nicht mehr mit. */
const FAILURE_WINDOW_MS = 30 * 60_000;
/** Erste Wartezeit; danach verdoppelt sie sich je weiterem Fehlversuch. */
const BASE_LOCK_MS = 60_000;
/** Länger als das wird nie gesperrt — sonst sperrt ein Angreifer Leute aus. */
const MAX_LOCK_MS = 30 * 60_000;
/** Obergrenze der beobachteten Adressen (siehe oben). */
const MAX_TRACKED = 10_000;
const records = new Map();
/** Dieselbe Adresse in anderer Schreibweise ist dasselbe Konto. */
const keyOf = (email) => String(email ?? '').trim().toLowerCase();
/** Wann ein Eintrag nichts mehr aussagt und weg darf. */
const isStale = (record, now) => record.lockedUntil <= now && now - record.lastFailureAt > FAILURE_WINDOW_MS;
const prune = (now) => {
    for (const [key, record] of records) {
        if (isStale(record, now))
            records.delete(key);
    }
    // Immer noch zu viele (ein Angriff läuft gerade): die ältesten fliegen.
    if (records.size > MAX_TRACKED) {
        const oldestFirst = [...records.entries()].sort((a, b) => a[1].lastFailureAt - b[1].lastFailureAt);
        for (const [key] of oldestFirst.slice(0, records.size - MAX_TRACKED))
            records.delete(key);
    }
};
/** Wartezeit nach `failures` Fehlversuchen: 1, 2, 4, 8, 16, … Minuten. */
const lockDurationFor = (failures) => {
    const steps = Math.max(0, failures - MAX_FAILURES);
    return Math.min(BASE_LOCK_MS * 2 ** steps, MAX_LOCK_MS);
};
/**
 * Wirft, solange das Konto gesperrt ist. Steht VOR der Kennwortprüfung: die
 * Sperre soll keinen bcrypt-Durchgang mehr kosten (jeder kostet einen der vier
 * Arbeitsfäden von libuv — siehe die Anmerkung zur Anmeldelast).
 */
const assertLoginAllowed = (email) => {
    const record = records.get(keyOf(email));
    if (!record)
        return;
    const now = Date.now();
    if (record.lockedUntil > now) {
        const retryAfterSeconds = Math.ceil((record.lockedUntil - now) / 1000);
        const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
        throw new AuthErrors_1.TooManyAttemptsError(`Çok fazla hatalı giriş denemesi. Lütfen ${minutes} dakika sonra tekrar deneyin.`, retryAfterSeconds);
    }
};
exports.assertLoginAllowed = assertLoginAllowed;
/** Ein Fehlversuch — unabhängig davon, ob es die Adresse überhaupt gibt. */
const recordLoginFailure = (email) => {
    const key = keyOf(email);
    if (!key)
        return;
    const now = Date.now();
    const existing = records.get(key);
    // Ein Eintrag, dessen letzter Fehlversuch aus dem Fenster gelaufen ist,
    // fängt von vorne an — sonst summierten sich Vertipper über Wochen.
    const failures = existing && now - existing.lastFailureAt <= FAILURE_WINDOW_MS
        ? existing.failures + 1
        : 1;
    records.set(key, {
        failures,
        lastFailureAt: now,
        lockedUntil: failures >= MAX_FAILURES ? now + lockDurationFor(failures) : 0,
    });
    if (records.size > MAX_TRACKED)
        prune(now);
};
exports.recordLoginFailure = recordLoginFailure;
/** Richtiges Kennwort: der Zähler dieses Kontos ist erledigt. */
const clearLoginFailures = (email) => {
    records.delete(keyOf(email));
};
exports.clearLoginFailures = clearLoginFailures;
/** Nur für Tests / Diagnose. */
const resetLoginThrottle = () => records.clear();
exports.resetLoginThrottle = resetLoginThrottle;
const loginThrottleSize = () => records.size;
exports.loginThrottleSize = loginThrottleSize;
//# sourceMappingURL=loginThrottle.js.map