/**
 * ── DIE LAUFZEITUMGEBUNG, EINMAL GEPRÜFT ─────────────────────────────────────
 *
 * `OFFITEC_ENV` entschied bisher an genau EINER Stelle etwas — und zwar, ob die
 * Sitzungskekse das `Secure`-Merkmal tragen (`authCookies.ts`):
 *
 *     const secure = process.env.OFFITEC_ENV === 'production' || sameSite === 'none';
 *
 * Ein Vergleich auf eine ungeprüfte Zeichenkette. `Production`, `prod`, ein
 * Leerzeichen am Ende, oder die Variable auf dem Server schlicht nicht gesetzt:
 * in allen vier Fällen startet der Dienst klaglos und verschickt die
 * Sitzungskekse ohne `Secure` — sie gehen dann auch über eine unverschlüsselte
 * Verbindung mit. Nichts im Betrieb weist darauf hin; erst ein Blick in die
 * Antwortköpfe zeigt es.
 *
 * Ein Sicherheitsmerkmal darf nicht an einer ungeprüften Zeichenkette hängen.
 * Die Variable wird deshalb hier EINMAL beim Start gelesen, gegen eine feste
 * Liste geprüft, und danach liest niemand mehr `process.env.OFFITEC_ENV` —
 * alle fragen `runtimeEnv()` bzw. `isProduction()`.
 *
 * Die Prüfung schlägt FEHL statt zu raten. Ein nicht gesetzter Wert ist kein
 * "dann eben Entwicklung": genau diese Annahme wäre auf dem Produktivserver die
 * teure. Lokal steht `OFFITEC_ENV=development` in der `.env`.
 */

import os from 'os';

/**
 * ── DIE GRÖSSE DES THREADPOOLS ──────────────────────────────────────────────
 *
 * libuv hält VIER Arbeitsfäden, wenn niemand etwas anderes sagt. Über die
 * laufen bcrypt, jeder Dateizugriff, Sharp und die DNS-Auflösung — gemeinsam.
 * Vier gleichzeitige Anmeldeversuche (bcrypt Kostenfaktor 12, je ~250-400 ms)
 * belegen ihn damit vollständig, und in dieser Zeit steht auch das Verkleinern
 * eines hochgeladenen Bildes still.
 *
 * ── WARUM DAS HIER NUR MELDET UND NICHTS SETZT ──────────────────────────────
 *
 * Weil Setzen aus dem Code heraus NICHT WIRKT. Node liest `UV_THREADPOOL_SIZE`
 * beim Hochfahren des Vorgangs, bevor die erste eigene Zeile läuft; ein
 * `process.env.UV_THREADPOOL_SIZE = '16'` ganz oben in `main.ts` ändert die
 * Variable, aber nicht mehr den Pool. Gemessen (16 gleichzeitige Vergleiche):
 *
 *     im Code gesetzt auf 16 → 1101 ms   (also weiterhin vier Plätze)
 *     in der UMGEBUNG auf 16 → 304 ms
 *     in der UMGEBUNG auf  4 → 1093 ms
 *
 * Die Variable gehört also in den Start des Dienstes, nicht in dieses Modul.
 * Hier wird deshalb nur der TATSÄCHLICHE Wert gemeldet — und beim Start eine
 * Zeile ausgegeben, wenn er unter der Empfehlung liegt.
 *
 * Die Hälfte, die in unserer Hand liegt, ist die Schranke in
 * `application/services/bcryptGate.ts`: sie deckelt, wie viele Plätze die
 * Anmeldung überhaupt belegen darf, und bemisst sich am ECHTEN Wert von hier.
 * Damit bleibt auch bei vier Plätzen etwas für Dateien und Bilder übrig.
 */

/** Was der Pool WIRKLICH hat: die Umgebung, sonst libuvs Vorgabe von vier. */
export const threadpoolSize = (): number => {
    const configured = Number.parseInt(String(process.env.UV_THREADPOOL_SIZE || ''), 10);
    return Number.isFinite(configured) && configured > 0 ? configured : 4;
};

/** Was sinnvoll wäre: Platz für die erlaubten bcrypt-Aufgaben und Reserve. */
export const recommendedThreadpoolSize = (): number =>
    Math.max(8, Math.min(16, os.cpus().length + 4));

export const threadpoolAdvice = () => {
    const effective = threadpoolSize();
    const recommended = recommendedThreadpoolSize();
    return { effective, recommended, shouldRaise: effective < recommended };
};

export type RuntimeEnv = 'development' | 'test' | 'staging' | 'production';

