import { IEmployeeRepository , IEmployeeFilter } from "../../../domain/repositories/IEmployeeRepository";

export class GetEmployeeUseCase {
    constructor(private employeeRepository: IEmployeeRepository) {}
    
    async execute(filter: IEmployeeFilter){
        if(!filter.tenantId){
            throw new Error("Tenant ID is required");
        }
        return await this.employeeRepository.findAll(filter);
    }
    

}