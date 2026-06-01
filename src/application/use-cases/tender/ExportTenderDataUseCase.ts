import { ITenderRepository } from "../../../domain/repositories/ITenderRepository";
import { IPositionRepository } from "../../../domain/repositories/IPositionRepository";

export class ExportTenderDataUseCase {
    constructor(
        private tenderRepository: ITenderRepository,
        private positionRepository: IPositionRepository
    ) {}

    async execute(tenderId: string, format: 'PDF' | 'CRBX' | 'SIA451') {
        const tender = await this.tenderRepository.findById(tenderId);
        if (!tender) throw new Error("İhale bulunamadı.");

        // Dışa Aktarım Blokaj Kuralı (Blocker): Onaysız teklif dışarı çıkartılamaz!
        if (tender.status === 'Draft') {
            throw new Error("[BLOCKED] Onaylanmamış (Draft) teklifler müşteriye / dışarı aktarılamaz. Lütfen yöneticiden onay alın.");
        }

        const positions = await this.positionRepository.findByTenderId(tenderId, { includeImages: true });
        
        const buildTree = (parentId: string | null): any[] => {
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
            await this.tenderRepository.updateStatus(tenderId, 'Exported');
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
