import { IProjectRepository } from "../../../domain/repositories/IProjectRepository";
import { nanoid } from "nanoid";

export class AddProjectExpenseUseCase {
    constructor(private projectRepository: IProjectRepository) {}

    /**
     * Harici giderin TÜRÜ diye bir şey YOKTUR (kullanıcı isteği): eskiden sabit
     * bir listeye ("Nakliye", "Taşeron"…) karşı doğrulanıyordu ve saha raporundan
     * gelen serbest metin "Geçersiz harici gider türü." diye reddediliyordu.
     * Artık ne yazılırsa o kaydedilir; tek koşul boş olmamasıdır.
     *
     * Tutar da ZORUNLU DEĞİLDİR: bedeli sonra girilecek bir kalem 0 ile kaydedilir.
     */
    async execute(projectId: string, expenseType: string, amount: number, description: string, salesOrderId?: string | null, appointmentId?: string | null) {
        const label = String(expenseType || "").trim();
        if (!label) {
            throw new Error("Harici gider açıklaması zorunludur.");
        }
        const value = Number(amount);

        const expense = await this.projectRepository.addExpense({
            id: nanoid(10),
            projectId,
            salesOrderId: salesOrderId || null,
            appointmentId: appointmentId || null,
            expenseType: label,
            amount: Number.isFinite(value) && value > 0 ? value : 0,
            description,
        });

        return expense;
    }
}
