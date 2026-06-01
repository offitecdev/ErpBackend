import { CustomerContact } from "../entities/CustomerContact";

export interface ICustomerContactRepository {
    create(contactData: Partial<CustomerContact>): Promise<CustomerContact>;
    findById(id: string): Promise<CustomerContact | null>;
    findByCustomerId(customerId: string): Promise<CustomerContact[]>;
    update(id: string, contactData: Partial<CustomerContact>): Promise<CustomerContact>;
    delete(id: string): Promise<void>;
}
