"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.responseCache = exports.invalidateNamespaces = exports.invalidateCachesOnWrite = void 0;
const crypto_1 = __importDefault(require("crypto"));
const cacheStore_1 = require("../../infrastructure/cache/cacheStore");
const tenantTree_1 = require("../../shared/tenantTree");
/**
 * ── LESEANTWORTEN AUS DEM ZWISCHENSPEICHER (14.09.2026) ─────────────────────
 *
 * `responseCache({ namespaces, ttlSec })` kommt an einen GET-Weg HINTER
 * `requireAuth` und die Rechteprüfung — gefragt wird der Speicher also erst,
 * wenn Anmeldung, Firma und Recht des Einzelwegs feststehen.
 *
 * DER SCHLÜSSEL ist bewusst eng: Person + aufgelöste Firma + vollständige URL
 * + Zählerstände der Bereiche. Keine Antwort wandert je zu einer anderen Person
 * oder Firma, auch wenn eine Antwort von Rechten oder Zuweisungen abhängt.
 *
 * GÜLTIGKEIT: jede erfolgreiche Schreibanfrage (POST/PUT/PATCH/DELETE) erhöht
 * die Zähler der Bereiche ihres Moduls für die ganze Firmengruppe
 * (`invalidateCachesOnWrite`, global in main.ts). Hintergrunddienste, die ohne
 * Anfrage schreiben (Erinnerungsmotor, Kalender-Abgleich, nächtlicher
 * Terminabschluss), rufen `invalidateEverywhere` (cacheStore). Jede Antwort
 * hat zusätzlich eine kurze Lebensdauer als obere Grenze.
 *
 * NICHT angebunden werden Wege, die beim Lesen schreiben (z. B.
 * `/tenders/:id/export`, `/tasks/bootstrap`), laufende Zeit ausliefern
 * (`/tasks/live`, `/tasks/timer/active`, `/tasks/:taskId`, Chat) oder keine
 * Anmeldung haben (öffentliche Buchung) — ohne `req.user` greift der Speicher
 * ohnehin nie.
 */
/**
 * Welche Bereiche eine Schreibanfrage unter einem Modulpfad ungültig macht.
 * `catalog` = Artikel samt Bestand: Bestand bewegen nicht nur Lager und
 * Artikel, sondern auch Aufträge, Nachträge, Rapporte, Offerten (Zuordnung)
 * und die Einstellungen (Einheiten, Nummernkreise).
 */
const WRITE_NAMESPACES = {
    // Die Lieferantenbestellung trägt die Produktionszuordnung und die
    // bestätigten Zeilen (uretim_*) — jede Änderung dort ändert die Produktion.
    inventory: ['catalog', 'production'],
    production: ['production'],
    articles: ['catalog'],
    tenders: ['catalog', 'customers', 'tender', 'calendar'],
    'sales-orders': ['catalog', 'customers', 'tender', 'calendar'],
    'addon-orders': ['catalog', 'tender'],
    billing: ['catalog', 'customers', 'tender'],
    'delivery-reports': ['catalog', 'tender', 'calendar'],
    maintenance: ['catalog', 'calendar'],
    regie: ['catalog', 'calendar'],
    projects: ['catalog', 'customers', 'tender', 'calendar', 'tasks'],
    logistics: ['catalog', 'calendar'],
    osp: ['catalog', 'tender'],
    settings: ['catalog', 'settings', 'tender', 'calendar', 'tasks'],
    customers: ['customers', 'tender', 'calendar'],
    crm: ['customers', 'tender', 'calendar', 'tasks'],
    enquiries: ['customers'],
    forms: ['customers'],
    meetings: ['calendar', 'tasks'],
    booking: ['calendar'],
    calendar: ['settings', 'calendar'],
    tasks: ['tasks'],
    files: ['tender', 'catalog', 'calendar', 'tasks'],
    'signature-requests': ['tender', 'calendar'],
    fx: ['tender'],
    employees: ['staff', 'settings', 'access', 'tender', 'calendar', 'tasks'],
    personnel: ['staff', 'calendar', 'tasks'],
    roles: ['staff', 'settings', 'access'],
    'role-templates': ['staff', 'settings', 'access'],
    'module-profiles': ['settings', 'access'],
    tenants: ['staff', 'settings', 'access', 'customers', 'catalog', 'tender', 'calendar', 'tasks'],
};
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** `/backend/api/v1/inventory/…` → `inventory`. */
const moduleOf = (originalUrl) => {
    const path = originalUrl.split('?')[0] ?? '';
    const match = path.match(/\/api\/v1\/([^/]+)/);
    return match?.[1] ?? null;
};
/** Firma → Firmengruppe; synchron lesbar, damit die Ungültigmachung VOR dem
    Absenden der Antwort geschieht (siehe unten). */
