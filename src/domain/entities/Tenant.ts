export class Tenant {
    constructor(
        public id: string,
        public tenantName: string,
        public isActive: boolean,
        public createdAt: Date,
        public parentTenantId?: string | null,
        public checkInQrSecret?: string | null,
        public checkOutQrSecret?: string | null,
        public workScheduleJson?: unknown | null,
        public isProjectModuleEnabled: boolean = false
    ) {}

}
