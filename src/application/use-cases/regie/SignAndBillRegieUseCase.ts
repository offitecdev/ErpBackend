import { IRegieRepository } from "../../../domain/repositories/IRegieRepository";
import { IWorkOrderRepository } from "../../../domain/repositories/IWorkOrderRepository";
import { nanoid } from "nanoid";

export class SignAndBillRegieUseCase {
    constructor(
        private regieRepository: IRegieRepository,
        private workOrderRepository: IWorkOrderRepository
    ) {}

    async signReport(reportId: string, signatureBase64: string) {
        const report = await this.regieRepository.getReportById(reportId);
        if (!report) throw new Error("Rapor bulunamadi.");
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
        await this.regieRepository.updateCallStatus((signedReport as any).callId, "COMPLETED");

        return {
            report: await this.regieRepository.getReportById(reportId) || signedReport,
            promptForBilling: !signedReport.isWarranty,
            message: signedReport.isWarranty
                ? "Garanti kapsaminda: fatura olusturulmayacak."
                : "Bu raporda faturalandirilabilecek kalemler var. Is emri / fatura olusturulsun mu?",
        };
    }

    async createWorkOrderForReport(reportId: string, tenantId: string, customerId?: string) {
        const report = await this.regieRepository.getReportById(reportId);
        if (!report) throw new Error("Rapor bulunamadi.");
        if (!report.isSigned) throw new Error("[BLOCKED] Imza olmadan regie raporu faturalandirilamaz.");
        if (report.isWarranty) throw new Error("[BLOCKED] Garanti kapsamindaki isler faturalandirilamaz.");
        if (report.linkedOrderId) {
            const existingOrder = await this.workOrderRepository.getOrderById(report.linkedOrderId);
            if (existingOrder) return existingOrder;
        }

        const effectiveCustomerId = customerId || (report as any).call?.customerId;
        if (!effectiveCustomerId) throw new Error("Musteri bilgisi bulunamadi.");

        const HOURLY_RATE = 80;
        const GAS_PRICE_PER_UNIT = 25;

        const materials = await this.regieRepository.getMaterialsByReportId(reportId);

        const materialTotal = materials.reduce((sum, m) => sum + (m.quantity * m.unitCost), 0);
        const laborTotal = (report.workingMinutes / 60) * HOURLY_RATE;
        const gasTotal = report.gasAmount * GAS_PRICE_PER_UNIT;
        const grandTotal = materialTotal + laborTotal + gasTotal;

        const order = await this.workOrderRepository.createOrder({
            id: nanoid(10),
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
