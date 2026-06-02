"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RoleRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const PERMISSION_CACHE_TTL_MS = 60_000;
const permissionCache = new Map();
class RoleRepository {
    async getEmployeePermissions(employeeId) {
        const cached = permissionCache.get(employeeId);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.permissions;
        }
        const employeeRoles = await prisma_client_1.default.employeeRole.findMany({
            where: { employeeId },
            include: {
                role: {
                    include: {
                        permissions: {
                            include: {
                                permission: { select: { permissionName: true } }
                            }
                        }
                    }
                }
            }
        });
        const permissionsSet = new Set();
        employeeRoles.forEach(er => {
            er.role.permissions.forEach(rp => {
                permissionsSet.add(rp.permission.permissionName);
            });
        });
        const permissions = Array.from(permissionsSet);
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