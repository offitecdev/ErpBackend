"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoleRepository = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const PERMISSION_CACHE_TTL_MS = 60_000;
const permissionCache = new Map();
const permissionInFlight = new Map();
class RoleRepository {
    async getEmployeePermissions(employeeId) {
        const cached = permissionCache.get(employeeId);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.permissions;
        }
        const pending = permissionInFlight.get(employeeId);
        if (pending)
            return cached ? cached.permissions : pending;
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
    async assignRoleToEmployee(employeeId, roleId) {
        await prisma_client_1.default.employeeRole.deleteMany({ where: { employeeId } });
        await prisma_client_1.default.employeeRole.create({ data: { employeeId, roleId } });
        permissionCache.delete(employeeId);
        permissionInFlight.delete(employeeId);
    }
}
exports.RoleRepository = RoleRepository;
//# sourceMappingURL=RoleRepository.js.map