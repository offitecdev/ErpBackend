import prisma from '../database/prisma.client';
import { Prisma } from '@prisma/client';
import { IEmployeeRepository, IEmployeeFilter } from '../../domain/repositories/IEmployeeRepository';
import { Employee } from '../../domain/entities/Employee';

export class EmployeeRepository implements IEmployeeRepository {
    
    private mapToEntity(data: any): Employee {
        const firstRole = data.employeeRoles?.[0]?.role;
        const emp = new Employee(
            data.id, data.tenantId, data.firstName, data.lastName, 
            data.email, data.passwordHash, data.isActive, data.title, 
            data.departmentId, firstRole?.roleName ?? data.roleName, data.phone, data.address,
            data.hireDate, data.terminationDate, data.annualLeaveEntitlement,
            data.profilePictureUrl, data.notes, data.createdAt, data.updatedAt,
            firstRole?.id ?? null
        );
        return emp;
    }

    private readonly roleInclude = {
        employeeRoles: { include: { role: true } }
    } as const;

    async findByEmail(email: string): Promise<Employee | null> {
        const data = await prisma.employee.findUnique({
            where: { email },
            include: this.roleInclude,
        });
        return data ? this.mapToEntity(data) : null;
    }

    async findById(id: string): Promise<Employee | null> {
        const data = await prisma.employee.findUnique({
            where: { id },
            include: this.roleInclude,
        });
        return data ? this.mapToEntity(data) : null;
    }

    async findAll(filters: IEmployeeFilter): Promise<Employee[]> {
        const whereClause: any = { tenantId: filters.tenantId };

        if (filters.isActive !== undefined) whereClause.isActive = filters.isActive;
        if (filters.departmentId) whereClause.departmentId = filters.departmentId;
        const andConditions: any[] = [];

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

        if (andConditions.length) whereClause.AND = andConditions;

        const data = await prisma.employee.findMany({ 
            where: whereClause,
            orderBy: { createdAt: 'desc' },
            include: this.roleInclude,
        });
        return data.map(d => this.mapToEntity(d));
    }

    async create(employeeData: Partial<Employee> & { roleId?: string }): Promise<Employee> {
        const { roleId, ...coreData } = employeeData as any;

        const createData: Prisma.EmployeeUncheckedCreateInput = {
            id: coreData.id,
            tenantId: coreData.tenantId!,
            firstName: coreData.firstName!,
            lastName: coreData.lastName!,
            email: coreData.email!,
            passwordHash: coreData.passwordHash!,
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
            } as Prisma.EmployeeRoleUncheckedCreateNestedManyWithoutEmployeeInput;
        }

        const data = await prisma.employee.create({
            data: createData
        });

        return this.mapToEntity(data);
    }

    async update(id: string, updateData: Partial<Employee>): Promise<Employee> {
        const { id: _id, tenantId: _tid, roleId: _roleId, ...safeData } = updateData as any;
        const data = await prisma.employee.update({
            where: { id },
            data: safeData as any,
            include: this.roleInclude,
        });
        return this.mapToEntity(data);
    }
}
