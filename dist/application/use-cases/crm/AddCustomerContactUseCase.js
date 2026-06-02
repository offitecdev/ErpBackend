"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddCustomerContactUseCase = void 0;
class AddCustomerContactUseCase {
    contactRepository;
    constructor(contactRepository) {
        this.contactRepository = contactRepository;
    }
    async execute(data) {
        if (!data.customerId || !data.firstName || !data.lastName) {
            throw new Error("Müşteri ID, Ad ve Soyad zorunludur.");
        }
        return await this.contactRepository.create(data);
    }
}
exports.AddCustomerContactUseCase = AddCustomerContactUseCase;
//# sourceMappingURL=AddCustomerContactUseCase.js.map