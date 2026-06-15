import { IProjectRepository } from "../../../domain/repositories/IProjectRepository";
import { nanoid } from "nanoid";

export class AddProjectExpenseUseCase {
    constructor(private projectRepository: IProjectRepository) {}

    async execute(projectId: string, expenseType: string, amount: number, description: string, salesOrderId?: string | null, appointmentId?: string | null) {
        const validTypes = ["Nakliye", "Ekipman Kiralama", "Dış hizmetler", "Taşeron", "Diğer"];
        if (!validTypes.includes(expenseType)) {
            throw new Error("Geçersiz harici gider türü.");
        }

        const expense = await this.projectRepository.addExpense({
            id: nanoid(10),
            projectId,
            salesOrderId: salesOrderId || null,
            appointmentId: appointmentId || null,
            expenseType,
            amount,
            description,
        });

        return expense;
    }
}
