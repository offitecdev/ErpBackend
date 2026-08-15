"use strict";
/**
 * Kurzlebiger Zwischenspeicher der Personal-Kurzliste (/employees/directory).
 *
 * Die Datenbank liegt AUF EINEM ENTFERNTEN SERVER: jede Anweisung kostet eine
 * Netzrunde, egal wie billig die Abfrage ist. Die Personalliste ist für alle
 * Personen desselben Firmenbaums identisch und ändert sich fast nie, wurde aber
 * bei JEDEM Öffnen eines Auswahlfelds neu geholt — beim Erfassen einer Aufgabe
 * fällt genau das als Trägheit auf.
 *
 * Deshalb: Ergebnis je Firmenbaum kurz halten, gleichzeitige Anfragen teilen
 * sich eine Abfrage (kalter Start: N Anfragen = 1 Abfrage). Die Frist ist die
 * Obergrenze, um die eine gerade angelegte Person zu spät auftauchen kann;
 * jeder schreibende Personalweg ruft zusätzlich `invalidateStaffDirectory()`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCachedStaffDirectory = exports.invalidateStaffDirectory = void 0;
const STAFF_DIRECTORY_TTL_MS = 30_000;
const cache = new Map();
const inFlight = new Map();
/** Nach jeder Personaländerung aufrufen — sonst hinkt die Liste bis zur Frist. */
const invalidateStaffDirectory = () => {
    cache.clear();
    inFlight.clear();
};
exports.invalidateStaffDirectory = invalidateStaffDirectory;
/**
 * Liefert die Liste aus dem Speicher oder holt sie über `load`. Der Schlüssel
 * muss ALLE Eingaben der Abfrage enthalten (Mandanten, Filter) — sonst bekäme
 * ein Aufrufer die Liste eines anderen Zuschnitts.
 */
const getCachedStaffDirectory = async (key, load) => {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now())
        return hit.rows;
    const pending = inFlight.get(key);
    if (pending)
        return pending;
    const request = load()
        .then((rows) => {
        cache.set(key, { expiresAt: Date.now() + STAFF_DIRECTORY_TTL_MS, rows });
        return rows;
    })
        .finally(() => {
        inFlight.delete(key);
    });
    inFlight.set(key, request);
    return request;
};
exports.getCachedStaffDirectory = getCachedStaffDirectory;
//# sourceMappingURL=staffDirectoryCache.js.map