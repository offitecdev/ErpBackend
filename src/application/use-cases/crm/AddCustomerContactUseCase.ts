import { ICustomerContactRepository } from "../../../domain/repositories/ICustomerContactRepository";
import { CustomerContact } from "../../../domain/entities/CustomerContact";

export class AddCustomerContactUseCase {
    constructor(private contactRepository: ICustomerContactRepository) {}

    async execute(data: Partial<CustomerContact>): Promise<CustomerContact> {
        if (!data.customerId || !data.firstName || !data.lastName) {
            throw new Error("Müşteri ID, Ad ve Soyad zorunludur.");
        }
        return await this.contactRepository.create(data);
    }
}
