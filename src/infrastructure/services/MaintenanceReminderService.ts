import { nanoid } from "nanoid";
import prisma from "../database/prisma.client";

let started = false;

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

export const startMaintenanceReminderService = () => {
    if (started || process.env.OFFITEC_DISABLE_REMINDERS === "true") return;
    started = true;
    void runReminderPass().catch((error) => console.error("[maintenance-reminders]", error));
    void runProjectInstallationReminderPass().catch((error) => console.error("[project-installation-reminders]", error));
    setInterval(() => {
        void runReminderPass().catch((error) => console.error("[maintenance-reminders]", error));
        void runProjectInstallationReminderPass().catch((error) => console.error("[project-installation-reminders]", error));
    }, 60 * 60 * 1000);
};
