"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const Tenant_1 = require("../../domain/entities/Tenant");
const nanoid_1 = require("nanoid");
class TenantRepository {
    mapToEntity(data) {
        return new Tenant_1.Tenant(data.id, data.tenantName, data.isActive, data.createdAt, data.parentTenantId, data.checkInQrSecret ?? null, data.checkOutQrSecret ?? null, data.workScheduleJson ?? null, data.isProjectModuleEnabled ?? false);
    }
    async create(tenantData) {
        const data = await prisma_client_1.default.tenant.create({
            data: {
                id: tenantData.id || (0, nanoid_1.nanoid)(8),
                tenantName: typeof tenantData.tenantName === 'object'
                    ? tenantData.tenantName.tenantName
                    : tenantData.tenantName,
                parentTenantId: tenantData.parentTenantId || null,
                isActive: tenantData.isActive ?? true,
                isProjectModuleEnabled: tenantData.isProjectModuleEnabled ?? false,
            }
        });
        return this.mapToEntity(data);
    }
    async update(id, tenantData) {
        const data = await prisma_client_1.default.tenant.update({
            where: { id },
            data: tenantData
        });
        return this.mapToEntity(data);
    }
    async findById(id) {
        const data = await prisma_client_1.default.tenant.findUnique({ where: { id } });
        return data ? this.mapToEntity(data) : null;
    }
    async findAll() {
        const data = await prisma_client_1.default.tenant.findMany();
        return data.map(item => this.mapToEntity(item));
    }
}
exports.TenantRepository = TenantRepository;
//# sourceMappingURL=TenantRepository.js.map