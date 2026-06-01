import { ITenantRepository } from "../../../domain/repositories/ITenantRepository";
import { Tenant } from "../../../domain/entities/Tenant";

export class CreateTenantUseCase {
    constructor(private tenantRepository: ITenantRepository) {}

    async execute(input: string | { tenantName: string; parentTenantId?: string | null; isProjectModuleEnabled?: boolean }): Promise<Tenant> {
        const tenantName = typeof input === 'string' ? input : input.tenantName;
        const parentTenantId = typeof input === 'string' ? undefined : input.parentTenantId;
        const isProjectModuleEnabled = typeof input === 'string' ? false : Boolean(input.isProjectModuleEnabled);

        if(parentTenantId) {
            const parent = await this.tenantRepository.findById(parentTenantId);
            if(!parent) {
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
