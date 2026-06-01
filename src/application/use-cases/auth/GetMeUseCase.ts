import { IEmployeeRepository } from "../../../domain/repositories/IEmployeeRepository";

export class GetMeUseCase {
    constructor(private employeeRepo: IEmployeeRepository) {}

    async execute(employeeId: string) {
        const employee = await this.employeeRepo.findById(employeeId);
        if (!employee) throw new Error("Kullanıcı bulunamadı.");
        
        const { passwordHash, ...safeEmployee } = employee;
        return safeEmployee;
    }
}