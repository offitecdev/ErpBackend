"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateMaintenanceContractUseCase = void 0;
const nanoid_1 = require("nanoid");
const periodToMonths = {
    MONTHLY: 1,
    QUARTERLY: 3,
    BIANNUAL: 6,
    YEARLY: 12,
};
const addMonthsSafe = (date, months) => {
    const next = new Date(date);
    const originalDay = next.getDate();
    next.setMonth(next.getMonth() + months);
    if (next.getDate() < originalDay)
        next.setDate(0);
    return next;
};
const buildPlannedDates = (start, end, period) => {
    const dates = [];
    const step = periodToMonths[period];
    for (let cursor = new Date(start); cursor <= end; cursor = addMonthsSafe(cursor, step)) {
        dates.push(new Date(cursor));
    }
    return dates;
};
class CreateMaintenanceContractUseCase {
    maintenanceRepository;
    constructor(maintenanceRepository) {
        this.maintenanceRepository = maintenanceRepository;
    }
    async execute(data) {
        const start = new Date(data.startDate);
        const end = new Date(data.endDate);
        if (!data.customerId)
            throw new Error("Musteri zorunludur.");
        if (!data.title)
            throw new Error("Sozlesme basligi zorunludur.");
        if (!periodToMonths[data.period])
            throw new Error("Gecersiz bakim periyodu.");
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
            throw new Error("Tarih bilgisi gecersiz.");
        if (start >= end)
            throw new Error("Bitis tarihi baslangic tarihinden sonra olmalidir.");
        const assignedTechId = data.assignedTechId || null;
        const alternativeTechId = data.alternativeTechId && data.alternativeTechId !== assignedTechId
            ? data.alternativeTechId
            : null;
        const contract = await this.maintenanceRepository.createContract({
            id: (0, nanoid_1.nanoid)(10),
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
                id: (0, nanoid_1.nanoid)(10),
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
exports.CreateMaintenanceContractUseCase = CreateMaintenanceContractUseCase;
//# sourceMappingURL=CreateMaintenanceContract.js.map