"use strict";
/**
 * ── EIN ZWISCHENSPEICHER, DER AUCH WIEDER LEER WIRD ─────────────────────────
 *
 * Die vier Zwischenspeicher der Anmeldeschicht — `authIdentityCache`, die
 * beiden in `RoleRepository` (Rechte, Seitenstufen) und `tenantSwitchAccess` —
 * waren schlichte `Map`s mit einer Lebensdauer, die nur GELESEN wurde:
 *
 *     const cached = cache.get(id);
 *     if (cached && cached.expiresAt > Date.now()) return cached.value;
 *
 * Abgelaufen heisst hier "wird nicht mehr geglaubt" — nicht "wird entfernt".
 * Kein Eintrag ist je verschwunden. Wer einmal eine Anfrage gestellt hat, stand
 * bis zum Neustart im Speicher. Heute ist das durch die Belegschaft begrenzt
 * und damit klein; es wird in dem Augenblick zum Leck, in dem ein Schlüssel
 * vom Aufrufer beeinflussbar ist.
 *
 * ── WARUM `get` NICHT SELBST AUFRÄUMT ───────────────────────────────────────
 *
 * Die Aufrufer lesen ABGELAUFENE Einträge absichtlich weiter: sie geben die
 * alte Antwort sofort zurück und frischen dahinter auf
 * (stale-while-revalidate). Würde `get` den abgelaufenen Eintrag wegwerfen,
 * fiele jede Auffrischung wieder auf eine blockierende Abfrage zurück — aus
 * einer Aufräumarbeit würde eine Verlangsamung.
 *
 * Deshalb: `get` gibt den Eintrag heraus, wie er ist, und der Aufrufer
 * entscheidet. Weggeräumt wird erst, was seit `staleGraceMs` NIEMAND mehr
 * gelesen hat — dann ist auch die alte Antwort nichts mehr wert.
 *
 * Zusätzlich eine harte Obergrenze: ist sie erreicht, fällt der am längsten
 * nicht geschriebene Eintrag heraus. Damit ist der Speicher gedeckelt, auch
 * wenn der Kehrbesen einmal nicht liefe.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TtlCache = void 0;
class TtlCache {
    store = new Map();
    ttlMs;
    staleGraceMs;
    maxEntries;
    timer;
    name;
    constructor(options) {
        this.ttlMs = options.ttlMs;
        this.staleGraceMs = options.staleGraceMs ?? 10 * 60_000;
        this.maxEntries = options.maxEntries ?? 10_000;
        this.name = options.name ?? 'ttlCache';
        this.timer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? 60_000);
        // Der Kehrbesen darf den Vorgang nicht am Leben halten — sonst beendet
        // sich kein Skript mehr, das dieses Modul nur mitzieht.
        this.timer.unref?.();
    }
    /**
     * Gibt den Eintrag heraus, OHNE auf Ablauf zu prüfen. Der Aufrufer
     * entscheidet, ob er ihn noch glaubt (siehe Kopf dieser Datei).
     */
    get(key) {
        return this.store.get(key);
    }
    set(key, value) {
        // Erst löschen, dann setzen: `Map` behält beim Überschreiben die alte
        // Position, und die Reihenfolge ist unten das Ausscheidungskriterium.
        this.store.delete(key);
        this.store.set(key, { expiresAt: Date.now() + this.ttlMs, value });
        if (this.store.size > this.maxEntries) {
            const oldest = this.store.keys().next();
            if (!oldest.done)
                this.store.delete(oldest.value);
        }
    }
    delete(key) {
        this.store.delete(key);
    }
    clear() {
        this.store.clear();
    }
    get size() {
        return this.store.size;
    }
    /** Räumt weg, was auch als alte Antwort nichts mehr taugt. */
    sweep() {
        const deadline = Date.now() - this.staleGraceMs;
        let removed = 0;
        for (const [key, entry] of this.store) {
            if (entry.expiresAt < deadline) {
                this.store.delete(key);
                removed += 1;
            }
        }
        return removed;
    }
    stats() {
        return { name: this.name, size: this.store.size, maxEntries: this.maxEntries };
    }
    /** Nur für Tests: hält den Kehrbesen an. */
    stop() {
        clearInterval(this.timer);
    }
}
exports.TtlCache = TtlCache;
//# sourceMappingURL=ttlCache.js.map