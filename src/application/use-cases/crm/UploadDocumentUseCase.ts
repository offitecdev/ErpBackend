import { IDocumentRepository} from "../../../domain/repositories/IDocumentRepository";
import { Document } from "../../../domain/entities/Document";

export class UploadDocumentUseCase {
    constructor(private documentRepository : IDocumentRepository){}

    async execute(data: Partial<Document>) : Promise<Document>{
        if (!data.tenantId || !data.relatedEntityId || !data.entityType || !data.fileUrl || !data.uploadedByEmployeeId) {
            throw new Error("Eksik doküman parametreleri. Yükleyen kişi ve dosya yolu zorunludur.");
        }

        const validCategories = ["Contact", "Plan" , "Screenshot" , "Other"];
        if(!data.category || !validCategories.includes(data.category)){
            data.category = "Other";
        }
        return await this.documentRepository.create(data);


    }
}