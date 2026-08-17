import { Prisma } from "@prisma/client";
import prisma from "../database/prisma.client"
import { IRoleRepository } from "../../domain/repositories/IRoleRepository";
import {
    ADMIN_PAGE_LEVELS,
    pageLevelsFromPermissions,
    sanitizePageLevels,
    type PageLevel,
} from "../../shared/pageCatalog";

const PERMISSION_CACHE_TTL_MS = 60_000;
const permissionCache = new Map<string, { expiresAt: number; permissions: string[] }>();
const permissionInFlight = new Map<string, Promise<string[]>>();
/**
 * Was die Rolle EINER Person über sie sagt: die Seitenstufen und ob sie die
 * Administratorrolle trägt. Beides steht in derselben Zeile, wird also in einem
 * Zug geholt und gemeinsam zwischengespeichert — gleiche Lebensdauer wie die
 * Rechte (siehe unten).
 */
export interface EmployeeRoleInfo {
    pageAccess: Record<string, PageLevel>;
    /** Administratorrolle (`Role.isSystemAdmin`) — siehe getEmployeeRoleInfo. */
    isSystemAdmin: boolean;
}

const pageAccessCache = new Map<string, { expiresAt: number; info: EmployeeRoleInfo }>();
const pageAccessInFlight = new Map<string, Promise<EmployeeRoleInfo>>();

export class RoleRepository implements IRoleRepository {

    async getEmployeePermissions(employeeId: string): Promise<string[]> {
        const cached = permissionCache.get(employeeId);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.permissions;
        }

        const pending = permissionInFlight.get(employeeId);
        if (pending) return cached ? cached.permissions : pending;

        // Tek ifadeye indirildi. İç içe `include` zinciri (EmployeeRole → Role →
        // RolePermission → Permission) Prisma'da seviye başına AYRI bir sorgu
        // üretiyordu: 4 ardışık tur, uzak veritabanında ~400 ms. Aynı veri tek
        // join ile ~100 ms'e iniyor.
        const request = (async () => {
            const rows = await prisma.$queryRaw<Array<{ permissionName: string }>>(Prisma.sql`
                SELECT DISTINCT p.permissionName AS permissionName
                FROM EmployeeRole er
                JOIN RolePermission rp ON rp.roleId = er.roleId
                JOIN Permission p ON p.id = rp.permissionId
                WHERE er.employeeId = ${employeeId}
            `);
            const permissions = rows.map((row) => row.permissionName);
            permissionCache.set(employeeId, {
                expiresAt: Date.now() + PERMISSION_CACHE_TTL_MS,
                permissions,
            });
            return permissions;
        })().finally(() => {
            permissionInFlight.delete(employeeId);
        });

