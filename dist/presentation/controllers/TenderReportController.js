"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenderReportController = void 0;
class TenderReportController {
    reportUseCase;
    exportUseCase;
    constructor(reportUseCase, exportUseCase) {
        this.reportUseCase = reportUseCase;
        this.exportUseCase = exportUseCase;
    }
    async getSummary(req, res) {
        try {
            const tenderId = req.params.id;
            if (!tenderId)
                return res.status(400).json({ error: "İhale ID zorunludur." });
            const tenantId = req.user.tenantId;
            const report = await this.reportUseCase.execute(tenderId, tenantId);
            res.status(200).json(report);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async exportData(req, res) {
        try {
            const tenderId = req.params.id;
            if (!tenderId)
                return res.status(400).json({ error: "İhale ID zorunludur." });
            const format = req.query.format || 'PDF';
            const tenantId = req.user.tenantId;
            const exportData = await this.exportUseCase.execute(tenderId, format, tenantId);
            res.status(200).json({
                message: "Dışa aktarım verisi başarıyla hazırlandı.",
                data: exportData
            });
        }
        catch (error) {
            // Draft teklif engellemesi (Blocker) buraya düşer (HTTP 403 Forbidden)
            res.status(403).json({ error: error.message });
        }
    }
}
exports.TenderReportController = TenderReportController;
//# sourceMappingURL=TenderReportController.js.map