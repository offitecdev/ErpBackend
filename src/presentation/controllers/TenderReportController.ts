import { Request, Response } from 'express';
import { GetTenderSummaryReportUseCase } from '../../application/use-cases/tender/GetTenderSummaryReportUseCase';
import { ExportTenderDataUseCase } from '../../application/use-cases/tender/ExportTenderDataUseCase';

export class TenderReportController {
    constructor(
        private reportUseCase: GetTenderSummaryReportUseCase,
        private exportUseCase: ExportTenderDataUseCase
    ) {}

    async getSummary(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            if (!tenderId) return res.status(400).json({ error: "İhale ID zorunludur." });
            const report = await this.reportUseCase.execute(tenderId);
            res.status(200).json(report);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async exportData(req: Request, res: Response) {
        try {
            const tenderId = req.params.id as string;
            if (!tenderId) return res.status(400).json({ error: "İhale ID zorunludur." });
            const format = req.query.format as 'PDF' | 'CRBX' | 'SIA451' || 'PDF';
            
            const exportData = await this.exportUseCase.execute(tenderId, format);
            
            res.status(200).json({
                message: "Dışa aktarım verisi başarıyla hazırlandı.",
                data: exportData
            });
        } catch (error: any) {
            // Draft teklif engellemesi (Blocker) buraya düşer (HTTP 403 Forbidden)
            res.status(403).json({ error: error.message });
        }
    }
}