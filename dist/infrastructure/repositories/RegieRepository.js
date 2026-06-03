"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RegieRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const tenantWhere = (tenantId) => Array.isArray(tenantId) ? { in: tenantId } : tenantId;
const technicianSelect = {
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    phone: true,
};
const customerSelect = {
    id: true,
    companyName: true,
    address: true,
    mainEmail: true,
    mainPhone: true,
};
const materialInclude = {
    article: {
        select: {
            id: true,
            articleCode: true,
            name: true,
            unit: true,
            baseCost: true,
            imageUrl: true,
        }
    }
};
const reportInclude = {
    technician: { select: technicianSelect },
    usedMaterials: { include: materialInclude },
    order: true,
};
const callInclude = {
    customer: { select: customerSelect },
    technician: { select: technicianSelect },
    alternativeTechnician: { select: technicianSelect },
    report: { include: reportInclude },
};
class RegieRepository {
    async createCall(call) {
        const data = await prisma_client_1.default.serviceCall.create({
            data: call,
            include: callInclude,
        });
        return data;
    }
    async getCallById(id) {
        const data = await prisma_client_1.default.serviceCall.findUnique({
            where: { id },
            include: callInclude,
        });
        return data ? data : null;
    }
    async listCalls(tenantId, status) {
        const where = { tenantId: tenantWhere(tenantId) };
        if (status)
            where.status = status;
        const data = await prisma_client_1.default.serviceCall.findMany({
            where,
            orderBy: { callDate: 'desc' },
            include: callInclude,
        });
        return data;
    }
    async updateCall(id, patch) {
        const data = await prisma_client_1.default.serviceCall.update({
            where: { id },
            data: patch,
            include: callInclude,
        });
        return data;
    }
    async updateCallStatus(id, status) {
        const data = await prisma_client_1.default.serviceCall.update({
            where: { id },
            data: { status },
            include: callInclude,
        });
        return data;
    }
    async createReport(report) {
        const data = await prisma_client_1.default.serviceReport.create({
            data: report,
            include: reportInclude,
        });
        return data;
    }
    async getReportByCallId(callId) {
        const data = await prisma_client_1.default.serviceReport.findUnique({
            where: { callId },
            include: {
                ...reportInclude,
                call: { include: callInclude },
            }
        });
        return data ? data : null;
    }
    async getReportById(reportId) {
        const data = await prisma_client_1.default.serviceReport.findUnique({
            where: { id: reportId },
            include: {
                ...reportInclude,
                call: { include: callInclude },
            },
        });
        return data ? data : null;
    }
    async listReports(tenantId) {
        const data = await prisma_client_1.default.serviceReport.findMany({
            where: { call: { tenantId: tenantWhere(tenantId) } },
            orderBy: { createdAt: 'desc' },
            include: {
                ...reportInclude,
                call: { include: callInclude },
            },
        });
        return data;
    }
    async signReport(reportId, signatureBase64) {
        const data = await prisma_client_1.default.serviceReport.update({
            where: { id: reportId },
            data: {
                isSigned: true,
                customerSignature: signatureBase64,
                signedAt: new Date(),
                lockedAt: new Date(),
            },
            include: {
                ...reportInclude,
                call: { include: callInclude },
            },
        });
        return data;
    }
    async linkOrderToReport(reportId, orderId) {
        await prisma_client_1.default.serviceReport.update({
            where: { id: reportId },
            data: { linkedOrderId: orderId }
        });
    }
    async addMaterialToReport(material) {
        const data = await prisma_client_1.default.serviceMaterial.create({
            data: material,
            include: materialInclude,
        });
        return data;
    }
    async getMaterialsByReportId(reportId) {
        const data = await prisma_client_1.default.serviceMaterial.findMany({
            where: { reportId },
            include: materialInclude,
        });
        return data;
    }
}
exports.RegieRepository = RegieRepository;
//# sourceMappingURL=RegieRepository.js.map