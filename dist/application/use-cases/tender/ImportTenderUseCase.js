"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImportTenderUseCase = void 0;
const nanoid_1 = require("nanoid");
class ImportTenderUseCase {
    tenderRepository;
    positionRepository;
    parserService;
    customerActivityRepo;
    constructor(tenderRepository, positionRepository, parserService, customerActivityRepo) {
        this.tenderRepository = tenderRepository;
        this.positionRepository = positionRepository;
        this.parserService = parserService;
        this.customerActivityRepo = customerActivityRepo;
    }
    async execute(tenantId, customerId, employeeId, xmlContent, format) {
        const parsedData = await this.parserService.parseAndValidate(xmlContent, format);
        const tenderId = (0, nanoid_1.nanoid)(10);
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
        const idMap = new Map();
        const positionsToInsert = parsedData.positions.map((p, index) => {
            const realId = (0, nanoid_1.nanoid)(10);
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
exports.ImportTenderUseCase = ImportTenderUseCase;
//# sourceMappingURL=ImportTenderUseCase.js.map