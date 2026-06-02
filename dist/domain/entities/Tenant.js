"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Tenant = void 0;
class Tenant {
    id;
    tenantName;
    isActive;
    createdAt;
    parentTenantId;
    checkInQrSecret;
    checkOutQrSecret;
    workScheduleJson;
    isProjectModuleEnabled;
    constructor(id, tenantName, isActive, createdAt, parentTenantId, checkInQrSecret, checkOutQrSecret, workScheduleJson, isProjectModuleEnabled = false) {
        this.id = id;
        this.tenantName = tenantName;
        this.isActive = isActive;
        this.createdAt = createdAt;
        this.parentTenantId = parentTenantId;
        this.checkInQrSecret = checkInQrSecret;
        this.checkOutQrSecret = checkOutQrSecret;
        this.workScheduleJson = workScheduleJson;
        this.isProjectModuleEnabled = isProjectModuleEnabled;
    }
}
exports.Tenant = Tenant;
//# sourceMappingURL=Tenant.js.map