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
import { Prisma } from '@prisma/client';
import prisma from '../infrastructure/database/prisma.client';

const TENANT_SWITCH_CACHE_TTL_MS = 60_000;

const cache = new Map<string, { expiresAt: number; allowed: boolean }>();
const inFlight = new Map<string, Promise<boolean>>();

export const invalidateTenantSwitchAccess = (employeeId: string): void => {
    cache.delete(employeeId);
    inFlight.delete(employeeId);
};

export const clearTenantSwitchAccessCache = (): void => {
    cache.clear();
    inFlight.clear();
};

/**
 * Traegt diese Person eine Rolle, die den ganzen eigenen Firmenbaum oeffnet?
 * (Administratorrolle oder eine Rolle mit gesetztem `canSwitchTenant`.)
 */
export const mayReachWholeCompanyTree = async (employeeId: string): Promise<boolean> => {
    const cached = cache.get(employeeId);
    if (cached && cached.expiresAt > Date.now()) return cached.allowed;

    const pending = inFlight.get(employeeId);
    if (pending) return cached ? cached.allowed : pending;

    // Eine Anweisung, ein Join: die verschachtelte include-Kette
    // (EmployeeRole → Role) kostete hier einen zweiten Rundgang zur fernen
    // Datenbank — siehe RoleRepository, gleiche Ueberlegung.
    const request = (async () => {
        const rows = await prisma.$queryRaw<Array<{ allowed: number | bigint | null }>>(Prisma.sql`
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
