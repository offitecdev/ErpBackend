import { TtlCache } from '../../shared/ttlCache';
import { getRedis, onRedisReconnect } from './redisClient';

/**
 * ── ZWEISTUFIGER ZWISCHENSPEICHER: VORGANG + REDIS ───────────────────────────
 *
 * Stufe 1 liegt im Vorgang (TtlCache, gedeckelt), Stufe 2 in Redis, wenn
 * `REDIS_URL` gesetzt ist. Gelesen wird zuerst Stufe 1, dann Redis; geschrieben
 * wird in beide. Fällt Redis aus, bleibt Stufe 1 allein — langsamer beim
 * Neustart, nie falsch.
 *
 * UNGÜLTIG MACHEN OHNE SCHLÜSSELSUCHE: jeder Eintrag hängt an Versionszählern
 * von «Bereichen» (z. B. `catalog`) je Firmengruppe. Eine Schreibanfrage erhöht
 * den Zähler; alle alten Einträge werden damit nie wieder getroffen und laufen
 * über ihre Lebensdauer aus. Kein SCAN, kein DEL über Muster.
 *
 * EPOCHE: war Redis weg, kann in der Zwischenzeit ein Zähler nur im Vorgang
 * gestiegen sein. Nach dem Wiederverbinden steigt deshalb die Epoche, und die
 * gesamte Stufe 1 wird geleert — lieber einmal alles neu laden als alte Daten.
 */

const L1_MAX_ENTRIES = 1_000;
/** Wie lange ein aus Redis gelesener Zählerstand im Vorgang geglaubt wird. */
const VERSION_L1_MS = 1_000;

const bodies = new TtlCache<string>({ name: 'responseCache.l1', ttlMs: 60_000, staleGraceMs: 0, maxEntries: L1_MAX_ENTRIES });
const bodyExpiry = new Map<string, number>();
const localVersions = new Map<string, number>();
const versionReadAt = new Map<string, number>();
let epoch = 0;

onRedisReconnect(() => {
    epoch += 1;
    bodies.clear();
    bodyExpiry.clear();
    versionReadAt.clear();
});

const versionKey = (scopeId: string, namespace: string) => `nsv:${scopeId}:${namespace}`;

/** Aktuelle Zählerstände der Bereiche einer Firmengruppe, in Aufrufreihenfolge. */
export const readVersions = async (scopeId: string, namespaces: string[]): Promise<number[]> => {
    const keys = namespaces.map((namespace) => versionKey(scopeId, namespace));
    const now = Date.now();
    const redis = getRedis();
    const stale = keys.filter((key) => !localVersions.has(key) || now - (versionReadAt.get(key) ?? 0) > VERSION_L1_MS);

    if (redis && stale.length) {
        try {
            const values = await redis.mget(...stale);
            stale.forEach((key, index) => {
                const remote = Number(values[index] ?? 0) || 0;
                // Nie rückwärts: ein lokaler Anstieg, der Redis nicht erreicht
                // hat, bleibt gültig.
                localVersions.set(key, Math.max(remote, localVersions.get(key) ?? 0));
                versionReadAt.set(key, now);
            });
        } catch {
            /* Redis verfehlt: lokale Stände gelten. */
        }
    }
    return keys.map((key) => (localVersions.get(key) ?? 0) + epoch * 1_000_000);
};

/** Macht alle Einträge ungültig, die an einem der Bereiche hängen. */
export const bumpVersions = async (scopeId: string, namespaces: string[]): Promise<void> => {
    const keys = [...new Set(namespaces)].map((namespace) => versionKey(scopeId, namespace));
    keys.forEach((key) => localVersions.set(key, (localVersions.get(key) ?? 0) + 1));
    const redis = getRedis();
    if (!redis) return;
    try {
        const pipeline = redis.pipeline();
        keys.forEach((key) => pipeline.incr(key));
        const results = await pipeline.exec();
        results?.forEach(([error, value], index) => {
            if (error) return;
            const key = keys[index]!;
            localVersions.set(key, Math.max(Number(value) || 0, localVersions.get(key) ?? 0));
            versionReadAt.set(key, Date.now());
        });
    } catch {
        /* Redis verfehlt: der lokale Anstieg genügt für diesen Vorgang. */
    }
};

/**
 * Zähler, die für JEDE Firmengruppe gelten. Hintergrunddienste (Erinnerungen,
 * Kalender-Abgleich, nächtlicher Terminabschluss) schreiben ohne Anfrage und
 * oft ohne eine einzelne Firma zu kennen — sie machen einen Bereich überall
 * ungültig. `responseCache` liest diese Zähler neben denen der Gruppe.
 */
export const GLOBAL_SCOPE = '*';

export const invalidateEverywhere = (namespaces: string[]): Promise<void> =>
    bumpVersions(GLOBAL_SCOPE, namespaces);

export const cacheGet = async (key: string): Promise<string | null> => {
    const local = bodies.get(key);
    if (local && (bodyExpiry.get(key) ?? 0) > Date.now()) return local.value;

    const redis = getRedis();
    if (!redis) return null;
    try {
        const [value, ttlMs] = await Promise.all([redis.get(`rc:${key}`), redis.pttl(`rc:${key}`)]);
        if (value !== null && ttlMs > 0) {
            bodies.set(key, value);
            bodyExpiry.set(key, Date.now() + ttlMs);
        }
        return value;
    } catch {
        return null;
    }
};

export const cacheSet = async (key: string, value: string, ttlSec: number): Promise<void> => {
    bodies.set(key, value);
    bodyExpiry.set(key, Date.now() + ttlSec * 1_000);
    if (bodyExpiry.size > L1_MAX_ENTRIES * 2) {
        const now = Date.now();
        for (const [entryKey, expiresAt] of bodyExpiry) {
            if (expiresAt <= now || !bodies.get(entryKey)) bodyExpiry.delete(entryKey);
        }
    }
    const redis = getRedis();
    if (!redis) return;
    try {
        await redis.set(`rc:${key}`, value, 'EX', ttlSec);
    } catch {
        /* nur Stufe 1 */
    }
};

export const cacheStats = () => ({
    redis: Boolean(getRedis()),
    epoch,
    l1: bodies.stats(),
    versions: localVersions.size,
});
