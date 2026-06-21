import { nanoid } from "nanoid";
import prisma from "../database/prisma.client";
<<<<<<< HEAD
import { AddProjectReportUseCase } from "../../application/use-cases/project/AddProjectReportUseCase";
import { ProjectReportRepository } from "../repositories/ProjectReportRepository";
import { ProjectRepository } from "../repositories/ProjectRepository";
import { MaterialRepository } from "../repositories/MaterialRepository";

let started = false;

const startOfDay = (date: Date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
};

const endOfDay = (date: Date) => {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
};

const projectReportRepository = new ProjectReportRepository();
const addProjectReportUseCase = new AddProjectReportUseCase(
    projectReportRepository as any,
    new ProjectRepository() as any,
    new MaterialRepository() as any
);

=======

let started = false;

>>>>>>> 16c911768b897682a1f0e461e228a105fcd606ae
const taskTechnicianIds = (task: any) => [
    task.assignedTechId,
    task.alternativeTechId,
    ...((task.assignments || []).map((assignment: any) => assignment.technicianId)),
].filter(Boolean);

const runReminderPass = async () => {
    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const tasks = await (prisma as any).maintenanceTask.findMany({
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

    for (const task of tasks) {
        const technicianIds = [...new Set(taskTechnicianIds(task))];
        for (const technicianId of technicianIds) {
            await (prisma as any).notification.create({
                data: {
                    id: nanoid(12),
                    tenantId: task.contract.tenantId,
                    recipientEmployeeId: technicianId,
                    type: "MAINTENANCE_REMINDER",
                    title: "Yarın bakım randevunuz var",
                    message: `${task.contract.contractCode} ${task.contract.customer?.companyName || ""} bakım randevusu yaklaşıyor.`,
                    linkUrl: "/maintenance/technician",
                    metadata: { taskId: task.id },
                },
            });
        }
        await (prisma as any).maintenanceTask.update({
            where: { id: task.id },
            data: { reminderSentAt: new Date() },
        });
    }
};

const runProjectInstallationReminderPass = async () => {
    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const appointments = await (prisma as any).appointment.findMany({
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

    for (const appointment of appointments) {
        await (prisma as any).notification.create({
            data: {
                id: nanoid(12),
                tenantId: appointment.tenantId,
                recipientEmployeeId: appointment.assignedTechId,
                type: "PROJECT_INSTALLATION_REMINDER",
                title: "Yarin montaj randevunuz var",
                message: `${appointment.project?.projectName || "Proje"} ${appointment.salesOrder?.orderNumber || ""} montaji yaklasiyor.`,
                linkUrl: "/projects/installation/calendar",
                metadata: { projectId: appointment.projectId, appointmentId: appointment.id, salesOrderId: appointment.salesOrderId },
            },
        });
        await (prisma as any).appointment.update({
            where: { id: appointment.id },
            data: { installationReminderSentAt: new Date() },
        });
    }
};

<<<<<<< HEAD
// Once an installation day has fully ended, the field work is closed automatically: a field report
// is written ending at the latest by midnight of that day and the appointment is marked COMPLETED.
const runAutoFinishInstallationPass = async () => {
    const now = new Date();

    const appointments = await (prisma as any).appointment.findMany({
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
            if (dayEnd.getTime() >= now.getTime()) continue;

            const employeeId = appointment.assignedTechId || appointment.technicianAssignments?.[0]?.technicianId || null;
            if (!employeeId) continue;

            const workDate = startOfDay(new Date(appointment.startTime));
            const orders = appointment.project?.salesOrders || [];
            const isPrimaryOrder = (orders[0]?.id || null) === (appointment.salesOrderId || null);
            const existingReport = await projectReportRepository.findByProjectAndWorkDate(
                appointment.projectId,
                workDate,
                appointment.salesOrderId ?? undefined,
                isPrimaryOrder
            );

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

            await (prisma as any).appointment.update({
                where: { id: appointment.id },
                data: { status: "COMPLETED" },
            });

            // End-of-day auto-approval: if no administrator approved the worked hours by 23:59,
            // approve them automatically. updateMany guards against overriding a manual approval.
            if ((reportRow as any)?.id) {
                await (prisma as any).projectReport.updateMany({
                    where: { id: (reportRow as any).id, hoursApprovedAt: null },
                    data: { hoursApprovedAt: new Date(), autoApproved: true },
                });
            }
        } catch (error) {
            console.error("[project-installation-autofinish]", appointment.id, error);
        }
    }
};

export const startMaintenanceReminderService = () => {
    if (started || process.env.OFFITEC_DISABLE_REMINDERS === "true") return;
    started = true;
    const runAll = () => {
        void runReminderPass().catch((error) => console.error("[maintenance-reminders]", error));
        void runProjectInstallationReminderPass().catch((error) => console.error("[project-installation-reminders]", error));
        void runAutoFinishInstallationPass().catch((error) => console.error("[project-installation-autofinish]", error));
    };
    runAll();
    setInterval(runAll, 60 * 60 * 1000);
=======
export const startMaintenanceReminderService = () => {
    if (started || process.env.OFFITEC_DISABLE_REMINDERS === "true") return;
    started = true;
    void runReminderPass().catch((error) => console.error("[maintenance-reminders]", error));
    void runProjectInstallationReminderPass().catch((error) => console.error("[project-installation-reminders]", error));
    setInterval(() => {
        void runReminderPass().catch((error) => console.error("[maintenance-reminders]", error));
        void runProjectInstallationReminderPass().catch((error) => console.error("[project-installation-reminders]", error));
    }, 60 * 60 * 1000);
>>>>>>> 16c911768b897682a1f0e461e228a105fcd606ae
};
