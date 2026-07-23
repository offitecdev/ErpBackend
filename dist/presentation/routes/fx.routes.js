"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
/* Server-side exchange-rate proxy. The browser cannot call frankfurter.app
   directly (CORS), so the backend fetches the ECB feed and caches it in
   memory. Consumers treat a failure as "use your static fallback". */
const router = (0, express_1.Router)();
const FX_URL = 'https://api.frankfurter.app/latest?from=CHF&to=EUR,USD,GBP,TRY';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
let cache = null;
router.get('/rates', AuthMiddleware_1.requireAuth, async (_req, res) => {
    try {
        if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
            return res.status(200).json({ base: 'CHF', rates: cache.rates, fetchedAt: cache.fetchedAt, cached: true });
        }
        const upstream = await fetch(FX_URL, { signal: AbortSignal.timeout(8000) });
        if (!upstream.ok)
            throw new Error(`Kur servisi yanıt vermedi (${upstream.status}).`);
        const data = (await upstream.json());
        if (!data?.rates)
            throw new Error('Kur servisi boş yanıt döndürdü.');
        cache = { fetchedAt: Date.now(), rates: data.rates };
        res.status(200).json({ base: 'CHF', rates: cache.rates, fetchedAt: cache.fetchedAt, cached: false });
    }
    catch (error) {
        // A stale cache beats no data at all.
        if (cache) {
            return res.status(200).json({ base: 'CHF', rates: cache.rates, fetchedAt: cache.fetchedAt, cached: true, stale: true });
        }
        res.status(502).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=fx.routes.js.map