"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateProjectFromTenderUseCase = void 0;
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const nanoid_1 = require("nanoid");
const crypto_1 = __importDefault(require("crypto"));
class CreateProjectFromTenderUseCase {
    projectRepository;
    tenderRepository;
    tenantRepository;
    constructor(projectRepository, tenderRepository, tenantRepository) {
        this.projectRepository = projectRepository;
        this.tenderRepository = tenderRepository;
        this.tenantRepository = tenantRepository;
    }
    async execute(tenderId, employeeId, managerId, activeTenantId, overtimeHourlyRate = 0) {
        // Tenant-scoped lookup: a project can only be created from a tender the
        // active tenant owns.
        if (!activeTenantId)
            throw new Error("Seçili şirkette bu teklif bulunamadı.");
        const tender = await this.tenderRepository.findById(tenderId, activeTenantId);
        if (!tender)
            throw new Error("Teklif bulunamadı.");
        if (tender.status !== "Approved" && tender.status !== "Exported") {
            throw new Error("[BLOCKED] Sadece onaylanmış teklifler sipariş/projeye dönüştürülebilir.");
        }
        const tenant = await this.tenantRepository.findById(tender.tenantId);
        if (!tenant || !tenant.isProjectModuleEnabled) {
            throw new Error("[BLOCKED] Bu şube/firma için Proje Yönetim Modülü aktif değildir. Lütfen sistem yöneticisiyle iletişime geçin.");
        }
        const existingProjects = await this.projectRepository.findAll({ tenantId: tender.tenantId });
        const hasProject = existingProjects.some(p => p.tenderId === tenderId);
        if (hasProject) {
            throw new Error("Bu teklif için zaten bir proje oluşturulmuş.");
        }
        const scheduleSlots = await prisma_client_1.default.offerScheduleSlot.findMany({
            where: { tenderId },
            orderBy: { startTime: "asc" },
            include: { technicianAssignments: true }
        });
        if (scheduleSlots.length === 0) {
            throw new Error("[BLOCKED] Sipariş oluşturmadan önce en az bir tarih/saat planı eklenmelidir.");
        }
        const positions = await prisma_client_1.default.position.findMany({
            where: { tenderId },
            include: { calculation: true }
        });
        const plannedBudget = positions.reduce((sum, position) => {
            const quantity = Number(position.quantity || 0);
            const unitPrice = position.unitPrice == null ? null : Number(position.unitPrice);
            const discount = Number(position.discount || 0);
            if (unitPrice != null && quantity > 0)
                return sum + quantity * unitPrice * (1 - discount / 100);
            return sum + Math.max(0, Number(position.calculation?.totalCalculatedPrice || 0));
        }, 0);
        const projectData = {
            id: (0, nanoid_1.nanoid)(10),
            tenantId: tender.tenantId,
            customerId: tender.customerId,
            tenderId: tender.id,
            managerId: managerId || employeeId,
            projectName: `${tender.tenderNumber} - Kurulum Projesi`,
            status: "ACTIVE",
            plannedBudget,
            actualCost: 0,
            startDate: scheduleSlots[0]?.startTime || new Date(),
            bookingToken: crypto_1.default.randomBytes(32).toString("hex"),
            overtimeHourlyRate: Math.max(0, Number(overtimeHourlyRate || 0)),
            overtimeTolerancePercent: 15
        };
        const project = await this.projectRepository.createProject(projectData);
        await prisma_client_1.default.customerActivity.create({
            data: {
                id: (0, nanoid_1.nanoid)(),
                customerId: tender.customerId,
                employeeId,
                activityType: "TENDER_ORDERED",
                description: `${tender.tenderNumber} teklifi siparişe verildi.`,
                referenceId: tender.id,
                activityDate: new Date()
            }
        });
        // Mirror each proposal slot into a locked project appointment, carrying the
        // technician assignment (responsible + additional) forward so the project
        // calendar reflects exactly what was planned on the proposal.
        // Pre-generate appointment ids so the whole batch can be inserted with two
        // bulk writes (appointments + assignments) instead of two queries per slot.
        const slotAppointments = scheduleSlots.map((slot) => ({ appointmentId: (0, nanoid_1.nanoid)(10), slot }));
        if (slotAppointments.length) {
            await prisma_client_1.default.appointment.createMany({
                data: slotAppointments.map(({ appointmentId, slot }) => ({
                    id: appointmentId,
                    tenantId: tender.tenantId,
                    projectId: project.id,
                    customerId: tender.customerId,
                    assignedTechId: slot.assignedTechId || null,
                    startTime: slot.startTime,
                    endTime: slot.endTime,
                    status: "BOOKED",
                    notes: slot.notes,
                    isLocked: true,
                })),
            });
            const assignmentRows = slotAppointments.flatMap(({ appointmentId, slot }) => {
                const technicianIds = [...new Set((slot.technicianAssignments || []).map((assignment) => assignment.technicianId).filter(Boolean))];
                return technicianIds.map((technicianId) => ({
                    id: (0, nanoid_1.nanoid)(10),
                    appointmentId,
                    technicianId,
                }));
            });
            if (assignmentRows.length) {
                await prisma_client_1.default.projectAppointmentAssignment.createMany({
                    data: assignmentRows,
                    skipDuplicates: true,
                });
            }
        }
        // Keep the denormalized link in sync so the proposal screen knows it is
        // converted and proxies technician edits to the project from now on.
        await prisma_client_1.default.tender.update({
            where: { id: tender.id },
            data: { projectId: project.id },
        });
        return project;
    }
}
exports.CreateProjectFromTenderUseCase = CreateProjectFromTenderUseCase;
//# sourceMappingURL=CreateProjectFromTenderUseCase.js.map