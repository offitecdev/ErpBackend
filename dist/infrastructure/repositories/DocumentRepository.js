"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DocumentRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const Document_1 = require("../../domain/entities/Document");
const nanoid_1 = require("nanoid");
class DocumentRepository {
    mapToEntity(data) {
        return new Document_1.Document(data.id, data.tenantId, data.relatedEntityId, data.entityType, data.fileName, data.fileUrl, data.fileType, data.uploadedByEmployeeId, data.category);
    }
    async create(documentData) {
        const data = await prisma_client_1.default.document.create({
            data: {
                id: documentData.id || (0, nanoid_1.nanoid)(8),
                tenantId: documentData.tenantId,
                relatedEntityId: documentData.relatedEntityId,
                entityType: documentData.entityType,
                fileName: documentData.fileName,
                fileUrl: documentData.fileUrl,
                fileType: documentData.fileType,
                category: documentData.category || null,
                uploadedByEmployeeId: documentData.uploadedByEmployeeId
            }
        });
        return this.mapToEntity(data);
    }
    async findByEntity(entityType, entityId) {
        const data = await prisma_client_1.default.document.findMany({
            where: {
                entityType,
                relatedEntityId: entityId
            }
        });
        return data.map(doc => this.mapToEntity(doc));
    }
    async delete(id, employeeId) {
        await prisma_client_1.default.document.delete({
            where: { id }
        });
    }
}
exports.DocumentRepository = DocumentRepository;
//# sourceMappingURL=DocumentRepository.js.map