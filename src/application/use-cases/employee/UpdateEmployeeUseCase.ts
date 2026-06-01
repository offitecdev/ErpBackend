import { IEmployeeRepository } from "../../../domain/repositories/IEmployeeRepository";
import { Employee } from "../../../domain/entities/Employee";

export class UpdateEmployeeUseCase {
    constructor(private employeeRepository: IEmployeeRepository) {}

    async execute(id: string, data: Partial<Employee>): Promise<Employee> {
        const existing = await this.employeeRepository.findById(id);
        if (!existing) {
            throw new Error("Personel bulunamadı.");
        }

        if (data.terminationDate && !data.isActive) {
            data.isActive = false;
        }

        return await this.employeeRepository.update(id, data);
    }
}
