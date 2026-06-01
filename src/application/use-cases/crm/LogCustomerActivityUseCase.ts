import {ICustomerActivityRepository} from "../../../domain/repositories/ICustomerActivityRepository";
import {CustomerActivity} from "../../../domain/entities/CustomerActivitiy";

export class LogCustomerActivityUseCase {

    constructor(private customerActivityRepository : ICustomerActivityRepository){}
    async execute(data: Partial<CustomerActivity>) : Promise<CustomerActivity>{
        if(!data.customerId || !data.employeeId || !data.activityType){
            throw new Error("Missing required fields: customerId, employeeId, activityType");
        }
        return await this.customerActivityRepository.create(data);  
    }
}