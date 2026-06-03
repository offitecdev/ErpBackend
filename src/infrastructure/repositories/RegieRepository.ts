
import prisma from "../database/prisma.client";
import { IRegieRepository, TenantScope } from "../../domain/repositories/IRegieRepository";
import { ServiceCall, ServiceReport, ServiceMaterial } from "../../domain/entities/Regie";
import { TaskStatus } from "../../domain/entities/Maintenance";

const tenantWhere = (tenantId: TenantScope) => Array.isArray(tenantId) ? { in: tenantId } : tenantId;

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

export class RegieRepository implements IRegieRepository {
    async createCall(call: Partial<ServiceCall>): Promise<ServiceCall> {
        const data = await prisma.serviceCall.create({
            data: call as any,
            include: callInclude,
        });
        return data as unknown as ServiceCall;
    }

    async getCallById(id: string): Promise<ServiceCall | null> {
        const data = await prisma.serviceCall.findUnique({
            where: { id },
            include: callInclude,
        });
        return data ? data as unknown as ServiceCall : null;
    }

    async listCalls(tenantId: TenantScope, status?: TaskStatus): Promise<ServiceCall[]> {
        const where: any = { tenantId: tenantWhere(tenantId) };
        if (status) where.status = status;
        const data = await prisma.serviceCall.findMany({
            where,
            orderBy: { callDate: 'desc' },
            include: callInclude,
        });
        return data as unknown as ServiceCall[];
    }

    async updateCall(id: string, patch: Partial<ServiceCall>): Promise<ServiceCall> {
        const data = await prisma.serviceCall.update({
            where: { id },
            data: patch as any,
            include: callInclude,
        });
        return data as unknown as ServiceCall;
    }

    async updateCallStatus(id: string, status: TaskStatus): Promise<ServiceCall> {
        const data = await prisma.serviceCall.update({
            where: { id },
            data: { status },
            include: callInclude,
        });
        return data as unknown as ServiceCall;
    }

    async createReport(report: Partial<ServiceReport>): Promise<ServiceReport> {
        const data = await prisma.serviceReport.create({
            data: report as any,
            include: reportInclude,
        });
        return data as unknown as ServiceReport;
    }

    async getReportByCallId(callId: string): Promise<ServiceReport | null> {
        const data = await prisma.serviceReport.findUnique({ 
            where: { callId },
            include: {
                ...reportInclude,
                call: { include: callInclude },
            }
        });
        return data ? data as unknown as ServiceReport : null;
    }

    async getReportById(reportId: string): Promise<ServiceReport | null> {
        const data = await prisma.serviceReport.findUnique({
            where: { id: reportId },
            include: {
                ...reportInclude,
                call: { include: callInclude },
            },
        });
        return data ? data as unknown as ServiceReport : null;
    }

    async listReports(tenantId: TenantScope): Promise<ServiceReport[]> {
        const data = await prisma.serviceReport.findMany({
            where: { call: { tenantId: tenantWhere(tenantId) } },
            orderBy: { createdAt: 'desc' },
            include: {
                ...reportInclude,
                call: { include: callInclude },
            },
        });
        return data as unknown as ServiceReport[];
    }

    async signReport(reportId: string, signatureBase64: string): Promise<ServiceReport> {
        const data = await prisma.serviceReport.update({
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
        return data as unknown as ServiceReport;
    }

    async linkOrderToReport(reportId: string, orderId: string): Promise<void> {
        await prisma.serviceReport.update({
            where: { id: reportId },
            data: { linkedOrderId: orderId }
        });
    }

    async addMaterialToReport(material: Partial<ServiceMaterial>): Promise<ServiceMaterial> {
        const data = await prisma.serviceMaterial.create({
            data: material as any,
            include: materialInclude,
        });
        return data as unknown as ServiceMaterial;
    }

    async getMaterialsByReportId(reportId: string): Promise<ServiceMaterial[]> {
        const data = await prisma.serviceMaterial.findMany({
            where: { reportId },
            include: materialInclude,
        });
        return data as unknown as ServiceMaterial[];
    }
}
