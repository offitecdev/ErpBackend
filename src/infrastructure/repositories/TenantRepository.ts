import prisma from "../database/prisma.client";
import { ITenantRepository } from "../../domain/repositories/ITenantRepository";
import { Tenant } from "../../domain/entities/Tenant";
import { nanoid } from 'nanoid';
export class TenantRepository implements ITenantRepository{

    private mapToEntity(data: any): Tenant {
        return new Tenant(
            data.id,
            data.tenantName,
            data.isActive,
            data.createdAt,
            data.parentTenantId,
            data.checkInQrSecret ?? null,
            data.checkOutQrSecret ?? null,
            data.workScheduleJson ?? null,
            data.isProjectModuleEnabled ?? false
        );
    }

    async create(tenantData: Partial<Tenant>): Promise<Tenant> {
        const data = await prisma.tenant.create({
            data: {
                id: (tenantData as any).id || nanoid(8),
                tenantName: typeof tenantData.tenantName === 'object' 
                    ? (tenantData.tenantName as any).tenantName 
                    : tenantData.tenantName as string,
                parentTenantId: tenantData.parentTenantId || null,
                isActive: tenantData.isActive ?? true,
                isProjectModuleEnabled: tenantData.isProjectModuleEnabled ?? false,
            }
        });
        return this.mapToEntity(data);
    }
    
    async update(id: string, tenantData: Partial<Tenant>): Promise<Tenant> {  
        const data = await prisma.tenant.update({
            where: { id },
            data: tenantData as any
        });
        return this.mapToEntity(data);
    }
     async findById(id: string): Promise<Tenant | null> {
        const data = await prisma.tenant.findUnique({ where: { id } });
        return data ? this.mapToEntity(data) : null;
    }

      async findAll(): Promise<Tenant[]> {
        const data = await prisma.tenant.findMany();
        return data.map(item => this.mapToEntity(item));
    }

}
