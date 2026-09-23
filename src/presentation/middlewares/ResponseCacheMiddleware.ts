import crypto from 'crypto';
import { Request, Response, NextFunction, RequestHandler } from 'express';
import { bumpVersions, cacheGet, cacheSet, GLOBAL_SCOPE, readVersions } from '../../infrastructure/cache/cacheStore';
import { findTenantRootIdCached } from '../../shared/tenantTree';

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
const WRITE_NAMESPACES: Record<string, string[]> = {
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
const moduleOf = (originalUrl: string): string | null => {
    const path = originalUrl.split('?')[0] ?? '';
    const match = path.match(/\/api\/v1\/([^/]+)/);
    return match?.[1] ?? null;
};

/** Firma → Firmengruppe; synchron lesbar, damit die Ungültigmachung VOR dem
    Absenden der Antwort geschieht (siehe unten). */
const scopeByTenant = new Map<string, string>();

const scopeOf = async (tenantId: string): Promise<string> => {
    const scopeId = (await findTenantRootIdCached(tenantId).catch(() => null)) ?? tenantId;
    scopeByTenant.set(tenantId, scopeId);
    return scopeId;
};

/** Global vor den Routen: erfolgreiche Schreibanfragen machen Lesespeicher ungültig. */
export const invalidateCachesOnWrite = (req: Request, res: Response, next: NextFunction): void => {
    if (!MUTATIONS.has(req.method)) return next();
    const namespaces = WRITE_NAMESPACES[moduleOf(req.originalUrl) ?? ''];
    if (!namespaces) return next();
    // Am `end` statt an `finish`: der Browser lädt nach dem Speichern sofort
    // neu, und diese Leseanfrage darf die alte Antwort nicht mehr treffen. Der
    // lokale Zähler steigt synchron (bumpVersions zählt vor seinem ersten
    // await), bevor die Antwort den Vorgang verlässt.
    const originalEnd = res.end.bind(res) as (...args: unknown[]) => Response;
    let bumped = false;
    (res as unknown as { end: (...args: unknown[]) => Response }).end = (...args: unknown[]) => {
        // `req.user` setzt requireAuth erst innerhalb der Route. Ohne Anmeldung
        // oder mit Fehler wurde nichts geschrieben.
        if (!bumped && res.statusCode < 400 && req.user?.tenantId) {
            bumped = true;
            const tenantId = req.user.tenantId;
            const known = scopeByTenant.get(tenantId);
            if (known) void bumpVersions(known, namespaces);
            else void scopeOf(tenantId).then((scopeId) => bumpVersions(scopeId, namespaces)).catch(() => undefined);
        }
        return originalEnd(...args);
    };
    next();
};

/** Nur für Tests und Werkzeuge: dieselbe Ungültigmachung ohne HTTP. */
export const invalidateNamespaces = async (tenantId: string, namespaces: string[]): Promise<void> => {
    await bumpVersions(await scopeOf(tenantId), namespaces);
};

export const responseCache = (options: { namespaces: string[]; ttlSec: number }): RequestHandler => {
    const { ttlSec } = options;
    // Jede gespeicherte Antwort hängt zusätzlich an `access`: eine Änderung an
    // Rollen, Rechten, Zuweisungen oder Firmen nimmt allen Antworten sofort
    // die Gültigkeit — ein entzogenes Recht wird nie aus dem Speicher bedient.
    const namespaces = [...new Set([...options.namespaces, 'access'])];
    return async (req: Request, res: Response, next: NextFunction) => {
        if (req.method !== 'GET' || !req.user?.tenantId || req.query.fresh !== undefined) return next();
        const startedAt = Date.now();
        let key: string;
        try {
            const scopeId = await scopeOf(req.user.tenantId);
            const [versions, globalVersions] = await Promise.all([
                readVersions(scopeId, namespaces),
                readVersions(GLOBAL_SCOPE, namespaces),
            ]);
            key = crypto
                .createHash('sha1')
                .update(JSON.stringify([req.user.id, req.user.tenantId, req.originalUrl, namespaces, versions, globalVersions]))
                .digest('hex');
        } catch {
            return next();
        }

        const hit = await cacheGet(key);
        if (hit !== null) {
            res.setHeader('X-Offitec-Cache', 'HIT');
            res.setHeader('Server-Timing', `cache;desc="hit";dur=${Date.now() - startedAt}`);
            res.status(200).type('application/json').send(hit);
            return;
        }

        res.setHeader('X-Offitec-Cache', 'MISS');
        const originalJson = res.json.bind(res);
        res.json = (body: unknown) => {
            if (res.statusCode === 200) {
                try {
                    const text = JSON.stringify(body);
                    // Grosse Antworten (Exporte, Bilder in JSON) gehören nicht in den Speicher.
                    if (text !== undefined && text.length <= 512_000) void cacheSet(key, text, ttlSec);
                } catch {
                    /* nicht serialisierbar: nicht speichern */
                }
            }
            return originalJson(body);
        };
        next();
    };
};
