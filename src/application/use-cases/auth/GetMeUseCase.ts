import { IEmployeeRepository } from "../../../domain/repositories/IEmployeeRepository";
import { PublicError } from "../../errors/AuthErrors";

export class GetMeUseCase {
    constructor(private employeeRepo: IEmployeeRepository) {}

    async execute(employeeId: string) {
        const employee = await this.employeeRepo.findById(employeeId);
        if (!employee) throw new PublicError("Kullanıcı bulunamadı.");
        
        const { passwordHash, ...safeEmployee } = employee;
        return safeEmployee;
    }
}