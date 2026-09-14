"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.closeRedis = exports.onRedisReconnect = exports.redisConfigured = exports.getRedis = exports.REDIS_KEY_PREFIX = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
/**
 * ── REDIS: GEMEINSAMER ZWISCHENSPEICHER (14.09.2026) ────────────────────────
 *
 * Eingeschaltet über `REDIS_URL` (z. B. `redis://127.0.0.1:6379/0`). Fehlt die
 * Variable oder ist Redis nicht erreichbar, läuft alles mit dem Speicher im
 * Vorgang weiter (siehe cacheStore.ts) — Redis macht den Dienst schneller und
 * mehrere Instanzen einig, er darf ihn nie aufhalten:
 *
 *  • keine Warteschlange für Befehle, solange die Verbindung fehlt
 *    (`enableOfflineQueue: false`) — ein Befehl scheitert dann sofort;
 *  • jeder Befehl hat 250 ms (`commandTimeout`), danach gilt er als verfehlt;
 *  • Wiederverbinden im Hintergrund mit wachsendem Abstand bis 5 s.
 */
const REDIS_URL = (process.env.REDIS_URL || '').trim();
exports.REDIS_KEY_PREFIX = (process.env.REDIS_KEY_PREFIX || 'occ:').trim();
let client = null;
let ready = false;
let loggedDown = false;
/** Wird bei jedem Wiederverbinden erhöht — siehe cacheStore `epoch`. */
let reconnectListeners = [];
const connect = () => {
    if (!REDIS_URL)
        return null;
    const redis = new ioredis_1.default(REDIS_URL, {
        keyPrefix: exports.REDIS_KEY_PREFIX,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        commandTimeout: 250,
        connectTimeout: 2_000,
        lazyConnect: false,
        retryStrategy: (times) => Math.min(times * 200, 5_000),
    });
    let wasDown = false;
    redis.on('ready', () => {
        ready = true;
        loggedDown = false;
        console.log('[Redis] verbunden');
        if (wasDown)
            reconnectListeners.forEach((listener) => listener());
        wasDown = false;
    });
    const markDown = (reason) => {
        if (ready)
            wasDown = true;
        ready = false;
        if (!loggedDown) {
            loggedDown = true;
            console.warn(`[Redis] nicht erreichbar (${reason}) — Zwischenspeicher im Vorgang aktiv`);
        }
    };
    redis.on('error', (error) => markDown(error.message));
    redis.on('end', () => markDown('Verbindung beendet'));
    redis.on('close', () => markDown('Verbindung geschlossen'));
    return redis;
};
const getRedis = () => {
    if (!REDIS_URL)
        return null;
    if (!client)
        client = connect();
    return ready ? client : null;
};
exports.getRedis = getRedis;
const redisConfigured = () => Boolean(REDIS_URL);
exports.redisConfigured = redisConfigured;
const onRedisReconnect = (listener) => {
    reconnectListeners.push(listener);
};
exports.onRedisReconnect = onRedisReconnect;
const closeRedis = async () => {
    reconnectListeners = [];
    if (!client)
        return;
    try {
        await client.quit();
    }
    catch {
        client.disconnect();
    }
    client = null;
    ready = false;
};
exports.closeRedis = closeRedis;
// Früh verbinden, damit die erste Anfrage nicht auf den Handschlag trifft.
if (REDIS_URL)
    client = connect();
//# sourceMappingURL=redisClient.js.map