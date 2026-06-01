import {Tenant} from "../entities/Tenant";

export interface ITenantRepository {
    create(tenant: Partial<Tenant>): Promise<Tenant>;
    update(id: string, tenant: Partial<Tenant>): Promise<Tenant>;
    findById(id: string): Promise<Tenant | null>;
    findAll(): Promise<Tenant[]>;
}
