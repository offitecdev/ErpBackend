import { Request, Response, NextFunction } from 'express';
import { CSRF_COOKIE } from '../utils/authCookies';
import { cookieSameSite } from '../../infrastructure/config/runtime';

/**
 * ── DOPPELVORLAGE (double submit) AN EINER STELLE ───────────────────────────
 *
 * Der Vergleich stand bisher nur in `requireAuth`. Er gehört aber auch vor die
 * vier Wege, die AUSSERHALB von `requireAuth` liegen — Anmeldung, QR-Anmeldung,
 * Erneuerung, Abmeldung —, und zwei Kopien desselben Vergleichs laufen
 * erfahrungsgemäss auseinander. Deshalb hier, einmal.
 */
export const csrfDoubleSubmitOk = (req: Request): boolean => {
    const cookie = req.cookies?.[CSRF_COOKIE];
    const header = req.header('x-csrf-token');
    return Boolean(cookie && header && cookie === header);
};

export const CSRF_FAILED_MESSAGE = 'CSRF doğrulaması başarısız. Sayfayı yenileyip tekrar deneyin.';

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
export const requireCsrfOnPublicAuth = (req: Request, res: Response, next: NextFunction): void => {
    if (cookieSameSite() !== 'none') {
        next();
        return;
    }
    if (!csrfDoubleSubmitOk(req)) {
        res.status(403).json({ error: CSRF_FAILED_MESSAGE });
        return;
    }
    next();
};
