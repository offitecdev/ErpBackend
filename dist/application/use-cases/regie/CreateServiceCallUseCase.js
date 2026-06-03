"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateServiceCallUseCase = void 0;
const nanoid_1 = require("nanoid");
class CreateServiceCallUseCase {
    regieRepository;
    constructor(regieRepository) {
        this.regieRepository = regieRepository;
    }
    async execute(input) {
        if (!input.customerId)
            throw new Error("Musteri zorunludur.");
        if (!input.reportedIssue?.trim())
            throw new Error("Ariza aciklamasi zorunludur.");
        const assignedTechId = input.assignedTechId || null;
        const alternativeTechId = input.alternativeTechId && input.alternativeTechId !== assignedTechId
            ? input.alternativeTechId
            : null;
        const assignmentHistoryJson = assignedTechId ? [{
                assignedTechId,
                alternativeTechId,
                at: new Date().toISOString(),
                action: "CALL_CREATED",
            }] : [];
        return await this.regieRepository.createCall({
            id: (0, nanoid_1.nanoid)(10),
            tenantId: input.tenantId,
            customerId: input.customerId,
            reportedIssue: input.reportedIssue,
            status: "PENDING",
            callDate: new Date(),
            assignedTechId,
            alternativeTechId,
            siteName: input.siteName || null,
            priority: input.priority || "NORMAL",
            assignmentHistoryJson,
        });
    }
}
exports.CreateServiceCallUseCase = CreateServiceCallUseCase;
//# sourceMappingURL=CreateServiceCallUseCase.js.map