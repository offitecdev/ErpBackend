"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimit = void 0;
const rateLimit = ({ windowMs, max, message }) => {
    const buckets = new Map();
    // Opportunistic cleanup so the map can't grow unbounded from one-off IPs.
    const sweep = (now) => {
        if (buckets.size < 5000)
            return;
        for (const [key, bucket] of buckets) {
            if (bucket.resetAt <= now)
                buckets.delete(key);
        }
    };
    return (req, res, next) => {
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
exports.rateLimit = rateLimit;
//# sourceMappingURL=RateLimitMiddleware.js.map