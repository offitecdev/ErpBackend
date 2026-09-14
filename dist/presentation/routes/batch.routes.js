"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
/**
 * ── MEHRERE LESEWEGE IN EINEM RUNDLAUF ─────────────────────────────────────
 *
 * GET /batch?get=/projects&get=/billing/invoices?view=project-list
 *
 * Gemessen am Produktivrechner (14.09.2026): jede Anfrage kostet 150–200 ms
 * reine Laufzeit zwischen Browser, Cloudflare und diesem Rechner — eine
 * Antwort von 11 Byte genauso wie eine von 10 KB. Die Kopfzeilen-Zähler (vier
 * Wege) und die Projektliste (vier Wege) zahlten diese Strecke also je viermal.
 * Hier zahlen sie sie einmal.
 *
 * WIE: jeder Teilweg läuft als echte Anfrage über die lokale Schleife an
 * DIESEN Dienst — mit denselben Keksen, demselben X-Tenant-Id und derselben
 * Absenderadresse. Anmeldung, Rechte, Mandantenprüfung und Antwortform bleiben
 * damit genau die des Einzelwegs; hier wird nichts nachgebaut, das
 * auseinanderlaufen könnte.
 *
 * NUR LESEN, NUR DIE LISTE UNTEN: ein freier Pfad machte aus diesem Weg einen
 * Verstärker (eine Anfrage → beliebig viele) und ein Tor zu Wegen, die nie für
 * Sammelabrufe gedacht waren. Ein Pfad, der hier fehlt, antwortet mit 400.
 */
const ALLOWED_PATHS = new Set([
    // Kopfzeile: Apps-Feld und Glocke
    '/personnel/leaves/counts',
    '/mail/messages/stats',
    '/crm/tasks',
    '/crm/reminders/due',
    '/notifications/unread-count',
    '/meetings',
    // Projektliste
    '/projects',
    '/sales-orders/my-orders',
    '/delivery-reports',
    '/billing/invoices',
]);
const MAX_GETS = 8;
/** Kopfzeilen, die der Teilweg vom Original übernimmt. */
const FORWARDED_HEADERS = [
    'cookie',
    'authorization',
    'x-tenant-id',
    'accept-language',
    'user-agent',
    'x-forwarded-proto',
    'x-forwarded-host',
    'x-forwarded-prefix',
];
const parseGet = (raw) => {
    if (!raw.startsWith('/') || raw.startsWith('//'))
        return null;
    let url;
    try {
        url = new URL(raw, 'http://batch.local');
    }
    catch {
        return null;
    }
    if (url.host !== 'batch.local' || !ALLOWED_PATHS.has(url.pathname))
        return null;
    return url.pathname + url.search;
};
const forwardHeaders = (req) => {
    const headers = { accept: 'application/json' };
    for (const name of FORWARDED_HEADERS) {
        const value = req.headers[name];
        if (typeof value === 'string' && value)
            headers[name] = value;
    }
    // `trust proxy` = 1: der Teilweg liest die Absenderadresse aus dem letzten
    // Eintrag — so zählen Protokoll und Begrenzer die echte Person, nicht die
    // Schleife.
    if (req.ip)
        headers['x-forwarded-for'] = req.ip;
    return headers;
};
const router = (0, express_1.Router)();
router.get('/', AuthMiddleware_1.requireAuth, async (req, res) => {
    const rawGets = [].concat(req.query.get ?? []).map(String);
    if (!rawGets.length || rawGets.length > MAX_GETS) {
        return res.status(400).json({ error: `1–${MAX_GETS} get-Parameter erwartet.` });
    }
    const gets = [];
    for (const raw of rawGets) {
        const parsed = parseGet(raw);
        if (!parsed)
            return res.status(400).json({ error: `Pfad nicht erlaubt: ${raw.slice(0, 80)}` });
        gets.push(parsed);
    }
    const port = req.socket.localPort || Number(process.env.PORT) || 3000;
    const base = `http://127.0.0.1:${port}${req.baseUrl.replace(/\/batch$/, '')}`;
    const headers = forwardHeaders(req);
    const settled = await Promise.all(rawGets.map(async (raw, index) => {
        try {
            const response = await fetch(base + gets[index], { headers });
            const text = await response.text();
            let body = null;
            try {
                body = text ? JSON.parse(text) : null;
            }
            catch {
                body = null;
            }
            return [raw, { status: response.status, body }];
        }
        catch {
            return [raw, { status: 502, body: null }];
        }
    }));
    res.status(200).json({ results: Object.fromEntries(settled) });
});
exports.default = router;
//# sourceMappingURL=batch.routes.js.map