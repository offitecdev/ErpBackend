export class Employee {
    
    constructor(
        public id: string,
        public tenantId: string,
        public firstName: string,
        public lastName: string,
        public email: string,
        public passwordHash: string,
        public isActive: boolean,
        public title?: string | null,
        public departmentId?: string | null,
        public roleName?: string | null,
        public phone?: string | null,
        public address?: string | null,
        public hireDate?: Date | null,
        public terminationDate?: Date | null,
        public annualLeaveEntitlement?: number,
        public profilePictureUrl?: string | null,
        public notes?: string | null,
        public createdAt?: Date | null,
        public updatedAt?: Date | null,
        public roleId?: string | null,
    )  {}
}
