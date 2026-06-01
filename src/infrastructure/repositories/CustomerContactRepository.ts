import prisma from "../database/prisma.client";
import { ICustomerContactRepository } from "../../domain/repositories/ICustomerContactRepository";
import { CustomerContact } from "../../domain/entities/CustomerContact";
import { nanoid } from "nanoid";

export class CustomerContactRepository implements ICustomerContactRepository {
    private mapToEntity(data: any): CustomerContact {
        return new CustomerContact(
            data.id,
            data.customerId,
            data.firstName,
            data.lastName,
            data.isPrimaryContact,
            data.title,
            data.phone,
            data.email
        );
    }

    async create(contactData: Partial<CustomerContact>): Promise<CustomerContact> {
        const data = await prisma.customerContact.create({
            data: {
                id: contactData.id || nanoid(8),
                customerId: contactData.customerId!,
                firstName: contactData.firstName!,
                lastName: contactData.lastName!,
                title: contactData.title || null,
                phone: contactData.phone || null,
                email: contactData.email || null,
                isPrimaryContact: contactData.isPrimaryContact ?? false
            }
        });
        return this.mapToEntity(data);
    }

    async findById(id: string): Promise<CustomerContact | null> {
        const data = await prisma.customerContact.findUnique({
            where: { id }
        });
        return data ? this.mapToEntity(data) : null;
    }

    async findByCustomerId(customerId: string): Promise<CustomerContact[]> {
        const data = await prisma.customerContact.findMany({
            where: { customerId }
        });
        return data.map(item => this.mapToEntity(item));
    }

    async update(id: string, contactData: Partial<CustomerContact>): Promise<CustomerContact> {
        const { id: _id, customerId: _cid, ...safeData } = contactData;
        const data = await prisma.customerContact.update({
            where: { id },
            data: safeData as any
        });
        return this.mapToEntity(data);
    }

    async delete(id: string): Promise<void> {
        await prisma.customerContact.delete({
            where: { id }
        });
    }
}
