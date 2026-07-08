import { Request, Response, NextFunction } from 'express';

/**
 * Minimal dependency-free fixed-window rate limiter (per client IP).
 *
 * Intended for low-volume, security-sensitive endpoints such as login, where the
 * goal is to slow down credential brute-force / enumeration rather than to provide
 * precise global throttling. State is in-memory (per process); for a multi-instance
 * deployment put a shared limiter (Redis) in front instead.
 */
interface RateLimitOptions {
    windowMs: number;
    max: number;
    message?: string;
}

interface Bucket {
    count: number;
    resetAt: number;
}

export const rateLimit = ({ windowMs, max, message }: RateLimitOptions) => {
    const buckets = new Map<string, Bucket>();

    // Opportunistic cleanup so the map can't grow unbounded from one-off IPs.
    const sweep = (now: number) => {
        if (buckets.size < 5000) return;
        for (const [key, bucket] of buckets) {
            if (bucket.resetAt <= now) buckets.delete(key);
        }
    };

    return (req: Request, res: Response, next: NextFunction): void => {
        const now = Date.now();
        const key = req.ip || req.socket.remoteAddress || 'unknown';

        let bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            bucket = { count: 0, resetAt: now + windowMs };
            buckets.set(key, bucket);
            sweep(now);
        }

        bucket.count += 1;

        if (bucket.count > max) {
            const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
            res.setHeader('Retry-After', String(retryAfterSec));
            res.status(429).json({
                error: message || 'Çok fazla istek gönderildi. Lütfen daha sonra tekrar deneyin.',
            });
            return;
        }

        next();
    };
};
