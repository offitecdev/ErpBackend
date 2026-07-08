"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExportTenderDataUseCase = void 0;
class ExportTenderDataUseCase {
    tenderRepository;
    positionRepository;
    constructor(tenderRepository, positionRepository) {
        this.tenderRepository = tenderRepository;
        this.positionRepository = positionRepository;
    }
    async execute(tenderId, format, tenantId) {
        const tender = await this.tenderRepository.findById(tenderId, tenantId);
        if (!tender)
            throw new Error("İhale bulunamadı.");
        // Dışa Aktarım Blokaj Kuralı (Blocker): Onaysız teklif dışarı çıkartılamaz!
        if (tender.status === 'Draft') {
            throw new Error("[BLOCKED] Onaylanmamış (Draft) teklifler müşteriye / dışarı aktarılamaz. Lütfen yöneticiden onay alın.");
        }
        const positions = await this.positionRepository.findByTenderId(tenderId, { includeImages: true });
        const buildTree = (parentId) => {
            return positions
                .filter(p => p.parentPositionId === parentId)
                .map(p => ({
                ...p,
                subPositions: buildTree(p.id)
            }));
        };
        const hierarchyData = buildTree(null);
        // Statüyü Güncelle
        if (tender.status === 'Approved') {
            await this.tenderRepository.updateStatus(tenderId, 'Exported', tenantId);
        }
        return {
            metadata: {
                format,
                exportedAt: new Date(),
                tenderNumber: tender.tenderNumber
            },
            tree: hierarchyData
        };
    }
}
exports.ExportTenderDataUseCase = ExportTenderDataUseCase;
//# sourceMappingURL=ExportTenderDataUseCase.js.map