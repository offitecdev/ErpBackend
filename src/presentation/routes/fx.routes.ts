import { Router } from 'express';
import { requireAuth } from '../middlewares/AuthMiddleware';

/* Server-side exchange-rate proxy. The browser cannot call frankfurter.app
   directly (CORS), so the backend fetches the ECB feed and caches it in
   memory. Consumers treat a failure as "use your static fallback". */

const router = Router();

const FX_URL = 'https://api.frankfurter.app/latest?from=CHF&to=EUR,USD,GBP,TRY';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

let cache: { fetchedAt: number; rates: Record<string, number> } | null = null;

router.get('/rates', requireAuth, async (_req, res) => {
    try {
        if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
            return res.status(200).json({ base: 'CHF', rates: cache.rates, fetchedAt: cache.fetchedAt, cached: true });
        }
        const upstream = await fetch(FX_URL, { signal: AbortSignal.timeout(8000) });
        if (!upstream.ok) throw new Error(`Kur servisi yanıt vermedi (${upstream.status}).`);
        const data = (await upstream.json()) as { rates?: Record<string, number> };
        if (!data?.rates) throw new Error('Kur servisi boş yanıt döndürdü.');
        cache = { fetchedAt: Date.now(), rates: data.rates };
        res.status(200).json({ base: 'CHF', rates: cache.rates, fetchedAt: cache.fetchedAt, cached: false });
    } catch (error: any) {
        // A stale cache beats no data at all.
        if (cache) {
            return res.status(200).json({ base: 'CHF', rates: cache.rates, fetchedAt: cache.fetchedAt, cached: true, stale: true });
        }
        res.status(502).json({ error: error.message });
    }
});

export default router;
