"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireCsrfOnPublicAuth = exports.CSRF_FAILED_MESSAGE = exports.csrfDoubleSubmitOk = void 0;
const authCookies_1 = require("../utils/authCookies");
const runtime_1 = require("../../infrastructure/config/runtime");
/**
 * ── DOPPELVORLAGE (double submit) AN EINER STELLE ───────────────────────────
 *
 * Der Vergleich stand bisher nur in `requireAuth`. Er gehört aber auch vor die
 * vier Wege, die AUSSERHALB von `requireAuth` liegen — Anmeldung, QR-Anmeldung,
 * Erneuerung, Abmeldung —, und zwei Kopien desselben Vergleichs laufen
 * erfahrungsgemäss auseinander. Deshalb hier, einmal.
 */
const csrfDoubleSubmitOk = (req) => {
    const cookie = req.cookies?.[authCookies_1.CSRF_COOKIE];
    const header = req.header('x-csrf-token');
    return Boolean(cookie && header && cookie === header);
};
exports.csrfDoubleSubmitOk = csrfDoubleSubmitOk;
exports.CSRF_FAILED_MESSAGE = 'CSRF doğrulaması başarısız. Sayfayı yenileyip tekrar deneyin.';
/**
 * Schützt die Anmeldewege, die keine Sitzung voraussetzen und deshalb nie durch
 * `requireAuth` liefen: `/auth/login`, `/auth/qr-login`, `/auth/refresh`,
 * `/auth/logout`.
 *
 * WARUM DAS ÜBERHAUPT ETWAS SCHÜTZT, obwohl noch niemand angemeldet ist:
 *
 *  • Abmeldung und Erneuerung sind Zustandsänderungen an einer FREMDEN Sitzung.
 *    Eine beliebige Seite konnte den Besucher aus der Anwendung werfen oder
 *    seine Erneuerung auslösen (und damit sein Erneuerungstoken verbrauchen).
 *  • Bei der Anmeldung ist der Angriff der umgekehrte: die fremde Seite meldet
 *    den Besucher an EINEM KONTO DES ANGREIFERS an. Was er danach im guten
 *    Glauben erfasst — Offerten, Kundendaten, Anhänge — landet in dessen
 *    Mandant.
 *
 * HEUTE trägt `SameSite=Lax`: der Browser schickt bei einem fremden POST gar
 * keinen Keks mit. Die Prüfung greift deshalb nur, wenn dieser Schutz
 * abgeschaltet ist — `OFFITEC_COOKIE_SAMESITE=none`, der Ausweg für die
 * Schreibtischanwendung, die die Schnittstelle von `file://` aus aufruft.
 * Genau dann ist sie der einzige Schutz, den es noch gibt.
 *
 * Die Bedingung ist Absicht: unter `Lax` würde eine harte Pflicht jeden
 * Aufrufer ohne Keks aussperren — Swagger, `curl`, die Gesundheitsprüfung —
 * ohne dass ein Angriff überhaupt möglich wäre.
 */
const requireCsrfOnPublicAuth = (req, res, next) => {
    if ((0, runtime_1.cookieSameSite)() !== 'none') {
        next();
        return;
    }
    if (!(0, exports.csrfDoubleSubmitOk)(req)) {
        res.status(403).json({ error: exports.CSRF_FAILED_MESSAGE });
        return;
    }
    next();
};
exports.requireCsrfOnPublicAuth = requireCsrfOnPublicAuth;
//# sourceMappingURL=CsrfMiddleware.js.map