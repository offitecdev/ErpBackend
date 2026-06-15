import { IMaintenanceRepository } from "../../../domain/repositories/IMaintenanceRepository";
import { MaintenanceContract, MaintenancePeriod } from "../../../domain/entities/Maintenance";
import { nanoid } from "nanoid";

const periodToMonths: Record<MaintenancePeriod, number> = {
    MONTHLY: 1,
    QUARTERLY: 3,
    BIANNUAL: 6,
    YEARLY: 12,
};

const addMonthsSafe = (date: Date, months: number) => {
    const next = new Date(date);
    const originalDay = next.getDate();
    next.setMonth(next.getMonth() + months);
    if (next.getDate() < originalDay) next.setDate(0);
    return next;
};

const buildPlannedDates = (start: Date, end: Date, period: MaintenancePeriod) => {
    const dates: Date[] = [];
    const step = periodToMonths[period];

    for (let cursor = new Date(start); cursor <= end; cursor = addMonthsSafe(cursor, step)) {
        dates.push(new Date(cursor));
    }

    return dates;
};

export class CreateMaintenanceContractUseCase {
    constructor(private maintenanceRepository: IMaintenanceRepository) {}

    async execute(data: {
        tenantId: string;
        customerId: string;
        title: string;
        period: MaintenancePeriod;
        startDate: string;
        endDate: string;
        equipmentInfo?: string;
        serviceScope?: string;
        siteName?: string;
        technicianIds?: string[];
        assignedTechId?: string | null;
        alternativeTechId?: string | null;
        reminderDaysBefore?: number;
        notificationChannels?: unknown;
        overtimeHourlyRate?: number;
    }): Promise<MaintenanceContract> {
        const start = new Date(data.startDate);
        const end = new Date(data.endDate);

        if (!data.customerId) throw new Error("Musteri zorunludur.");
        if (!data.title) throw new Error("Sozlesme basligi zorunludur.");
        if (!periodToMonths[data.period]) throw new Error("Gecersiz bakim periyodu.");
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error("Tarih bilgisi gecersiz.");
        if (start >= end) throw new Error("Bitis tarihi baslangic tarihinden sonra olmalidir.");

        const technicianIds = [
            ...(Array.isArray(data.technicianIds) ? data.technicianIds : []),
            data.assignedTechId || "",
            data.alternativeTechId || "",
        ].filter(Boolean);
        const uniqueTechnicianIds = [...new Set(technicianIds)];
        const assignedTechId = uniqueTechnicianIds[0] || null;
        const alternativeTechId = uniqueTechnicianIds[1] && uniqueTechnicianIds[1] !== assignedTechId
            ? uniqueTechnicianIds[1]
            : null;

        let contract: MaintenanceContract | null = null;
        for (let attempt = 0; attempt < 3 && !contract; attempt += 1) {
            const contractCode = await this.maintenanceRepository.getNextContractCode(data.tenantId);
            try {
                contract = await this.maintenanceRepository.createContract({
                    id: nanoid(10),
                    tenantId: data.tenantId,
                    customerId: data.customerId,
                    contractCode,
                    title: data.title,
                    period: data.period,
                    startDate: start,
                    endDate: end,
                    equipmentInfo: data.equipmentInfo,
                    serviceScope: data.serviceScope,
                    siteName: data.siteName,
                    reminderDaysBefore: Number(data.reminderDaysBefore ?? 7),
                    notificationChannels: data.notificationChannels ?? { inApp: true, email: true },
                    overtimeHourlyRate: Math.max(0, Number(data.overtimeHourlyRate || 0)),
                    isActive: true,
                });
            } catch (error: any) {
                if (error?.code !== "P2002" || attempt === 2) throw error;
            }
        }
        if (!contract) throw new Error("Sozlesme kodu uretilemedi.");

        const assignmentHistoryJson = uniqueTechnicianIds.length ? [{
            assignedTechId,
            alternativeTechId,
            technicianIds: uniqueTechnicianIds,
            at: new Date().toISOString(),
            action: "CONTRACT_CREATED",
        }] : [];

        for (const plannedDate of buildPlannedDates(start, end, data.period)) {
            const task = await this.maintenanceRepository.createTask({
                id: nanoid(10),
                contractId: contract.id,
                plannedDate,
                status: "PENDING",
                assignedTechId,
                alternativeTechId,
                siteName: data.siteName || null,
                bookingToken: nanoid(32),
                assignmentHistoryJson,
            });
            if (uniqueTechnicianIds.length) {
                await this.maintenanceRepository.replaceTaskAssignments(task.id, uniqueTechnicianIds);
            }
        }

        return await this.maintenanceRepository.getContractById(contract.id) || contract;
    }
}
