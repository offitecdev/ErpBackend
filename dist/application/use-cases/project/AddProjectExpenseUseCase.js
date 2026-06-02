"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddProjectExpenseUseCase = void 0;
const nanoid_1 = require("nanoid");
class AddProjectExpenseUseCase {
    projectRepository;
    constructor(projectRepository) {
        this.projectRepository = projectRepository;
    }
    async execute(projectId, expenseType, amount, description) {
        const validTypes = ["Nakliye", "Ekipman Kiralama", "Dış hizmetler", "Taşeron", "Diğer"];
        if (!validTypes.includes(expenseType)) {
            throw new Error("Geçersiz harici gider türü.");
        }
        const expense = await this.projectRepository.addExpense({
            id: (0, nanoid_1.nanoid)(10),
            projectId,
            expenseType,
            amount,
            description
        });
        return expense;
    }
}
exports.AddProjectExpenseUseCase = AddProjectExpenseUseCase;
//# sourceMappingURL=AddProjectExpenseUseCase.js.map