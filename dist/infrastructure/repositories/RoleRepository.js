"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearPermissionCacheForRole = exports.clearPermissionCacheForEmployee = exports.RoleRepository = exports.roleCacheStats = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const pageCatalog_1 = require("../../shared/pageCatalog");
const tenantSwitchAccess_1 = require("../../shared/tenantSwitchAccess");
const ttlCache_1 = require("../../shared/ttlCache");
const PERMISSION_CACHE_TTL_MS = 60_000;
/* Begrenzt und selbstkehrend (siehe shared/ttlCache.ts): beide Zwischenspeicher
   waren einfache Maps, deren Lebensdauer nur gelesen und nie durchgesetzt
   wurde — kein Eintrag verschwand je wieder. */
const permissionCache = new ttlCache_1.TtlCache({ name: 'permissions', ttlMs: PERMISSION_CACHE_TTL_MS });
const permissionInFlight = new Map();
const pageAccessCache = new ttlCache_1.TtlCache({ name: 'pageAccess', ttlMs: PERMISSION_CACHE_TTL_MS });
const pageAccessInFlight = new Map();
const roleCacheStats = () => [permissionCache.stats(), pageAccessCache.stats()];
exports.roleCacheStats = roleCacheStats;
class RoleRepository {
    async getEmployeePermissions(employeeId) {
        const cached = permissionCache.get(employeeId);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.value;
        }
        const pending = permissionInFlight.get(employeeId);
        if (pending)
            return cached ? cached.value : pending;
        // Tek ifadeye indirildi. İç içe `include` zinciri (EmployeeRole → Role →
        // RolePermission → Permission) Prisma'da seviye başına AYRI bir sorgu
        // üretiyordu: 4 ardışık tur, uzak veritabanında ~400 ms. Aynı veri tek
        // join ile ~100 ms'e iniyor.
        const request = (async () => {
            const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT DISTINCT p.permissionName AS permissionName
                FROM EmployeeRole er
                JOIN RolePermission rp ON rp.roleId = er.roleId
                JOIN Permission p ON p.id = rp.permissionId
                WHERE er.employeeId = ${employeeId}
            `);
            const permissions = rows.map((row) => row.permissionName);
            permissionCache.set(employeeId, permissions);
            return permissions;
        })().finally(() => {
            permissionInFlight.delete(employeeId);
        });
        permissionInFlight.set(employeeId, request);
        // Süresi dolmuş liste bekletmez: bayat yetkiler hemen döner, tazeleme
        // arkada biter (stale-while-revalidate). Rol atamaları bu süreçte
        // `permissionCache.delete` çağırdığı için anında etki korunur; TTL
        // yalnızca süreç dışı değişikliklerde ~tazeleme süresi kadar esner.
        return cached ? cached.value : request;
    }
    async assignRoleToEmployee(employeeId, roleId) {
        await prisma_client_1.default.employeeRole.deleteMany({ where: { employeeId } });
        await prisma_client_1.default.employeeRole.create({ data: { employeeId, roleId } });
        (0, exports.clearPermissionCacheForEmployee)(employeeId);
    }
    /** Alle Rollen einer Person abziehen (kein Zugang mehr über eine Rolle). */
    async clearRolesOfEmployee(employeeId) {
        await prisma_client_1.default.employeeRole.deleteMany({ where: { employeeId } });
        (0, exports.clearPermissionCacheForEmployee)(employeeId);
    }
    /**
     * Seitenzugriff EINER Person (Vorgabe 17.08.2026): die Stufenkarte der
     * zugewiesenen Rolle. Die Administratorrolle bekommt alles; eine Altrolle
     * ohne gespeicherte Karte wird aus ihren Rechten zurückgerechnet, damit
     * nach dem Aufspielen niemand vor einem leeren Menü steht.
     *
     * Läuft über denselben stale-while-revalidate-Cache wie die Rechte: die
     * Karte hängt an derselben Zeile und darf nicht einen zweiten Rundgang zur
     * fernen Datenbank kosten.
     */
    async getEmployeePageAccess(employeeId) {
        return (await this.getEmployeeRoleInfo(employeeId)).pageAccess;
    }
    /**
     * Seitenstufen UND Administratorkennzeichen in einem Zug. Das Kennzeichen
     * brauchen die gefährlichen Aktionen (Massenlöschung von Produkten): sie
     * verlangen von jedem ANDEREN Konto das Kennwort zur Bestätigung.
     */
    async getEmployeeRoleInfo(employeeId) {
        const cached = pageAccessCache.get(employeeId);
        if (cached && cached.expiresAt > Date.now())
            return cached.value;
        const pending = pageAccessInFlight.get(employeeId);
        if (pending)
            return cached ? cached.value : pending;
        const request = (async () => {
            // Eine Anweisung: Rolle + ihre Rechtenamen in einem Join — die
            // verschachtelte include-Kette kostete hier vier Rundgänge.
            const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT r.id AS roleId, r.pageLevels AS pageLevels, r.isSystemAdmin AS isSystemAdmin,
                       p.permissionName AS permissionName
                FROM EmployeeRole er
                JOIN Role r ON r.id = er.roleId
                LEFT JOIN RolePermission rp ON rp.roleId = r.id
                LEFT JOIN Permission p ON p.id = rp.permissionId
                WHERE er.employeeId = ${employeeId}
            `);
            const merged = {};
            let isSystemAdmin = false;
            const byRole = new Map();
            for (const row of rows) {
                const entry = byRole.get(row.roleId) ?? {
                    pageLevels: row.pageLevels,
                    isSystemAdmin: Boolean(row.isSystemAdmin),
                    names: [],
                };
                if (row.permissionName)
                    entry.names.push(row.permissionName);
                byRole.set(row.roleId, entry);
            }
            for (const role of byRole.values()) {
                if (role.isSystemAdmin)
                    isSystemAdmin = true;
                // MySQL liefert JSON je nach Treiber als Zeichenkette zurück.
                let stored = role.pageLevels;
                if (typeof stored === 'string') {
                    try {
                        stored = JSON.parse(stored);
                    }
                    catch {
                        stored = null;
                    }
                }
                const levels = role.isSystemAdmin
                    ? { ...pageCatalog_1.ADMIN_PAGE_LEVELS }
                    : (stored && typeof stored === 'object'
                        ? (0, pageCatalog_1.sanitizePageLevels)(stored)
                        : (0, pageCatalog_1.pageLevelsFromPermissions)(role.names));
                // Mehrere Rollen (Altbestand): die HÖCHSTE Stufe gewinnt.
                for (const [pageKey, level] of Object.entries(levels)) {
                    if ((merged[pageKey] ?? 0) < level)
                        merged[pageKey] = level;
                }
            }
            const info = { pageAccess: merged, isSystemAdmin };
            pageAccessCache.set(employeeId, info);
            return info;
        })().finally(() => {
            pageAccessInFlight.delete(employeeId);
        });
        pageAccessInFlight.set(employeeId, request);
        return cached ? cached.value : request;
    }
}
exports.RoleRepository = RoleRepository;
/** Rechte- UND Seitencache einer Person leeren (Rollenwechsel, Kennwort). */
const clearPermissionCacheForEmployee = (employeeId) => {
    permissionCache.delete(employeeId);
    permissionInFlight.delete(employeeId);
    pageAccessCache.delete(employeeId);
    pageAccessInFlight.delete(employeeId);
    /* Die Reichweite des Firmenumschalters haengt an derselben Rolle
       (`Role.canSwitchTenant`, 31.08.2026) und wird hier mitgeleert. Sonst
       bliebe ein ENTZOGENES Recht bis zum Ablauf der TTL bestehen — das darf
       bei einer Zugriffsgrenze nicht passieren. */
    (0, tenantSwitchAccess_1.invalidateTenantSwitchAccess)(employeeId);
};
exports.clearPermissionCacheForEmployee = clearPermissionCacheForEmployee;
/**
 * Nach dem Umbau EINER Rolle: der Cache jeder Person, die sie trägt. Ohne das
 * griffe eine geänderte Stufe erst nach Ablauf der TTL — auf einer Seite, auf
 * der man die Wirkung sofort sehen will.
 */
const clearPermissionCacheForRole = async (roleId) => {
    const holders = await prisma_client_1.default.employeeRole.findMany({ where: { roleId }, select: { employeeId: true } });
    for (const holder of holders)
        (0, exports.clearPermissionCacheForEmployee)(holder.employeeId);
};
exports.clearPermissionCacheForRole = clearPermissionCacheForRole;
//# sourceMappingURL=RoleRepository.js.map