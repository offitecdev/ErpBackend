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
        assignedTechId?: string | null;
        alternativeTechId?: string | null;
        reminderDaysBefore?: number;
        notificationChannels?: unknown;
    }): Promise<MaintenanceContract> {
        const start = new Date(data.startDate);
        const end = new Date(data.endDate);

        if (!data.customerId) throw new Error("Musteri zorunludur.");
        if (!data.title) throw new Error("Sozlesme basligi zorunludur.");
        if (!periodToMonths[data.period]) throw new Error("Gecersiz bakim periyodu.");
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error("Tarih bilgisi gecersiz.");
        if (start >= end) throw new Error("Bitis tarihi baslangic tarihinden sonra olmalidir.");

        const assignedTechId = data.assignedTechId || null;
        const alternativeTechId = data.alternativeTechId && data.alternativeTechId !== assignedTechId
            ? data.alternativeTechId
            : null;

        const contract = await this.maintenanceRepository.createContract({
            id: nanoid(10),
            tenantId: data.tenantId,
            customerId: data.customerId,
            title: data.title,
            period: data.period,
            startDate: start,
            endDate: end,
            equipmentInfo: data.equipmentInfo,
            serviceScope: data.serviceScope,
            siteName: data.siteName,
            reminderDaysBefore: Number(data.reminderDaysBefore ?? 7),
            notificationChannels: data.notificationChannels ?? { inApp: true, email: true },
            isActive: true,
        });

        const assignmentHistoryJson = assignedTechId ? [{
            assignedTechId,
            alternativeTechId,
            at: new Date().toISOString(),
            action: "CONTRACT_CREATED",
        }] : [];

        for (const plannedDate of buildPlannedDates(start, end, data.period)) {
            await this.maintenanceRepository.createTask({
                id: nanoid(10),
                contractId: contract.id,
                plannedDate,
                status: "PENDING",
                assignedTechId,
                alternativeTechId,
                siteName: data.siteName || null,
                assignmentHistoryJson,
            });
        }

        return await this.maintenanceRepository.getContractById(contract.id) || contract;
    }
}
