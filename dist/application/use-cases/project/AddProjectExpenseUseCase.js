"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddProjectExpenseUseCase = void 0;
const nanoid_1 = require("nanoid");
class AddProjectExpenseUseCase {
    projectRepository;
    constructor(projectRepository) {
        this.projectRepository = projectRepository;
    }
    /**
     * Harici giderin TÜRÜ diye bir şey YOKTUR (kullanıcı isteği): eskiden sabit
     * bir listeye ("Nakliye", "Taşeron"…) karşı doğrulanıyordu ve saha raporundan
     * gelen serbest metin "Geçersiz harici gider türü." diye reddediliyordu.
     * Artık ne yazılırsa o kaydedilir; tek koşul boş olmamasıdır.
     *
     * Tutar da ZORUNLU DEĞİLDİR: bedeli sonra girilecek bir kalem 0 ile kaydedilir.
     */
    async execute(projectId, expenseType, amount, description, salesOrderId, appointmentId) {
        const label = String(expenseType || "").trim();
        if (!label) {
            throw new Error("Harici gider açıklaması zorunludur.");
        }
        const value = Number(amount);
        const expense = await this.projectRepository.addExpense({
            id: (0, nanoid_1.nanoid)(10),
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
exports.AddProjectExpenseUseCase = AddProjectExpenseUseCase;
//# sourceMappingURL=AddProjectExpenseUseCase.js.map