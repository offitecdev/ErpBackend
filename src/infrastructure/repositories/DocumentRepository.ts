import prisma from "../database/prisma.client";
import { IDocumentRepository } from "../../domain/repositories/IDocumentRepository";
import { Document } from "../../domain/entities/Document";
import { nanoid } from "nanoid";

export class DocumentRepository implements IDocumentRepository {

    private mapToEntity(data: any): Document {
        return new Document(
            data.id, data.tenantId, data.relatedEntityId, data.entityType,
            data.fileName, data.fileUrl, data.fileType, data.uploadedByEmployeeId, data.category
        );
    }

    async create(documentData: Partial<Document>): Promise<Document> {
        const data = await prisma.document.create({
            data: {
                id: documentData.id || nanoid(8),
                tenantId: documentData.tenantId!,
                relatedEntityId: documentData.relatedEntityId!,
                entityType: documentData.entityType!,
                fileName: documentData.fileName!,
                fileUrl: documentData.fileUrl!,
                fileType: documentData.fileType!,
                category: documentData.category || null,
                uploadedByEmployeeId: documentData.uploadedByEmployeeId! 
            }
        });
        return this.mapToEntity(data);
    }

    async findByEntity(entityType: string, entityId: string): Promise<Document[]> {
        const data = await prisma.document.findMany({
            where: {
                entityType,
                relatedEntityId: entityId
            }
        });
        return data.map(doc => this.mapToEntity(doc));
    }

    async delete(id: string, employeeId: string): Promise<void> {
        await prisma.document.delete({
            where: { id }
        });
    }
}