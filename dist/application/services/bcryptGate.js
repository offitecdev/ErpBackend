"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetBcryptGate = exports.bcryptGateStats = exports.runBcryptGuarded = void 0;
const os_1 = __importDefault(require("os"));
const AuthErrors_1 = require("../errors/AuthErrors");
const runtime_1 = require("../../infrastructure/config/runtime");
/**
 * ── WARUM DIE ANMELDUNG EINE SCHRANKE BRAUCHT ───────────────────────────────
 *
 * `LoginUseCase` rechnet auf JEDEM Versuch genau einen bcrypt-Vergleich —
 * auch bei einer unbekannten Adresse, gegen einen Blindwert. Das ist Absicht
 * und richtig: sonst verriete die Antwortzeit, welche Adressen es gibt.
 *
 * Der Preis dafür steht aber woanders. bcrypt mit Kostenfaktor 12 ist keine
 * Rechenarbeit im Hauptfaden, sondern eine Aufgabe im THREADPOOL von libuv —
 * und der hat vier Plätze, solange die Umgebung nichts anderes sagt (siehe
 * infrastructure/config/runtime.ts: aus dem Code heraus ist er nicht zu
 * vergrössern, deshalb ist DIESE Schranke die Hälfte, die wirkt). Vier gleichzeitige Anmeldeversuche belegen ihn
 * vollständig, für je ~250-400 ms. In dieser Zeit wartet alles andere, was
 * denselben Pool braucht: das Verkleinern hochgeladener Bilder (Sharp), jeder
 * Dateizugriff, jede DNS-Auflösung. Nicht die Anmeldung wird langsam — die
 * ganze Anwendung wird es.
 *
 * Der IP-Zähler der Route hilft dagegen nicht: `express-rate-limit` zählt
 * NACH der Antwort. Zwanzig gleichzeitig eintreffende Versuche laufen alle
 * schon, bevor der erste gezählt ist.
 *
 * ── ZWEI GRENZEN, ZWEI AUFGABEN ────────────────────────────────────────────
 *
 *  • Die GLOBALE Grenze schützt den Pool. Sie lässt bewusst Plätze frei, damit
 *    Bilder und Dateien auch unter Anmeldelast noch durchkommen. Wer über der
 *    Grenze ankommt, wird nicht abgewiesen, sondern kurz angestellt — eine
 *    Anmeldung, die 200 ms wartet, ist besser als eine, die scheitert.
 *
 *  • Die Grenze JE AUFRUFER weist ab statt anzustellen. Wer vier Vergleiche
 *    gleichzeitig offen hat, ist kein Mensch an einem Anmeldebildschirm.
 *
 * Beide Warteschlangen sind gedeckelt: eine unbegrenzte Warteschlange wäre
 * selbst das Angriffsziel.
 */
/**
 * Wie viele bcrypt-Aufgaben gleichzeitig laufen dürfen.
 *
 * Es sind ZWEI Decken, und die niedrigere gilt:
 *
 *  • Die KERNE. bcrypt rechnet, es wartet nicht — mehr gleichzeitige Vergleiche
 *    als Kerne bringen keinen Durchsatz, sie machen nur jeden einzelnen
 *    langsamer. Einer bleibt für den Hauptfaden.
 *  • Die PLÄTZE IM POOL, abzüglich einer Reserve. Sonst könnte die Anmeldung
 *    den Pool wieder vollständig belegen und genau das Problem zurückholen,
 *    gegen das diese Datei geschrieben ist. Bei den vier Plätzen der Vorgabe
 *    ist DIESE die bindende Grenze: zwei Vergleiche gleichzeitig, zwei Plätze
 *    bleiben für Dateien und Bilder.
 */
