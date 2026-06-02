"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UploadDocumentUseCase = void 0;
class UploadDocumentUseCase {
    documentRepository;
    constructor(documentRepository) {
        this.documentRepository = documentRepository;
    }
    async execute(data) {
        if (!data.tenantId || !data.relatedEntityId || !data.entityType || !data.fileUrl || !data.uploadedByEmployeeId) {
            throw new Error("Eksik doküman parametreleri. Yükleyen kişi ve dosya yolu zorunludur.");
        }
        const validCategories = ["Contact", "Plan", "Screenshot", "Other"];
        if (!data.category || !validCategories.includes(data.category)) {
            data.category = "Other";
        }
        return await this.documentRepository.create(data);
    }
}
exports.UploadDocumentUseCase = UploadDocumentUseCase;
//# sourceMappingURL=UploadDocumentUseCase.js.map