import prisma from "../database/prisma.client";
import { ICustomerLocationRepository } from "../../domain/repositories/ICustomerLocationRepository";
import { CustomerLocation } from "../../domain/entities/CustomerLocation";
import { nanoid } from "nanoid";

export class CustomerLocationRepository implements ICustomerLocationRepository {
    private mapToEntity(data: any): CustomerLocation {
        return new CustomerLocation(
            data.id,
            data.customerId,
            data.name,
            data.isPrimary,
            data.address,
            data.city,
            data.postalCode,
            data.country,
            data.phone,
            data.email,
            data.contactPerson,
            data.notes,
            data.createdAt,
            data.updatedAt
        );
    }

    async create(data: Partial<CustomerLocation>): Promise<CustomerLocation> {
        const created = await prisma.customerLocation.create({
            data: {
                id: data.id || nanoid(8),
                customerId: data.customerId!,
                name: data.name!,
                address: data.address ?? null,
                city: data.city ?? null,
                postalCode: data.postalCode ?? null,
                country: data.country ?? null,
                phone: data.phone ?? null,
                email: data.email ?? null,
                contactPerson: data.contactPerson ?? null,
                isPrimary: data.isPrimary ?? false,
                notes: data.notes ?? null,
            }
        });
        return this.mapToEntity(created);
    }

    async findById(id: string): Promise<CustomerLocation | null> {
        const data = await prisma.customerLocation.findUnique({ where: { id } });
        return data ? this.mapToEntity(data) : null;
    }

    async findByCustomerId(customerId: string): Promise<CustomerLocation[]> {
        const data = await prisma.customerLocation.findMany({
            where: { customerId },
            orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }]
        });
        return data.map(item => this.mapToEntity(item));
    }

    async update(id: string, data: Partial<CustomerLocation>): Promise<CustomerLocation> {
        const { id: _id, customerId: _cid, createdAt: _ca, updatedAt: _ua, ...safeData } = data;
        const updated = await prisma.customerLocation.update({
            where: { id },
            data: safeData as any
        });
        return this.mapToEntity(updated);
    }

    async delete(id: string): Promise<void> {
        await prisma.customerLocation.delete({ where: { id } });
    }
}
