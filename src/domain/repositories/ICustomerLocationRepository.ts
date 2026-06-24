import { CustomerLocation } from "../entities/CustomerLocation";

export interface ICustomerLocationRepository {
    create(data: Partial<CustomerLocation>): Promise<CustomerLocation>;
    findById(id: string): Promise<CustomerLocation | null>;
    findByCustomerId(customerId: string): Promise<CustomerLocation[]>;
    update(id: string, data: Partial<CustomerLocation>): Promise<CustomerLocation>;
    delete(id: string): Promise<void>;
}
