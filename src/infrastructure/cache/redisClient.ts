import Redis from 'ioredis';

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
export const REDIS_KEY_PREFIX = (process.env.REDIS_KEY_PREFIX || 'occ:').trim();

let client: Redis | null = null;
let ready = false;
let loggedDown = false;
/** Wird bei jedem Wiederverbinden erhöht — siehe cacheStore `epoch`. */
let reconnectListeners: Array<() => void> = [];

const connect = (): Redis | null => {
    if (!REDIS_URL) return null;
    const redis = new Redis(REDIS_URL, {
        keyPrefix: REDIS_KEY_PREFIX,
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
        if (wasDown) reconnectListeners.forEach((listener) => listener());
        wasDown = false;
    });
    const markDown = (reason: string) => {
        if (ready) wasDown = true;
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

export const getRedis = (): Redis | null => {
    if (!REDIS_URL) return null;
    if (!client) client = connect();
    return ready ? client : null;
};

export const redisConfigured = (): boolean => Boolean(REDIS_URL);

export const onRedisReconnect = (listener: () => void): void => {
    reconnectListeners.push(listener);
};

export const closeRedis = async (): Promise<void> => {
    reconnectListeners = [];
    if (!client) return;
    try {
        await client.quit();
    } catch {
        client.disconnect();
    }
    client = null;
    ready = false;
};

// Früh verbinden, damit die erste Anfrage nicht auf den Handschlag trifft.
if (REDIS_URL) client = connect();
