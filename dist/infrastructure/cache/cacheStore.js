"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheStats = exports.cacheSet = exports.cacheGet = exports.invalidateEverywhere = exports.GLOBAL_SCOPE = exports.bumpVersions = exports.readVersions = void 0;
const ttlCache_1 = require("../../shared/ttlCache");
const redisClient_1 = require("./redisClient");
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
const bodies = new ttlCache_1.TtlCache({ name: 'responseCache.l1', ttlMs: 60_000, staleGraceMs: 0, maxEntries: L1_MAX_ENTRIES });
const bodyExpiry = new Map();
const localVersions = new Map();
const versionReadAt = new Map();
let epoch = 0;
(0, redisClient_1.onRedisReconnect)(() => {
    epoch += 1;
    bodies.clear();
    bodyExpiry.clear();
    versionReadAt.clear();
});
const versionKey = (scopeId, namespace) => `nsv:${scopeId}:${namespace}`;
/** Aktuelle Zählerstände der Bereiche einer Firmengruppe, in Aufrufreihenfolge. */
const readVersions = async (scopeId, namespaces) => {
    const keys = namespaces.map((namespace) => versionKey(scopeId, namespace));
    const now = Date.now();
    const redis = (0, redisClient_1.getRedis)();
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
        }
        catch {
            /* Redis verfehlt: lokale Stände gelten. */
        }
    }
    return keys.map((key) => (localVersions.get(key) ?? 0) + epoch * 1_000_000);
};
exports.readVersions = readVersions;
/** Macht alle Einträge ungültig, die an einem der Bereiche hängen. */
const bumpVersions = async (scopeId, namespaces) => {
    const keys = [...new Set(namespaces)].map((namespace) => versionKey(scopeId, namespace));
    keys.forEach((key) => localVersions.set(key, (localVersions.get(key) ?? 0) + 1));
    const redis = (0, redisClient_1.getRedis)();
    if (!redis)
        return;
    try {
        const pipeline = redis.pipeline();
        keys.forEach((key) => pipeline.incr(key));
        const results = await pipeline.exec();
        results?.forEach(([error, value], index) => {
            if (error)
                return;
            const key = keys[index];
            localVersions.set(key, Math.max(Number(value) || 0, localVersions.get(key) ?? 0));
            versionReadAt.set(key, Date.now());
        });
    }
    catch {
        /* Redis verfehlt: der lokale Anstieg genügt für diesen Vorgang. */
    }
};
exports.bumpVersions = bumpVersions;
/**
 * Zähler, die für JEDE Firmengruppe gelten. Hintergrunddienste (Erinnerungen,
 * Kalender-Abgleich, nächtlicher Terminabschluss) schreiben ohne Anfrage und
 * oft ohne eine einzelne Firma zu kennen — sie machen einen Bereich überall
 * ungültig. `responseCache` liest diese Zähler neben denen der Gruppe.
 */
exports.GLOBAL_SCOPE = '*';
const invalidateEverywhere = (namespaces) => (0, exports.bumpVersions)(exports.GLOBAL_SCOPE, namespaces);
exports.invalidateEverywhere = invalidateEverywhere;
const cacheGet = async (key) => {
    const local = bodies.get(key);
    if (local && (bodyExpiry.get(key) ?? 0) > Date.now())
        return local.value;
    const redis = (0, redisClient_1.getRedis)();
    if (!redis)
        return null;
    try {
        const [value, ttlMs] = await Promise.all([redis.get(`rc:${key}`), redis.pttl(`rc:${key}`)]);
        if (value !== null && ttlMs > 0) {
            bodies.set(key, value);
            bodyExpiry.set(key, Date.now() + ttlMs);
        }
        return value;
    }
    catch {
        return null;
    }
};
exports.cacheGet = cacheGet;
const cacheSet = async (key, value, ttlSec) => {
    bodies.set(key, value);
    bodyExpiry.set(key, Date.now() + ttlSec * 1_000);
    if (bodyExpiry.size > L1_MAX_ENTRIES * 2) {
        const now = Date.now();
        for (const [entryKey, expiresAt] of bodyExpiry) {
            if (expiresAt <= now || !bodies.get(entryKey))
                bodyExpiry.delete(entryKey);
        }
    }
    const redis = (0, redisClient_1.getRedis)();
    if (!redis)
        return;
    try {
        await redis.set(`rc:${key}`, value, 'EX', ttlSec);
    }
    catch {
        /* nur Stufe 1 */
    }
};
exports.cacheSet = cacheSet;
const cacheStats = () => ({
    redis: Boolean((0, redisClient_1.getRedis)()),
    epoch,
    l1: bodies.stats(),
    versions: localVersions.size,
});
exports.cacheStats = cacheStats;
//# sourceMappingURL=cacheStore.js.map