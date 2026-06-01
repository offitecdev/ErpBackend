import { Employee } from "../entities/Employee";

export interface IEmployeeFilter{
    tenantId: string;
    isActive?: boolean | undefined;
    departmentId?: string;
    roleName?: string;
    search?: string;
}

export interface IEmployeeRepository {
    findByEmail(email: string): Promise<Employee | null>;
    findById(id: string): Promise<Employee | null>;
    findAll(filter: IEmployeeFilter): Promise<Employee[]>;
    create(employee: Partial<Employee>): Promise<Employee>;
    update(id: string, data: Partial<Employee>): Promise<Employee>;
}
