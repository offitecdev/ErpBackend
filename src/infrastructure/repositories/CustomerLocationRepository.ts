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
            data.kind ?? "INSTALLATION",
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
        const customerId = data.customerId!;
        const makePrimary = data.isPrimary ?? false;
        const created = await prisma.$transaction(async (tx) => {
            // Enforce a single primary address per customer: setting this one
            // primary clears the flag on all of the customer's other locations.
            if (makePrimary) {
                await tx.customerLocation.updateMany({
                    where: { customerId, isPrimary: true },
                    data: { isPrimary: false },
                });
            }
            return tx.customerLocation.create({
                data: {
                    id: data.id || nanoid(8),
                    customerId,
                    name: data.name!,
                    kind: data.kind ?? "INSTALLATION",
                    address: data.address ?? null,
                    city: data.city ?? null,
                    postalCode: data.postalCode ?? null,
                    country: data.country ?? null,
                    phone: data.phone ?? null,
                    email: data.email ?? null,
                    contactPerson: data.contactPerson ?? null,
                    isPrimary: makePrimary,
                    notes: data.notes ?? null,
                }
            });
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
        const updated = await prisma.$transaction(async (tx) => {
            // Enforce a single primary address per customer: promoting this
            // location to primary demotes the customer's other primary locations.
            if (safeData.isPrimary === true) {
                const existing = await tx.customerLocation.findUnique({
                    where: { id },
                    select: { customerId: true },
                });
                if (existing) {
                    await tx.customerLocation.updateMany({
                        where: { customerId: existing.customerId, isPrimary: true, id: { not: id } },
                        data: { isPrimary: false },
                    });
                }
            }
            return tx.customerLocation.update({
                where: { id },
                data: safeData as any,
            });
        });
        return this.mapToEntity(updated);
    }

    async delete(id: string): Promise<void> {
        await prisma.customerLocation.delete({ where: { id } });
    }
}
