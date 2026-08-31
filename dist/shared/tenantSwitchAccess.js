"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mayReachWholeCompanyTree = exports.clearTenantSwitchAccessCache = exports.invalidateTenantSwitchAccess = void 0;
/**
 * ── WER DEN GANZEN KONZERNBAUM ERREICHT (31.08.2026, Vorgabe) ────────────────
 *
 * Bis hierher hing die Reichweite des Firmenumschalters allein an der PERSON
 * (`Employee.allowedTenantIds`, gesetzt unter Personal → Person → Zugang). Wer
 * nichts angehakt hatte, sah nur die eigene Firma. Das ist fuer Personal einer
 * Untergesellschaft genau richtig — fuer die Verwaltung und die Projektleitung
 * aber falsch: die arbeiten ueber alle Haeuser hinweg und mussten bei jeder
 * neuen Firma von Hand nachgetragen werden.
 *
 * Jetzt darf es auch die ROLLE tragen: `Role.canSwitchTenant`, ein Schalter auf
 * der Rollenkarte (Einstellungen → Berechtigungen). Die Administratorrolle
 * (`Role.isSystemAdmin`) gilt immer als berechtigt, ohne eigene Spalte — sie
 * ist fest und soll sich das Recht nicht abwaehlen lassen koennen.
 *
 * DIE GRENZE BLEIBT DER EIGENE BAUM. Diese Flagge oeffnet den Konzern, in dem
 * die Person angestellt ist, und NIE eine fremde Firmengruppe — das prueft
 * `assertSameCompanyTree` in der AuthMiddleware unveraendert weiter.
 *
 * MITGLIEDSCHAFT ≠ REICHWEITE. `Employee.allowedTenantIds` entscheidet nach wie
 * vor, in wessen Personalliste jemand steht (siehe serviceTenantScope.ts);
 * diese Flagge sagt nur, welche Firmen der Umschalter anbietet. Wer als
 * Administrator eine fremde Firma waehlt, sieht dort deren Daten — aber steht
 * deswegen nicht in ihrer Mannschaft.
 *
 * WARUM EIN EIGENER, TRAEGER CACHE: die Antwort wird im heissen Pfad gebraucht
 * (`resolveTenantId` bei jeder Anfrage mit x-tenant-id), aber nur dann, wenn
 * die gewuenschte Firma nicht ohnehin schon zugeteilt ist. Deshalb steht sie
 * nicht in `authIdentityCache` — dort haette der Join jede Anfrage verteuert,
 * auch die von Leuten, die nie umschalten. Lebensdauer wie beim Rechtecache
 * (60 s); jede Rollenaenderung leert ihn ueber `clearPermissionCacheForEmployee`
 * sofort mit.
 */
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../infrastructure/database/prisma.client"));
const TENANT_SWITCH_CACHE_TTL_MS = 60_000;
const cache = new Map();
const inFlight = new Map();
const invalidateTenantSwitchAccess = (employeeId) => {
    cache.delete(employeeId);
    inFlight.delete(employeeId);
};
exports.invalidateTenantSwitchAccess = invalidateTenantSwitchAccess;
const clearTenantSwitchAccessCache = () => {
    cache.clear();
    inFlight.clear();
};
exports.clearTenantSwitchAccessCache = clearTenantSwitchAccessCache;
/**
 * Traegt diese Person eine Rolle, die den ganzen eigenen Firmenbaum oeffnet?
 * (Administratorrolle oder eine Rolle mit gesetztem `canSwitchTenant`.)
 */
const mayReachWholeCompanyTree = async (employeeId) => {
    const cached = cache.get(employeeId);
    if (cached && cached.expiresAt > Date.now())
        return cached.allowed;
    const pending = inFlight.get(employeeId);
    if (pending)
        return cached ? cached.allowed : pending;
    // Eine Anweisung, ein Join: die verschachtelte include-Kette
    // (EmployeeRole → Role) kostete hier einen zweiten Rundgang zur fernen
    // Datenbank — siehe RoleRepository, gleiche Ueberlegung.
    const request = (async () => {
        const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT 1 AS allowed
            FROM EmployeeRole er
            JOIN Role r ON r.id = er.roleId
            WHERE er.employeeId = ${employeeId}
              AND (r.isSystemAdmin = 1 OR r.canSwitchTenant = 1)
            LIMIT 1
        `);
        const allowed = rows.length > 0;
        cache.set(employeeId, { expiresAt: Date.now() + TENANT_SWITCH_CACHE_TTL_MS, allowed });
        return allowed;
    })().finally(() => {
        inFlight.delete(employeeId);
    });
    inFlight.set(employeeId, request);
    // Abgelaufener Eintrag bekommt keine Wartezeit: die alte Antwort geht
    // sofort zurueck, die Auffrischung laeuft dahinter (stale-while-revalidate).
    // Ein ENTZOGENES Recht wirkt trotzdem sofort, weil jede Rollenaenderung den
    // Eintrag LOESCHT statt ihn auslaufen zu lassen.
    return cached ? cached.allowed : request;
};
exports.mayReachWholeCompanyTree = mayReachWholeCompanyTree;
//# sourceMappingURL=tenantSwitchAccess.js.map