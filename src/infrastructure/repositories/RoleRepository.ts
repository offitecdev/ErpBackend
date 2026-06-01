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

        const employeeRoles = await prisma.employeeRole.findMany({
            where: { employeeId },
            include: {
                role: {
                    include: {
                       permissions : {
                        include : {
                            permission : { select: { permissionName: true } }
                        }
                       }
                    }
                }
            }
        });
        const permissionsSet = new Set<string>();

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

    async assignRoleToEmployee(employeeId: string, roleId: string): Promise<void> {
        await prisma.employeeRole.deleteMany({ where: { employeeId } });
        await prisma.employeeRole.create({ data: { employeeId, roleId } });
        permissionCache.delete(employeeId);
    }
}
