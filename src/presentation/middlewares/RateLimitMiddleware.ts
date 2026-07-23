import { Request, Response } from 'express';
import { rateLimit as expressRateLimit } from 'express-rate-limit';

/**
 * Rate limiting via express-rate-limit (fixed-window, per client IP), used on
 * security-sensitive endpoints (login, refresh, mail flows, public booking) to
 * blunt brute-force and enumeration.
 *
 * The local wrapper keeps the original `rateLimit({ windowMs, max, message })`
 * call-site API. State is in-memory (per process); for a multi-instance
 * deployment plug a shared store (e.g. rate-limit-redis) into the options here.
 */
interface RateLimitOptions {
    windowMs: number;
    max: number;
    message?: string;
    /** Only count failed (4xx/5xx) requests toward the limit. */
    skipSuccessfulRequests?: boolean;
}

export const rateLimit = ({ windowMs, max, message, skipSuccessfulRequests }: RateLimitOptions) =>
    expressRateLimit({
        windowMs,
        limit: max,
        skipSuccessfulRequests: skipSuccessfulRequests ?? false,
        standardHeaders: 'draft-7', // RateLimit-* headers (incl. Retry-After semantics)
        legacyHeaders: false,
        handler: (_req: Request, res: Response) => {
            res.status(429).json({
                error: message || 'Çok fazla istek gönderildi. Lütfen daha sonra tekrar deneyin.',
            });
        },
    });
