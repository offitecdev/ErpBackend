import { Prisma } from "@prisma/client";
import prisma from "../database/prisma.client"
import { IRoleRepository } from "../../domain/repositories/IRoleRepository";

const PERMISSION_CACHE_TTL_MS = 60_000;
const permissionCache = new Map<string, { expiresAt: number; permissions: string[] }>();

export class RoleRepository implements IRoleRepository {

    async getEmployeePermissions(employeeId: string): Promise<string[]> {
        const cached = permissionCache.get(employeeId);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.permissions;
        }

        // Tek ifadeye indirildi. İç içe `include` zinciri (EmployeeRole → Role →
        // RolePermission → Permission) Prisma'da seviye başına AYRI bir sorgu
        // üretiyordu: 4 ardışık tur, uzak veritabanında ~400 ms. Aynı veri tek
        // join ile ~100 ms'e iniyor.
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
    }

    async assignRoleToEmployee(employeeId: string, roleId: string): Promise<void> {
        await prisma.employeeRole.deleteMany({ where: { employeeId } });
        await prisma.employeeRole.create({ data: { employeeId, roleId } });
        permissionCache.delete(employeeId);
    }
}
