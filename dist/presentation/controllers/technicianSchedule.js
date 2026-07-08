"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateTechnicians = validateTechnicians;
exports.listTechnicianOptions = listTechnicianOptions;
exports.findTechnicianScheduleConflict = findTechnicianScheduleConflict;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const serviceTenantScope_1 = require("./serviceTenantScope");
/**
 * Shared technician scheduling rules for the project (montaj) and tender (teklif) modules.
 *
 * Both modules MUST go through these helpers so that the validation and conflict
 * rules are literally identical: a technician booked anywhere — a project
 * appointment, a maintenance task, or an un-converted proposal slot — conflicts
 * everywhere else with the same outcome.
 */
const formatDateTime = (date) => new Date(date).toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" });
const employeeLabel = (employee) => employee
    ? `${employee.firstName || ""} ${employee.lastName || ""}`.trim() || employee.email || "Teknisyen"
    : "Teknisyen";
/**
 * Validate that every id refers to an active technician inside the caller's
 * service tenant scope. Returns the technician records in the requested order
 * (first = responsible technician). Throws if any id is invalid.
 */
async function validateTechnicians(technicianIds, tenantId) {
    const ids = [...new Set(technicianIds.filter(Boolean))];
    if (!ids.length)
        return [];
    const tenantIds = await (0, serviceTenantScope_1.getServiceTenantScope)(tenantId);
    const employees = await prisma_client_1.default.employee.findMany({
        where: {
            id: { in: ids },
            tenantId: { in: tenantIds },
            isActive: true,
            OR: [
                { roleName: "Teknisyen" },
                { employeeRoles: { some: { role: { roleName: "Teknisyen" } } } },
            ],
        },
        select: {
            id: true,
            tenantId: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            roleName: true,
            title: true,
        },
    });
    const found = new Set(employees.map((employee) => employee.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length)
        throw new Error("Seçilen teknisyenlerden biri bulunamadı.");
    const byId = new Map(employees.map((employee) => [employee.id, employee]));
    return ids.map((id) => byId.get(id)).filter(Boolean);
}
/**
 * List the active technicians available to the caller's service tenant scope,
 * shaped identically for the project and tender option pickers.
 */
async function listTechnicianOptions(tenantId) {
    const tenantIds = await (0, serviceTenantScope_1.getServiceTenantScope)(tenantId);
    const technicians = await prisma_client_1.default.employee.findMany({
        where: {
            tenantId: { in: tenantIds },
            isActive: true,
            OR: [
                { roleName: "Teknisyen" },
                { employeeRoles: { some: { role: { roleName: "Teknisyen" } } } },
            ],
        },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
        select: {
            id: true,
            tenantId: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            title: true,
            roleName: true,
            employeeRoles: { select: { role: { select: { roleName: true } } } },
        },
    });
    return technicians.map((employee) => ({
        id: employee.id,
        tenantId: employee.tenantId,
        firstName: employee.firstName,
        lastName: employee.lastName,
        email: employee.email,
        phone: employee.phone,
        title: employee.title,
        roleName: employee.employeeRoles.find((employeeRole) => employeeRole.role.roleName === "Teknisyen")?.role.roleName || employee.roleName,
    }));
}
/**
 * Find the first scheduling conflict for any of the given technicians within the
 * [startTime, endTime) window. Scans, in order:
 *   1. project appointments (BOOKED only — once an install is COMPLETED the
 *      technician has finished and is free to take another task, even within the
 *      originally booked window if they wrapped up early),
 *   2. maintenance tasks (not CANCELLED),
 *   3. un-converted proposal schedule slots (tenders that have no project yet).
 *
 * `exclude.appointmentId` skips a project appointment being edited; `exclude.slotId`
 * skips an offer slot being edited. Returns null when there is no conflict.
 */
async function findTechnicianScheduleConflict(technicianIds, startTime, endTime, tenantId, exclude = {}) {
    const ids = [...new Set(technicianIds.filter(Boolean))];
    if (!ids.length)
        return null;
    const tenantIds = await (0, serviceTenantScope_1.getServiceTenantScope)(tenantId);
    const projectConflict = await prisma_client_1.default.appointment.findFirst({
        where: {
            tenantId: tenantIds.length ? { in: tenantIds } : undefined,
            // Only an active (still BOOKED) install reserves the technician; a
            // COMPLETED one means they finished, so it no longer blocks assignment.
            status: "BOOKED",
            ...(exclude.appointmentId ? { id: { not: exclude.appointmentId } } : {}),
            startTime: { lt: endTime },
            endTime: { gt: startTime },
            OR: [
                { assignedTechId: { in: ids } },
                { technicianAssignments: { some: { technicianId: { in: ids } } } },
            ],
        },
        include: {
            assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true } },
            technicianAssignments: { include: { technician: { select: { id: true, firstName: true, lastName: true, email: true } } } },
            project: { select: { projectName: true } },
        },
    });
    if (projectConflict) {
        const technicians = [
            projectConflict.assignedTechnician,
            ...((projectConflict.technicianAssignments || []).map((assignment) => assignment.technician)),
        ].filter(Boolean);
        const conflicted = technicians.find((employee) => ids.includes(employee.id)) || technicians[0];
        return {
            type: "project",
            message: `${employeeLabel(conflicted)} ${formatDateTime(projectConflict.startTime)} - ${formatDateTime(projectConflict.endTime)} arasında montajda: ${projectConflict.project?.projectName || "Proje montajı"}.`,
        };
    }
    const maintenanceConflict = await prisma_client_1.default.maintenanceTask.findFirst({
        where: {
            status: { not: "CANCELLED" },
            scheduledStartTime: { lt: endTime },
            scheduledEndTime: { gt: startTime },
            OR: [
                { assignedTechId: { in: ids } },
                { alternativeTechId: { in: ids } },
                { assignments: { some: { technicianId: { in: ids } } } },
            ],
        },
        include: {
            technician: { select: { id: true, firstName: true, lastName: true, email: true } },
            alternativeTechnician: { select: { id: true, firstName: true, lastName: true, email: true } },
            assignments: { include: { technician: { select: { id: true, firstName: true, lastName: true, email: true } } } },
            contract: { include: { customer: { select: { companyName: true } } } },
        },
    });
    if (maintenanceConflict) {
        const technicians = [
            maintenanceConflict.technician,
            maintenanceConflict.alternativeTechnician,
            ...((maintenanceConflict.assignments || []).map((assignment) => assignment.technician)),
        ].filter(Boolean);
        const conflicted = technicians.find((employee) => ids.includes(employee.id)) || technicians[0];
        return {
            type: "maintenance",
            message: `${employeeLabel(conflicted)} ${formatDateTime(maintenanceConflict.scheduledStartTime)} - ${formatDateTime(maintenanceConflict.scheduledEndTime)} arasında bakımda: ${maintenanceConflict.contract?.customer?.companyName || maintenanceConflict.contract?.title || "Bakım görevi"}.`,
        };
    }
    // Un-converted proposals reserve technicians too. Once a tender becomes a
    // project its slots are mirrored as appointments (handled above), so we skip
    // any slot whose tender already has a related project to avoid double counting.
    const offerConflict = await prisma_client_1.default.offerScheduleSlot.findFirst({
        where: {
            tenantId: tenantIds.length ? { in: tenantIds } : undefined,
            ...(exclude.slotId ? { id: { not: exclude.slotId } } : {}),
            startTime: { lt: endTime },
            endTime: { gt: startTime },
            tender: { project: { is: null } },
            OR: [
                { assignedTechId: { in: ids } },
                { technicianAssignments: { some: { technicianId: { in: ids } } } },
            ],
        },
        include: {
            assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true } },
            technicianAssignments: { include: { technician: { select: { id: true, firstName: true, lastName: true, email: true } } } },
            tender: { select: { tenderNumber: true } },
        },
    });
    if (offerConflict) {
        const technicians = [
            offerConflict.assignedTechnician,
            ...((offerConflict.technicianAssignments || []).map((assignment) => assignment.technician)),
        ].filter(Boolean);
        const conflicted = technicians.find((employee) => ids.includes(employee.id)) || technicians[0];
        return {
            type: "offer",
            message: `${employeeLabel(conflicted)} ${formatDateTime(offerConflict.startTime)} - ${formatDateTime(offerConflict.endTime)} arasında teklifte planlı: ${offerConflict.tender?.tenderNumber || "Teklif"}.`,
        };
    }
    return null;
}
//# sourceMappingURL=technicianSchedule.js.map