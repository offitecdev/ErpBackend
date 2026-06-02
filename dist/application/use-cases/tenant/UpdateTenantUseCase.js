"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateTenantUseCase = void 0;
class UpdateTenantUseCase {
    tenantRepository;
    constructor(tenantRepository) {
        this.tenantRepository = tenantRepository;
    }
    async execute(id, data) {
        const existingTenant = await this.tenantRepository.findById(id);
        if (!existingTenant) {
            throw new Error('Şirket bulunamadı.');
        }
        if (data.parentTenantId && data.parentTenantId === id) {
            throw new Error('Şirket kendi üst şirketi olamaz.');
        }
        return await this.tenantRepository.update(id, data);
    }
}
exports.UpdateTenantUseCase = UpdateTenantUseCase;
//# sourceMappingURL=UpdateTenantUseCase.js.map