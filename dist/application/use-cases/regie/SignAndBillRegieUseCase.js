"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SignAndBillRegieUseCase = void 0;
const nanoid_1 = require("nanoid");
class SignAndBillRegieUseCase {
    regieRepository;
    workOrderRepository;
    constructor(regieRepository, workOrderRepository) {
        this.regieRepository = regieRepository;
        this.workOrderRepository = workOrderRepository;
    }
    async signReport(reportId, signatureBase64) {
        const report = await this.regieRepository.getReportById(reportId);
        if (!report)
            throw new Error("Rapor bulunamadi.");
        if (report.isSigned) {
            return {
                report,
                promptForBilling: !report.isWarranty && !report.linkedOrderId,
                message: report.isWarranty
                    ? "Garanti kapsaminda: fatura olusturulmayacak."
                    : "Rapor zaten imzali. Is emri / fatura olusturulabilir.",
            };
        }
        const signedReport = await this.regieRepository.signReport(reportId, signatureBase64);
        await this.regieRepository.updateCallStatus(signedReport.callId, "COMPLETED");
        return {
            report: await this.regieRepository.getReportById(reportId) || signedReport,
            promptForBilling: !signedReport.isWarranty,
            message: signedReport.isWarranty
                ? "Garanti kapsaminda: fatura olusturulmayacak."
                : "Bu raporda faturalandirilabilecek kalemler var. Is emri / fatura olusturulsun mu?",
        };
    }
    async createWorkOrderForReport(reportId, tenantId, customerId) {
        const report = await this.regieRepository.getReportById(reportId);
        if (!report)
            throw new Error("Rapor bulunamadi.");
        if (!report.isSigned)
            throw new Error("[BLOCKED] Imza olmadan regie raporu faturalandirilamaz.");
        if (report.isWarranty)
            throw new Error("[BLOCKED] Garanti kapsamindaki isler faturalandirilamaz.");
        if (report.linkedOrderId) {
            const existingOrder = await this.workOrderRepository.getOrderById(report.linkedOrderId);
            if (existingOrder)
                return existingOrder;
        }
        const effectiveCustomerId = customerId || report.call?.customerId;
        if (!effectiveCustomerId)
            throw new Error("Musteri bilgisi bulunamadi.");
        const HOURLY_RATE = 80;
        const GAS_PRICE_PER_UNIT = 25;
        const materials = await this.regieRepository.getMaterialsByReportId(reportId);
        const materialTotal = materials.reduce((sum, m) => sum + (m.quantity * m.unitCost), 0);
        const laborTotal = (report.workingMinutes / 60) * HOURLY_RATE;
        const gasTotal = report.gasAmount * GAS_PRICE_PER_UNIT;
        const grandTotal = materialTotal + laborTotal + gasTotal;
        const order = await this.workOrderRepository.createOrder({
            id: (0, nanoid_1.nanoid)(10),
            tenantId,
            customerId: effectiveCustomerId,
            orderNumber: `ORD-REG-${Date.now().toString(36).toUpperCase()}`,
            orderType: "REGIE",
            totalAmount: grandTotal,
            isBilled: false,
        });
        await this.regieRepository.linkOrderToReport(reportId, order.id);
        return order;
    }
}
exports.SignAndBillRegieUseCase = SignAndBillRegieUseCase;
//# sourceMappingURL=SignAndBillRegieUseCase.js.map