const scopeByTenant = new Map();
const scopeOf = async (tenantId) => {
    const scopeId = (await (0, tenantTree_1.findTenantRootIdCached)(tenantId).catch(() => null)) ?? tenantId;
    scopeByTenant.set(tenantId, scopeId);
    return scopeId;
};
/** Global vor den Routen: erfolgreiche Schreibanfragen machen Lesespeicher ungültig. */
const invalidateCachesOnWrite = (req, res, next) => {
    if (!MUTATIONS.has(req.method))
        return next();
    const namespaces = WRITE_NAMESPACES[moduleOf(req.originalUrl) ?? ''];
    if (!namespaces)
        return next();
    // Am `end` statt an `finish`: der Browser lädt nach dem Speichern sofort
    // neu, und diese Leseanfrage darf die alte Antwort nicht mehr treffen. Der
    // lokale Zähler steigt synchron (bumpVersions zählt vor seinem ersten
    // await), bevor die Antwort den Vorgang verlässt.
    const originalEnd = res.end.bind(res);
    let bumped = false;
    res.end = (...args) => {
        // `req.user` setzt requireAuth erst innerhalb der Route. Ohne Anmeldung
        // oder mit Fehler wurde nichts geschrieben.
        if (!bumped && res.statusCode < 400 && req.user?.tenantId) {
            bumped = true;
            const tenantId = req.user.tenantId;
            const known = scopeByTenant.get(tenantId);
            if (known)
                void (0, cacheStore_1.bumpVersions)(known, namespaces);
            else
                void scopeOf(tenantId).then((scopeId) => (0, cacheStore_1.bumpVersions)(scopeId, namespaces)).catch(() => undefined);
        }
        return originalEnd(...args);
    };
    next();
};
exports.invalidateCachesOnWrite = invalidateCachesOnWrite;
/** Nur für Tests und Werkzeuge: dieselbe Ungültigmachung ohne HTTP. */
const invalidateNamespaces = async (tenantId, namespaces) => {
    await (0, cacheStore_1.bumpVersions)(await scopeOf(tenantId), namespaces);
};
exports.invalidateNamespaces = invalidateNamespaces;
const responseCache = (options) => {
    const { ttlSec } = options;
    // Jede gespeicherte Antwort hängt zusätzlich an `access`: eine Änderung an
    // Rollen, Rechten, Zuweisungen oder Firmen nimmt allen Antworten sofort
    // die Gültigkeit — ein entzogenes Recht wird nie aus dem Speicher bedient.
    const namespaces = [...new Set([...options.namespaces, 'access'])];
    return async (req, res, next) => {
        if (req.method !== 'GET' || !req.user?.tenantId || req.query.fresh !== undefined)
            return next();
        const startedAt = Date.now();
        let key;
        try {
            const scopeId = await scopeOf(req.user.tenantId);
            const [versions, globalVersions] = await Promise.all([
                (0, cacheStore_1.readVersions)(scopeId, namespaces),
                (0, cacheStore_1.readVersions)(cacheStore_1.GLOBAL_SCOPE, namespaces),
            ]);
            key = crypto_1.default
                .createHash('sha1')
                .update(JSON.stringify([req.user.id, req.user.tenantId, req.originalUrl, namespaces, versions, globalVersions]))
                .digest('hex');
        }
        catch {
            return next();
        }
        const hit = await (0, cacheStore_1.cacheGet)(key);
        if (hit !== null) {
            res.setHeader('X-Offitec-Cache', 'HIT');
            res.setHeader('Server-Timing', `cache;desc="hit";dur=${Date.now() - startedAt}`);
            res.status(200).type('application/json').send(hit);
            return;
        }
        res.setHeader('X-Offitec-Cache', 'MISS');
        const originalJson = res.json.bind(res);
        res.json = (body) => {
            if (res.statusCode === 200) {
                try {
                    const text = JSON.stringify(body);
                    // Grosse Antworten (Exporte, Bilder in JSON) gehören nicht in den Speicher.
                    if (text !== undefined && text.length <= 512_000)
                        void (0, cacheStore_1.cacheSet)(key, text, ttlSec);
                }
                catch {
                    /* nicht serialisierbar: nicht speichern */
                }
            }
            return originalJson(body);
        };
        next();
    };
};
exports.responseCache = responseCache;
//# sourceMappingURL=ResponseCacheMiddleware.js.map