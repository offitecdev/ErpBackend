"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddCustomerNoteUseCase = void 0;
class AddCustomerNoteUseCase {
    noteRepository;
    customerRepository;
    constructor(noteRepository, customerRepository) {
        this.noteRepository = noteRepository;
        this.customerRepository = customerRepository;
    }
    async execute(data) {
        const customer = await this.customerRepository.findById(data.customerId);
        if (!customer)
            throw new Error("Customer not found");
        const validTypes = ["internal", "technical"];
        if (!validTypes.includes(data.noteType)) {
            data.noteType = "internal";
        }
        return await this.noteRepository.create({
            customerId: data.customerId,
            createdByEmployeeId: data.createdByEmployeeId,
            noteText: data.noteText,
            noteType: data.noteType,
            isHighlight: data.isHighlight ?? false
        });
    }
}
exports.AddCustomerNoteUseCase = AddCustomerNoteUseCase;
//# sourceMappingURL=AddCustomerNoteUseCase.js.map