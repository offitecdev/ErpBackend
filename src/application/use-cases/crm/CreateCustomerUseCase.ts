import {ICustomerRepository} from "../../../domain/repositories/ICustomerRepository";
import {Customer} from "../../../domain/entities/Customer";

export class CreateCustomerUseCase {
    constructor(private customerRepository : ICustomerRepository) {}


    async execute(data: Partial<Customer>) : Promise<Customer> {
        if(!data.companyName) throw new Error("Company name is required");
        if(!data.tenantId) throw new Error("Tenant ID is required");

        return await this.customerRepository.createCustomer(data);
    }

}
