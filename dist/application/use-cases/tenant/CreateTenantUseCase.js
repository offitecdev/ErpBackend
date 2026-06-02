"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateTenantUseCase = void 0;
class CreateTenantUseCase {
    tenantRepository;
    constructor(tenantRepository) {
        this.tenantRepository = tenantRepository;
    }
    async execute(input) {
        const tenantName = typeof input === 'string' ? input : input.tenantName;
        const parentTenantId = typeof input === 'string' ? undefined : input.parentTenantId;
        const isProjectModuleEnabled = typeof input === 'string' ? false : Boolean(input.isProjectModuleEnabled);
        if (parentTenantId) {
            const parent = await this.tenantRepository.findById(parentTenantId);
            if (!parent) {
                throw new Error('Üst şirket bulunamadı.');
            }
        }
        return await this.tenantRepository.create({
            tenantName: tenantName,
            parentTenantId: parentTenantId,
            isActive: true,
            isProjectModuleEnabled,
        });
    }
}
exports.CreateTenantUseCase = CreateTenantUseCase;
//# sourceMappingURL=CreateTenantUseCase.js.map