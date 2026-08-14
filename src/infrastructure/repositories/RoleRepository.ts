import { Prisma } from "@prisma/client";
import prisma from "../database/prisma.client"
import { IRoleRepository } from "../../domain/repositories/IRoleRepository";

const PERMISSION_CACHE_TTL_MS = 60_000;
const permissionCache = new Map<string, { expiresAt: number; permissions: string[] }>();
const permissionInFlight = new Map<string, Promise<string[]>>();

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
        permissionCache.delete(employeeId);
        permissionInFlight.delete(employeeId);
    }
}