        permissionInFlight.set(employeeId, request);
        // Süresi dolmuş liste bekletmez: bayat yetkiler hemen döner, tazeleme
        // arkada biter (stale-while-revalidate). Rol atamaları bu süreçte
        // `permissionCache.delete` çağırdığı için anında etki korunur; TTL
        // yalnızca süreç dışı değişikliklerde ~tazeleme süresi kadar esner.
        return cached ? cached.permissions : request;
    }

    async assignRoleToEmployee(employeeId: string, roleId: string): Promise<void> {
        await prisma.employeeRole.deleteMany({ where: { employeeId } });
        await prisma.employeeRole.create({ data: { employeeId, roleId } });
        clearPermissionCacheForEmployee(employeeId);
    }

    /** Alle Rollen einer Person abziehen (kein Zugang mehr über eine Rolle). */
    async clearRolesOfEmployee(employeeId: string): Promise<void> {
        await prisma.employeeRole.deleteMany({ where: { employeeId } });
        clearPermissionCacheForEmployee(employeeId);
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
    async getEmployeePageAccess(employeeId: string): Promise<Record<string, PageLevel>> {
        return (await this.getEmployeeRoleInfo(employeeId)).pageAccess;
    }

    /**
     * Seitenstufen UND Administratorkennzeichen in einem Zug. Das Kennzeichen
     * brauchen die gefährlichen Aktionen (Massenlöschung von Produkten): sie
     * verlangen von jedem ANDEREN Konto das Kennwort zur Bestätigung.
     */
    async getEmployeeRoleInfo(employeeId: string): Promise<EmployeeRoleInfo> {
        const cached = pageAccessCache.get(employeeId);
        if (cached && cached.expiresAt > Date.now()) return cached.info;

        const pending = pageAccessInFlight.get(employeeId);
        if (pending) return cached ? cached.info : pending;

        const request = (async () => {
            // Eine Anweisung: Rolle + ihre Rechtenamen in einem Join — die
            // verschachtelte include-Kette kostete hier vier Rundgänge.
            const rows = await prisma.$queryRaw<Array<{
                roleId: string;
                pageLevels: unknown;
                isSystemAdmin: number | boolean | null;
                permissionName: string | null;
            }>>(Prisma.sql`
                SELECT r.id AS roleId, r.pageLevels AS pageLevels, r.isSystemAdmin AS isSystemAdmin,
                       p.permissionName AS permissionName
                FROM EmployeeRole er
                JOIN Role r ON r.id = er.roleId
                LEFT JOIN RolePermission rp ON rp.roleId = r.id
                LEFT JOIN Permission p ON p.id = rp.permissionId
                WHERE er.employeeId = ${employeeId}
            `);

            const merged: Record<string, PageLevel> = {};
            let isSystemAdmin = false;
            const byRole = new Map<string, { pageLevels: unknown; isSystemAdmin: boolean; names: string[] }>();
            for (const row of rows) {
                const entry = byRole.get(row.roleId) ?? {
                    pageLevels: row.pageLevels,
                    isSystemAdmin: Boolean(row.isSystemAdmin),
                    names: [],
                };
                if (row.permissionName) entry.names.push(row.permissionName);
                byRole.set(row.roleId, entry);
            }

            for (const role of byRole.values()) {
                if (role.isSystemAdmin) isSystemAdmin = true;
                // MySQL liefert JSON je nach Treiber als Zeichenkette zurück.
                let stored: unknown = role.pageLevels;
                if (typeof stored === 'string') {
                    try { stored = JSON.parse(stored); } catch { stored = null; }
                }
                const levels = role.isSystemAdmin
                    ? { ...ADMIN_PAGE_LEVELS }
                    : (stored && typeof stored === 'object'
                        ? sanitizePageLevels(stored)
                        : pageLevelsFromPermissions(role.names));
                // Mehrere Rollen (Altbestand): die HÖCHSTE Stufe gewinnt.
                for (const [pageKey, level] of Object.entries(levels)) {
                    if ((merged[pageKey] ?? 0) < level) merged[pageKey] = level;
                }
            }

            const info: EmployeeRoleInfo = { pageAccess: merged, isSystemAdmin };
            pageAccessCache.set(employeeId, { expiresAt: Date.now() + PERMISSION_CACHE_TTL_MS, info });
            return info;
        })().finally(() => {
            pageAccessInFlight.delete(employeeId);
        });

        pageAccessInFlight.set(employeeId, request);
        return cached ? cached.info : request;
    }
}

/** Rechte- UND Seitencache einer Person leeren (Rollenwechsel, Kennwort). */
export const clearPermissionCacheForEmployee = (employeeId: string): void => {
    permissionCache.delete(employeeId);
    permissionInFlight.delete(employeeId);
    pageAccessCache.delete(employeeId);
    pageAccessInFlight.delete(employeeId);
};

/**
 * Nach dem Umbau EINER Rolle: der Cache jeder Person, die sie trägt. Ohne das
 * griffe eine geänderte Stufe erst nach Ablauf der TTL — auf einer Seite, auf
 * der man die Wirkung sofort sehen will.
 */
export const clearPermissionCacheForRole = async (roleId: string): Promise<void> => {
    const holders = await prisma.employeeRole.findMany({ where: { roleId }, select: { employeeId: true } });
    for (const holder of holders) clearPermissionCacheForEmployee(holder.employeeId);
};
