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

export interface TtlCacheOptions {
    /** Wie lange ein Eintrag als frisch gilt. */
    ttlMs: number;
    /**
     * Wie lange ein ABGELAUFENER Eintrag noch als "alte Antwort" herumliegen
     * darf, bevor der Kehrbesen ihn nimmt. Muss deutlich über der Dauer einer
     * Auffrischung liegen, sonst geht stale-while-revalidate verloren.
     */
    staleGraceMs?: number;
    /** Harte Obergrenze an Einträgen. */
    maxEntries?: number;
    /** Abstand der Kehrgänge. */
    sweepIntervalMs?: number;
    /** Nur zur Fehlersuche: taucht in `stats()` auf. */
    name?: string;
}

export interface TtlCacheEntry<V> {
    expiresAt: number;
    value: V;
}

export class TtlCache<V> {
    private readonly store = new Map<string, TtlCacheEntry<V>>();
    private readonly ttlMs: number;
    private readonly staleGraceMs: number;
    private readonly maxEntries: number;
    private readonly timer: NodeJS.Timeout;
    readonly name: string;

    constructor(options: TtlCacheOptions) {
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
    get(key: string): TtlCacheEntry<V> | undefined {
        return this.store.get(key);
    }

    set(key: string, value: V): void {
        // Erst löschen, dann setzen: `Map` behält beim Überschreiben die alte
        // Position, und die Reihenfolge ist unten das Ausscheidungskriterium.
        this.store.delete(key);
        this.store.set(key, { expiresAt: Date.now() + this.ttlMs, value });

        if (this.store.size > this.maxEntries) {
            const oldest = this.store.keys().next();
            if (!oldest.done) this.store.delete(oldest.value);
        }
    }

    delete(key: string): void {
        this.store.delete(key);
    }

    clear(): void {
        this.store.clear();
    }

    get size(): number {
        return this.store.size;
    }

    /** Räumt weg, was auch als alte Antwort nichts mehr taugt. */
    sweep(): number {
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
    stop(): void {
        clearInterval(this.timer);
    }
}
