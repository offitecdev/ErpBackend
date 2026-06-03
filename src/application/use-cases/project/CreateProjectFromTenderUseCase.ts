import { IProjectRepository } from "../../../domain/repositories/IProjectRepository";
import { ITenderRepository } from "../../../domain/repositories/ITenderRepository";
import { ITenantRepository } from "../../../domain/repositories/ITenantRepository";
import { Project } from "../../../domain/entities/Project";
import prisma from "../../../infrastructure/database/prisma.client";
import { nanoid } from "nanoid";
import crypto from "crypto";

export class CreateProjectFromTenderUseCase {
    constructor(
        private projectRepository: IProjectRepository,
        private tenderRepository: ITenderRepository,
        private tenantRepository: ITenantRepository
    ) {}

    async execute(
        tenderId: string,
        employeeId: string,
        managerId?: string,
        activeTenantId?: string,
        overtimeHourlyRate = 0
    ): Promise<Project> {
        const tender: any = await this.tenderRepository.findById(tenderId);
        if (!tender) throw new Error("Teklif bulunamadı.");
        if (activeTenantId && tender.tenantId !== activeTenantId) {
            throw new Error("Seçili şirkette bu teklif bulunamadı.");
        }

        if (tender.status !== "Approved" && tender.status !== "Exported") {
            throw new Error("[BLOCKED] Sadece onaylanmış teklifler sipariş/projeye dönüştürülebilir.");
        }
        const tenant = await this.tenantRepository.findById(tender.tenantId);
        if (!tenant || !(tenant as any).isProjectModuleEnabled) {
            throw new Error("[BLOCKED] Bu şube/firma için Proje Yönetim Modülü aktif değildir. Lütfen sistem yöneticisiyle iletişime geçin.");
        }

        const existingProjects = await this.projectRepository.findAll({ tenantId: tender.tenantId });
        const hasProject = existingProjects.some(p => p.tenderId === tenderId);
        if (hasProject) {
            throw new Error("Bu teklif için zaten bir proje oluşturulmuş.");
        }

        const scheduleSlots = await (prisma as any).offerScheduleSlot.findMany({
            where: { tenderId },
            orderBy: { startTime: "asc" }
        });
        if (scheduleSlots.length === 0) {
            throw new Error("[BLOCKED] Sipariş oluşturmadan önce en az bir tarih/saat planı eklenmelidir.");
        }

        const positions = await (prisma as any).position.findMany({
            where: { tenderId },
            include: { calculation: true }
        });
        const plannedBudget = positions.reduce((sum: number, position: any) => {
            const quantity = Number(position.quantity || 0);
            const unitPrice = position.unitPrice == null ? null : Number(position.unitPrice);
            const discount = Number(position.discount || 0);
            if (unitPrice != null && quantity > 0) return sum + quantity * unitPrice * (1 - discount / 100);
            return sum + Math.max(0, Number(position.calculation?.totalCalculatedPrice || 0));
        }, 0);

        const projectData: Partial<Project> = {
            id: nanoid(10),
            tenantId: tender.tenantId,
            customerId: tender.customerId,
            tenderId: tender.id,
            managerId: managerId || employeeId,
            projectName: `${tender.tenderNumber} - Kurulum Projesi`,
            status: "ACTIVE",
            plannedBudget,
            actualCost: 0,
            startDate: scheduleSlots[0]?.startTime || new Date(),
            bookingToken: crypto.randomBytes(32).toString("hex"),
            overtimeHourlyRate: Math.max(0, Number(overtimeHourlyRate || 0)),
            overtimeTolerancePercent: 15
        } as any;

        const project = await this.projectRepository.createProject(projectData);

        await (prisma as any).customerActivity.create({
            data: {
                id: nanoid(),
                customerId: tender.customerId,
                employeeId,
                activityType: "TENDER_ORDERED",
                description: `${tender.tenderNumber} teklifi siparişe verildi.`,
                referenceId: tender.id,
                activityDate: new Date()
            }
        });

        await (prisma as any).appointment.createMany({
            data: scheduleSlots.map((slot: any) => ({
                id: nanoid(10),
                tenantId: tender.tenantId,
                projectId: project.id,
                customerId: tender.customerId,
                startTime: slot.startTime,
                endTime: slot.endTime,
                status: "BOOKED",
                notes: slot.notes,
                isLocked: true
            }))
        });

        return project;
    }
}
