"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimit = void 0;
const express_rate_limit_1 = require("express-rate-limit");
const rateLimit = ({ windowMs, max, message, skipSuccessfulRequests, keyBy }) => (0, express_rate_limit_1.rateLimit)({
    windowMs,
    limit: max,
    skipSuccessfulRequests: skipSuccessfulRequests ?? false,
    ...(keyBy
        ? {
            // Fällt der eigene Schlüssel aus, wird auf die Adresse
            // zurückgefallen (ipKeyGenerator normalisiert IPv6-Bereiche).
            keyGenerator: (req) => keyBy(req) ?? (0, express_rate_limit_1.ipKeyGenerator)(req.ip ?? ''),
            skip: (req) => keyBy(req) === null,
        }
        : {}),
    standardHeaders: 'draft-7', // RateLimit-* headers (incl. Retry-After semantics)
    legacyHeaders: false,
    handler: (_req, res) => {
        res.status(429).json({
            error: message || 'Çok fazla istek gönderildi. Lütfen daha sonra tekrar deneyin.',
        });
    },
});
exports.rateLimit = rateLimit;
//# sourceMappingURL=RateLimitMiddleware.js.map