const KNOWN_ENVS: readonly RuntimeEnv[] = ['development', 'test', 'staging', 'production'];

/** Erst nach `assertRuntimeConfig()` gesetzt — vorher fragt niemand danach. */
let resolvedEnv: RuntimeEnv | null = null;

export class RuntimeConfigError extends Error {}

const readEnvName = (): RuntimeEnv => {
    const raw = (process.env.OFFITEC_ENV || '').trim().toLowerCase();
    if (!raw) {
        throw new RuntimeConfigError(
            'OFFITEC_ENV ist nicht gesetzt. Erlaubt: ' + KNOWN_ENVS.join(' | ') + '. ' +
            'Ohne diesen Wert ist nicht entscheidbar, ob die Sitzungskekse das Secure-Merkmal ' +
            'tragen müssen — der Dienst startet deshalb nicht. Lokal: OFFITEC_ENV=development',
        );
    }
    if (!KNOWN_ENVS.includes(raw as RuntimeEnv)) {
        throw new RuntimeConfigError(
            `OFFITEC_ENV="${raw}" ist unbekannt. Erlaubt: ${KNOWN_ENVS.join(' | ')}. ` +
            'Ein Tippfehler hier hat früher unbemerkt die Secure-Kekse abgeschaltet.',
        );
    }
    return raw as RuntimeEnv;
};

/**
 * Nur `lax`, `strict` und `none` sind gültig. Vorher wurde ein unbekannter Wert
 * still auf `lax` zurückgesetzt — wer `OFFITEC_COOKIE_SAMESITE=None` schrieb,
 * bekam `lax` und wunderte sich, warum die Schreibtischanwendung sich nicht
 * anmeldet.
 */
export type CookieSameSite = 'lax' | 'strict' | 'none';

const readSameSite = (): CookieSameSite => {
    const raw = (process.env.OFFITEC_COOKIE_SAMESITE || 'lax').trim().toLowerCase();
    if (!(['lax', 'strict', 'none'] as string[]).includes(raw)) {
        throw new RuntimeConfigError(
            `OFFITEC_COOKIE_SAMESITE="${raw}" ist unbekannt. Erlaubt: lax | strict | none.`,
        );
    }
    return raw as CookieSameSite;
};

const isLocalOrigin = (origin: string): boolean => {
    try {
        const { hostname } = new URL(origin);
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
    } catch {
        return false;
    }
};

/**
 * Beim Start aufzurufen, VOR dem ersten Zugriff auf `runtimeEnv()`. Wirft bei
 * einer Fehlkonfiguration — `main.ts` beendet den Vorgang dann mit einer
 * lesbaren Zeile statt mit einem stillen Sicherheitsverlust.
 */
export const assertRuntimeConfig = (): RuntimeEnv => {
    const env = readEnvName();
    const sameSite = readSameSite();
    resolvedEnv = env;

    if (env !== 'production') return env;

    // ── Ab hier: was im Produktivbetrieb zusätzlich stimmen MUSS ────────────
    const problems: string[] = [];

    // Das eigentliche Schutzgut dieser Datei. Bleibt eine Zusicherung, auch
    // wenn sie sich aus den beiden Werten oben zwangsläufig ergibt: wer die
    // Bedingung in authCookies.ts ändert, fällt hier auf.
    const secure = env === 'production' || sameSite === 'none';
    if (!secure) {
        problems.push('Die Sitzungskekse würden ohne Secure-Merkmal ausgeliefert.');
    }

    // Ein anmeldefähiger Ursprung über http:// bedeutet: die Kekse dieser
    // Sitzung reisen im Klartext. Örtliche Adressen sind ausgenommen, sie
    // verlassen den Rechner nicht.
    const configuredOrigins = (process.env.OFFITEC_CORS_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    const insecureOrigins = configuredOrigins.filter(
        (origin) => origin.startsWith('http://') && !isLocalOrigin(origin),
    );
    if (insecureOrigins.length) {
        problems.push(
            `OFFITEC_CORS_ORIGINS enthält unverschlüsselte Ursprünge: ${insecureOrigins.join(', ')}. ` +
            'Über sie reisen die Sitzungskekse im Klartext.',
        );
    }

    if (problems.length) {
        throw new RuntimeConfigError(
            'Produktivbetrieb mit unsicherer Konfiguration:\n  - ' + problems.join('\n  - '),
        );
    }

    return env;
};

export const runtimeEnv = (): RuntimeEnv => resolvedEnv ?? assertRuntimeConfig();

export const isProduction = (): boolean => runtimeEnv() === 'production';

export const cookieSameSite = (): CookieSameSite => readSameSite();
