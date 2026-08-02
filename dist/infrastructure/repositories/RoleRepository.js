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
class RoleRepository {
    async getEmployeePermissions(employeeId) {
        const cached = permissionCache.get(employeeId);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.permissions;
        }
        // Tek ifadeye indirildi. İç içe `include` zinciri (EmployeeRole → Role →
        // RolePermission → Permission) Prisma'da seviye başına AYRI bir sorgu
        // üretiyordu: 4 ardışık tur, uzak veritabanında ~400 ms. Aynı veri tek
        // join ile ~100 ms'e iniyor.
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
    }
    async assignRoleToEmployee(employeeId, roleId) {
        await prisma_client_1.default.employeeRole.deleteMany({ where: { employeeId } });
        await prisma_client_1.default.employeeRole.create({ data: { employeeId, roleId } });
        permissionCache.delete(employeeId);
    }
}
exports.RoleRepository = RoleRepository;
//# sourceMappingURL=RoleRepository.js.map