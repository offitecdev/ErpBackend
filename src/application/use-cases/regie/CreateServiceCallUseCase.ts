import { IRegieRepository } from "../../../domain/repositories/IRegieRepository";
import { ServiceCall } from "../../../domain/entities/Regie";
import { nanoid } from "nanoid";

export class CreateServiceCallUseCase {
    constructor(private regieRepository: IRegieRepository) {}

    async execute(input: {
        tenantId: string;
        customerId: string;
        reportedIssue: string;
        assignedTechId?: string | null;
        alternativeTechId?: string | null;
        siteName?: string | null;
        priority?: string | null;
    }): Promise<ServiceCall> {
        if (!input.customerId) throw new Error("Musteri zorunludur.");
        if (!input.reportedIssue?.trim()) throw new Error("Ariza aciklamasi zorunludur.");

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
            id: nanoid(10),
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
