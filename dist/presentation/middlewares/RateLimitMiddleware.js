"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimit = void 0;
const express_rate_limit_1 = require("express-rate-limit");
const rateLimit = ({ windowMs, max, message, skipSuccessfulRequests }) => (0, express_rate_limit_1.rateLimit)({
    windowMs,
    limit: max,
    skipSuccessfulRequests: skipSuccessfulRequests ?? false,
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