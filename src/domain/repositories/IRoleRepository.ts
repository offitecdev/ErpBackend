export interface IRoleRepository {
    getEmployeePermissions(employeeId: string): Promise<string[]>;
    assignRoleToEmployee(employeeId: string, roleId: string): Promise<void>;
}