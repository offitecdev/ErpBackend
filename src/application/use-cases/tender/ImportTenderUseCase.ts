
import { ITenderRepository } from "../../../domain/repositories/ITenderRepository";
import { IPositionRepository } from "../../../domain/repositories/IPositionRepository";
import { ITenderParserService } from "../../interfaces/ITenderParserService";
import { nanoid } from "nanoid";
import { ICustomerActivityRepository } from "../../../domain/repositories/ICustomerActivityRepository";
export class ImportTenderUseCase {
    constructor(
        private tenderRepository: ITenderRepository,
        private positionRepository: IPositionRepository,
        private parserService: ITenderParserService,
        private customerActivityRepo: ICustomerActivityRepository
    ) {}

    async execute(
        tenantId: string, 
        customerId: string, 
        employeeId: string, 
        xmlContent: string, 
        format: 'SIA451' | 'CRBX'
    ) {
        
        const parsedData = await this.parserService.parseAndValidate(xmlContent, format);

        const tenderId = nanoid(10);

        const tender = await this.tenderRepository.create({
            id: tenderId,
            tenantId,
            customerId,
            tenderNumber: parsedData.tenderNumber,
            version: 1,
            format: parsedData.format,
            status: 'Draft',
            createdByEmployeeId: employeeId
        });

        const idMap = new Map<string, string>(); 
        const positionsToInsert = parsedData.positions.map((p, index) => {
            const realId = nanoid(10);
            idMap.set(p.refId, realId);
            return {
                id: realId,
                tenantId,
                tenderId,
                parentPositionId: p.parentRefId ? idMap.get(p.parentRefId) : null,
                rowType: 'SECTION',
                displayOrder: (index + 1) * 1000,
                sourceArticleId: null,
                positionNumber: p.positionNumber,
                shortDescription: p.shortDescription,
                longDescription: p.longDescription,
                hierarchyLevel: p.hierarchyLevel,
                quantity: p.quantity,
                unit: p.unit,
                npkCode: p.npkCode
            };
        });

        await this.positionRepository.createMany(positionsToInsert);
         await this.customerActivityRepo.create({
            customerId: customerId,
            employeeId: employeeId,
            activityType: "TENDER_IMPORTED",
            description: `${parsedData.tenderNumber} numaralı ${format} ihale dosyası sisteme içe aktarıldı. (Versiyon: 1)`,
            referenceId: tenderId,
            activityDate: new Date()
        });

        return tender;
    }
      
}
