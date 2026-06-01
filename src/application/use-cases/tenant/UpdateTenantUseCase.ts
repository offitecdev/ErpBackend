import { ITenantRepository } from "../../../domain/repositories/ITenantRepository";
import { Tenant } from "../../../domain/entities/Tenant";

export class UpdateTenantUseCase {
    constructor(private tenantRepository: ITenantRepository) {}

    async execute(id:string , data: Partial<Tenant>): Promise<Tenant> {
        const existingTenant = await this.tenantRepository.findById(id);
        if(!existingTenant) {
            throw new Error('Şirket bulunamadı.');
        }

        if(data.parentTenantId && data.parentTenantId ===id) {
            throw new Error('Şirket kendi üst şirketi olamaz.');
        }

        return await this.tenantRepository.update(id, data);
    }
}
