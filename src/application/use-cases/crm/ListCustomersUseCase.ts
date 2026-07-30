import { ICustomerRepository, ICustomerFilter, PaginatedResult, CustomerListRow } from "../../../domain/repositories/ICustomerRepository";
import { Customer } from "../../../domain/entities/Customer";

export class ListCustomersUseCase {
    constructor(private customerRepository: ICustomerRepository) {}

    async execute(
        filter: ICustomerFilter
    ): Promise<Customer[] | PaginatedResult<Customer> | CustomerListRow[] | PaginatedResult<CustomerListRow>> {
        if (!filter.tenantId) {
            throw new Error("Tenant ID zorunludur.");
        }
        return await this.customerRepository.findAll(filter);
    }
}
