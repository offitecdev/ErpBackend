"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmployeeRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const client_1 = require("@prisma/client");
const Employee_1 = require("../../domain/entities/Employee");
const authIdentityCache_1 = require("../../shared/authIdentityCache");
const staffDirectoryCache_1 = require("../../shared/staffDirectoryCache");
class EmployeeRepository {
    mapToEntity(data) {
        const firstRole = data.employeeRoles?.[0]?.role;
        const emp = new Employee_1.Employee(data.id, data.tenantId, data.firstName, data.lastName, data.email, data.passwordHash, data.isActive, data.title, data.departmentId, firstRole?.roleName ?? data.roleName, data.phone, data.address, data.hireDate, data.terminationDate, data.annualLeaveEntitlement, data.profilePictureUrl, data.notes, data.createdAt, data.updatedAt, firstRole?.id ?? null, data.passwordChangedAt, data.deletedAt, data.bannedAt, Array.isArray(data.moduleKeys) ? data.moduleKeys : null, Array.isArray(data.allowedTenantIds) ? data.allowedTenantIds : null);
        return emp;
    }
    roleInclude = {
        employeeRoles: { include: { role: true } }
    };
    async findByEmail(email) {
        const data = await prisma_client_1.default.employee.findUnique({
            where: { email },
            include: this.roleInclude,
        });
        return data ? this.mapToEntity(data) : null;
    }
    async findById(id) {
        const data = await prisma_client_1.default.employee.findUnique({
            where: { id },
            include: this.roleInclude,
        });
        return data ? this.mapToEntity(data) : null;
    }
    async findAll(filters) {
        const whereClause = filters.tenantIds?.length
            ? { tenantId: { in: filters.tenantIds } }
            : { tenantId: filters.tenantId };
        if (filters.isActive !== undefined)
            whereClause.isActive = filters.isActive;
        if (filters.departmentId)
            whereClause.departmentId = filters.departmentId;
        const andConditions = [];
        if (filters.roleName) {
            andConditions.push({
                OR: [
                    { roleName: filters.roleName },
                    { employeeRoles: { some: { role: { roleName: filters.roleName } } } },
                ],
            });
        }
        if (filters.search) {
            andConditions.push({
                OR: [
                    { firstName: { contains: filters.search } },
                    { lastName: { contains: filters.search } },
                    { email: { contains: filters.search } },
                    { phone: { contains: filters.search } }
                ],
            });
        }
        if (andConditions.length)
            whereClause.AND = andConditions;
        const data = await prisma_client_1.default.employee.findMany({
            where: whereClause,
            orderBy: { createdAt: 'desc' },
            include: this.roleInclude,
        });
        return data.map(d => this.mapToEntity(d));
    }
    async create(employeeData) {
        const { roleId, ...coreData } = employeeData;
        const createData = {
            id: coreData.id,
            tenantId: coreData.tenantId,
            firstName: coreData.firstName,
            lastName: coreData.lastName,
            email: coreData.email,
            passwordHash: coreData.passwordHash,
            isActive: coreData.isActive ?? true,
            title: coreData.title ?? null,
            departmentId: coreData.departmentId ?? null,
            roleName: coreData.roleName ?? null,
            phone: coreData.phone ?? null,
            address: coreData.address ?? null,
            hireDate: coreData.hireDate ?? null,
            terminationDate: coreData.terminationDate ?? null,
            annualLeaveEntitlement: coreData.annualLeaveEntitlement ?? 0,
            profilePictureUrl: coreData.profilePictureUrl ?? null,
            notes: coreData.notes ?? null,
            moduleKeys: coreData.moduleKeys ?? undefined,
            allowedTenantIds: coreData.allowedTenantIds ?? undefined,
        };
        if (roleId) {
            createData.employeeRoles = {
                create: {
                    roleId
                }
            };
        }
        const data = await prisma_client_1.default.employee.create({
            data: createData
        });
        // Die Personal-Kurzliste der Auswahlfelder ist kurz zwischengespeichert;
        // ohne diesen Aufruf fehlte die neue Person dort bis zum Ablauf der Frist.
        (0, staffDirectoryCache_1.invalidateStaffDirectory)();
        return this.mapToEntity(data);
    }
    async update(id, updateData) {
        const { id: _id, tenantId: _tid, roleId: _roleId, ...safeData } = updateData;
        // Json? columns cannot be cleared with plain null.
        if (safeData.moduleKeys === null)
            safeData.moduleKeys = client_1.Prisma.DbNull;
        if (safeData.allowedTenantIds === null)
            safeData.allowedTenantIds = client_1.Prisma.DbNull;
        const data = await prisma_client_1.default.employee.update({
            where: { id },
            data: safeData,
            include: this.roleInclude,
        });
        // Ban / pasifleştirme / silme / parola değişimi / şirket ataması — hepsi
        // buradan geçer. Önbelleği hemen düşür ki oturum kontrolü bir sonraki
        // istekte güncel durumu görsün.
        (0, authIdentityCache_1.invalidateAuthIdentity)(id);
        // Name, Rolle, aktiv/gesperrt — all das steht in der Kurzliste der
        // Auswahlfelder. Jeder Schreibweg läuft hier durch, deshalb genügt
        // dieser eine Ort statt eines Aufrufs je Endpunkt.
        (0, staffDirectoryCache_1.invalidateStaffDirectory)();
        return this.mapToEntity(data);
    }
}
exports.EmployeeRepository = EmployeeRepository;
//# sourceMappingURL=EmployeeRepository.js.map