const globalLimit = () => {
    const configured = Number.parseInt(String(process.env.OFFITEC_BCRYPT_MAX_CONCURRENT || ''), 10);
    if (Number.isFinite(configured) && configured > 0)
        return configured;
    const pool = (0, runtime_1.threadpoolSize)();
    const reservedForOthers = Math.max(2, Math.ceil(pool / 4));
    return Math.max(2, Math.min(os_1.default.cpus().length - 1, pool - reservedForOthers));
};
/** Gleichzeitige Vergleiche EINES Aufrufers (Adresse bzw. Konto). */
const PER_KEY_LIMIT = 4;
/** Wie viele Aufgaben höchstens anstehen dürfen, bevor abgewiesen wird. */
const MAX_QUEUED = 64;
/** Wie lange eine Aufgabe höchstens ansteht. */
const MAX_WAIT_MS = 5_000;
const BUSY_MESSAGE = 'Sistem şu anda yoğun. Lütfen birkaç saniye sonra tekrar deneyin.';
let inFlight = 0;
const perKey = new Map();
const queue = [];
const releaseOne = () => {
    const next = queue.shift();
    if (!next)
        return;
    clearTimeout(next.timer);
    next.resolve();
};
const releaseKey = (key) => {
    const held = (perKey.get(key) ?? 1) - 1;
    if (held <= 0)
        perKey.delete(key);
    else
        perKey.set(key, held);
};
const acquire = async (key) => {
    const held = perKey.get(key) ?? 0;
    if (held >= PER_KEY_LIMIT) {
        // Kein Mensch hat vier Anmeldungen gleichzeitig offen.
        throw new AuthErrors_1.TooManyAttemptsError(BUSY_MESSAGE, 2);
    }
    /* Den Platz SOFORT belegen, nicht erst nach dem Anstehen.
       Sonst zählt die Grenze genau dann nicht, wenn sie gebraucht wird: treffen
       sechs Anfragen im selben Tick ein, sehen alle sechs den Stand 0, kommen
       alle durch diese Prüfung und stellen sich an. Gemessen war das auch so —
       null Abweisungen bei sechs gleichzeitigen Vergleichen EINES Aufrufers. */
    perKey.set(key, held + 1);
    try {
        if (inFlight >= globalLimit()) {
            if (queue.length >= MAX_QUEUED) {
                throw new AuthErrors_1.TooManyAttemptsError(BUSY_MESSAGE, 5);
            }
            await new Promise((resolve, reject) => {
                const waiter = {
                    resolve,
                    reject,
                    timer: setTimeout(() => {
                        const index = queue.indexOf(waiter);
                        if (index >= 0)
                            queue.splice(index, 1);
                        reject(new AuthErrors_1.TooManyAttemptsError(BUSY_MESSAGE, 5));
                    }, MAX_WAIT_MS),
                };
                queue.push(waiter);
            });
        }
    }
    catch (error) {
        // Wer gar nicht erst drankommt, gibt seine Belegung zurück.
        releaseKey(key);
        throw error;
    }
    inFlight += 1;
};
const release = (key) => {
    inFlight = Math.max(0, inFlight - 1);
    releaseKey(key);
    releaseOne();
};
/**
 * Führt eine bcrypt-Aufgabe unter den beiden Grenzen aus.
 *
 * `key` ist die Adresse des Aufrufers (unangemeldet) bzw. seine Kennung
 * (angemeldet). Fehlt sie, wird ein gemeinsamer Platzhalter benutzt — dann
 * greift nur die globale Grenze.
 */
const runBcryptGuarded = async (key, work) => {
    const gateKey = (key && key.trim()) || 'anonymous';
    await acquire(gateKey);
    try {
        return await work();
    }
    finally {
        release(gateKey);
    }
};
exports.runBcryptGuarded = runBcryptGuarded;
/** Nur für Tests und die Betriebsschau. */
const bcryptGateStats = () => ({
    inFlight,
    queued: queue.length,
    globalLimit: globalLimit(),
    perKeyLimit: PER_KEY_LIMIT,
    trackedKeys: perKey.size,
});
exports.bcryptGateStats = bcryptGateStats;
/** Nur für Tests: Zustand zurücksetzen. */
const resetBcryptGate = () => {
    for (const waiter of queue.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new AuthErrors_1.TooManyAttemptsError(BUSY_MESSAGE, 1));
    }
    inFlight = 0;
    perKey.clear();
};
exports.resetBcryptGate = resetBcryptGate;
//# sourceMappingURL=bcryptGate.js.map