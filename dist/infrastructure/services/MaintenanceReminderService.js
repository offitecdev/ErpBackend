"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMaintenanceReminderService = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const AddProjectReportUseCase_1 = require("../../application/use-cases/project/AddProjectReportUseCase");
const ProjectReportRepository_1 = require("../repositories/ProjectReportRepository");
const ProjectRepository_1 = require("../repositories/ProjectRepository");
const MaterialRepository_1 = require("../repositories/MaterialRepository");
let started = false;
const startOfDay = (date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
};
const endOfDay = (date) => {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
};
const projectReportRepository = new ProjectReportRepository_1.ProjectReportRepository();
const addProjectReportUseCase = new AddProjectReportUseCase_1.AddProjectReportUseCase(projectReportRepository, new ProjectRepository_1.ProjectRepository(), new MaterialRepository_1.MaterialRepository());
const taskTechnicianIds = (task) => [
    task.assignedTechId,
    task.alternativeTechId,
    ...((task.assignments || []).map((assignment) => assignment.technicianId)),
].filter(Boolean);
const runReminderPass = async () => {
    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tasks = await prisma_client_1.default.maintenanceTask.findMany({
        where: {
            status: { not: "CANCELLED" },
            reminderSentAt: null,
            scheduledStartTime: { gte: now, lte: in24Hours },
            contract: { deletedAt: null },
        },
        include: {
            assignments: true,
            contract: { include: { customer: { select: { companyName: true } } } },
        },
        take: 100,
    });
    const notifications = [];
    const taskIds = [];
    for (const task of tasks) {
        const technicianIds = [...new Set(taskTechnicianIds(task))];
        for (const technicianId of technicianIds) {
            notifications.push({
                id: (0, nanoid_1.nanoid)(12),
                tenantId: task.contract.tenantId,
                recipientEmployeeId: technicianId,
                type: "MAINTENANCE_REMINDER",
                title: "Yarın bakım randevunuz var",
                message: `${task.contract.contractCode} ${task.contract.customer?.companyName || ""} bakım randevusu yaklaşıyor.`,
                linkUrl: "/maintenance/technician",
                metadata: { taskId: task.id },
            });
        }
        taskIds.push(task.id);
    }
    // One bulk insert + one bulk update instead of a query per technician/task.
    if (notifications.length) {
        await prisma_client_1.default.notification.createMany({ data: notifications });
    }
    if (taskIds.length) {
        await prisma_client_1.default.maintenanceTask.updateMany({
            where: { id: { in: taskIds } },
            data: { reminderSentAt: new Date() },
        });
    }
};
const runProjectInstallationReminderPass = async () => {
    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const appointments = await prisma_client_1.default.appointment.findMany({
        where: {
            projectId: { not: null },
            assignedTechId: { not: null },
            status: "BOOKED",
            installationReminderSentAt: null,
            startTime: { gte: now, lte: in24Hours },
        },
        include: {
            project: { include: { customer: { select: { companyName: true } } } },
            salesOrder: { select: { orderNumber: true } },
        },
        take: 100,
    });
    const notifications = appointments.map((appointment) => ({
        id: (0, nanoid_1.nanoid)(12),
        tenantId: appointment.tenantId,
        recipientEmployeeId: appointment.assignedTechId,
        type: "PROJECT_INSTALLATION_REMINDER",
        title: "Yarin montaj randevunuz var",
        message: `${appointment.project?.projectName || "Proje"} ${appointment.salesOrder?.orderNumber || ""} montaji yaklasiyor.`,
        linkUrl: "/projects/installation/calendar",
        metadata: { projectId: appointment.projectId, appointmentId: appointment.id, salesOrderId: appointment.salesOrderId },
    }));
    const appointmentIds = appointments.map((appointment) => appointment.id);
    // One bulk insert + one bulk update instead of a query per appointment.
    if (notifications.length) {
        await prisma_client_1.default.notification.createMany({ data: notifications });
    }
    if (appointmentIds.length) {
        await prisma_client_1.default.appointment.updateMany({
            where: { id: { in: appointmentIds } },
            data: { installationReminderSentAt: new Date() },
        });
    }
};
// Once an installation day has fully ended, the field work is closed automatically: a field report
// is written ending at the latest by midnight of that day and the appointment is marked COMPLETED.
const runAutoFinishInstallationPass = async () => {
    const now = new Date();
    const appointments = await prisma_client_1.default.appointment.findMany({
        where: {
            projectId: { not: null },
            status: "BOOKED",
            endTime: { lt: now },
        },
        include: {
            technicianAssignments: { select: { technicianId: true } },
            project: { include: { salesOrders: { orderBy: { createdAt: "asc" }, select: { id: true } } } },
        },
        take: 200,
    });
    for (const appointment of appointments) {
        try {
            const dayEnd = endOfDay(new Date(appointment.startTime));
            // Only auto-finish once the appointment's day is fully over.
            if (dayEnd.getTime() >= now.getTime())
                continue;
            const employeeId = appointment.assignedTechId || appointment.technicianAssignments?.[0]?.technicianId || null;
            if (!employeeId)
                continue;
            const workDate = startOfDay(new Date(appointment.startTime));
            const orders = appointment.project?.salesOrders || [];
            const isPrimaryOrder = (orders[0]?.id || null) === (appointment.salesOrderId || null);
            const existingReport = await projectReportRepository.findByProjectAndWorkDate(appointment.projectId, workDate, appointment.salesOrderId ?? undefined, isPrimaryOrder);
            const reportRow = existingReport
                ? existingReport
                : await addProjectReportUseCase.execute({
                    projectId: appointment.projectId,
                    salesOrderId: appointment.salesOrderId || null,
                    appointmentId: appointment.id,
                    employeeId,
                    workDate: workDate.toISOString(),
                    startedAt: new Date(appointment.startTime).toISOString(),
                    endedAt: dayEnd.toISOString(),
                    operationsDone: "Saha çalışması gün sonunda otomatik olarak tamamlandı.",
                });
            await prisma_client_1.default.appointment.update({
                where: { id: appointment.id },
                data: { status: "COMPLETED" },
            });
            // End-of-day auto-approval: if no administrator approved the worked hours by 23:59,
            // approve them automatically. updateMany guards against overriding a manual approval.
            if (reportRow?.id) {
                await prisma_client_1.default.projectReport.updateMany({
                    where: { id: reportRow.id, hoursApprovedAt: null },
                    data: { hoursApprovedAt: new Date(), autoApproved: true },
                });
            }
        }
        catch (error) {
            console.error("[project-installation-autofinish]", appointment.id, error);
        }
    }
};
const startMaintenanceReminderService = () => {
    if (started || process.env.OFFITEC_DISABLE_REMINDERS === "true")
        return;
    started = true;
    const runAll = () => {
        void runReminderPass().catch((error) => console.error("[maintenance-reminders]", error));
        void runProjectInstallationReminderPass().catch((error) => console.error("[project-installation-reminders]", error));
        void runAutoFinishInstallationPass().catch((error) => console.error("[project-installation-autofinish]", error));
    };
    runAll();
    setInterval(runAll, 60 * 60 * 1000);
};
exports.startMaintenanceReminderService = startMaintenanceReminderService;
//# sourceMappingURL=MaintenanceReminderService.js.map