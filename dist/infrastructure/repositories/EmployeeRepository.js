"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmployeeRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const Employee_1 = require("../../domain/entities/Employee");
class EmployeeRepository {
    mapToEntity(data) {
        const firstRole = data.employeeRoles?.[0]?.role;
        const emp = new Employee_1.Employee(data.id, data.tenantId, data.firstName, data.lastName, data.email, data.passwordHash, data.isActive, data.title, data.departmentId, firstRole?.roleName ?? data.roleName, data.phone, data.address, data.hireDate, data.terminationDate, data.annualLeaveEntitlement, data.profilePictureUrl, data.notes, data.createdAt, data.updatedAt, firstRole?.id ?? null);
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
        const whereClause = { tenantId: filters.tenantId };
        if (filters.isActive !== undefined)
            whereClause.isActive = filters.isActive;
        if (filters.departmentId)
            whereClause.departmentId = filters.departmentId;
        if (filters.roleName)
            whereClause.roleName = filters.roleName;
        if (filters.search) {
            whereClause.OR = [
                { firstName: { contains: filters.search } },
                { lastName: { contains: filters.search } },
                { email: { contains: filters.search } },
                { phone: { contains: filters.search } }
            ];
        }
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
            notes: coreData.notes ?? null
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
        return this.mapToEntity(data);
    }
    async update(id, updateData) {
        const { id: _id, tenantId: _tid, roleId: _roleId, ...safeData } = updateData;
        const data = await prisma_client_1.default.employee.update({
            where: { id },
            data: safeData,
            include: this.roleInclude,
        });
        return this.mapToEntity(data);
    }
}
exports.EmployeeRepository = EmployeeRepository;
//# sourceMappingURL=EmployeeRepository.js.map