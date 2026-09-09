import { Request, Response } from 'express';
import { rateLimit as expressRateLimit, ipKeyGenerator } from 'express-rate-limit';

/**
 * Rate limiting via express-rate-limit (fixed-window, per client IP), used on
 * security-sensitive endpoints (login, refresh, mail flows, public booking) to
 * blunt brute-force and enumeration.
 *
 * The local wrapper keeps the original `rateLimit({ windowMs, max, message })`
 * call-site API. State is in-memory (per process); for a multi-instance
 * deployment plug a shared store (e.g. rate-limit-redis) into the options here.
 *
 * `keyBy` zählt an etwas anderem als der Adresse — siehe die Postwege in
 * auth.routes.ts: eine Grenze je Anschluss sperrte dort ein ganzes Büro hinter
 * einer NAT-Adresse aus, während sie das einzelne Postfach gar nicht schützte.
 */
interface RateLimitOptions {
    windowMs: number;
    max: number;
    message?: string;
    /** Only count failed (4xx/5xx) requests toward the limit. */
    skipSuccessfulRequests?: boolean;
    /**
     * Woran gezählt wird, wenn NICHT die Adresse des Aufrufers gemeint ist.
     * Gebraucht für die Postwege: dort schützt die Grenze das POSTFACH, nicht
     * den Anschluss — und ein ganzes Büro sitzt hinter einer Adresse.
     * `null` = diese Anfrage zählt für diesen Zähler gar nicht.
     */
    keyBy?: (req: Request) => string | null;
}

export const rateLimit = ({ windowMs, max, message, skipSuccessfulRequests, keyBy }: RateLimitOptions) =>
    expressRateLimit({
        windowMs,
        limit: max,
        skipSuccessfulRequests: skipSuccessfulRequests ?? false,
        ...(keyBy
            ? {
                // Fällt der eigene Schlüssel aus, wird auf die Adresse
                // zurückgefallen (ipKeyGenerator normalisiert IPv6-Bereiche).
                keyGenerator: (req: Request) => keyBy(req) ?? ipKeyGenerator(req.ip ?? ''),
                skip: (req: Request) => keyBy(req) === null,
            }
            : {}),
        standardHeaders: 'draft-7', // RateLimit-* headers (incl. Retry-After semantics)
        legacyHeaders: false,
        handler: (_req: Request, res: Response) => {
            res.status(429).json({
                error: message || 'Çok fazla istek gönderildi. Lütfen daha sonra tekrar deneyin.',
            });
        },
    });
