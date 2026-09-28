"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaProductionTaskDirectory = exports.PrismaProductionDeviceTaskRepository = exports.PrismaProductionTaskTemplateRepository = void 0;
const nanoid_1 = require("nanoid");
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const productionTasks_1 = require("../../domain/services/productionTasks");
const serviceTenantScope_1 = require("../../presentation/controllers/serviceTenantScope");
/**
 * ── GÖREVLENDİRME · DIE DATENBANKSEITE (26.09.2026) ─────────────────────────
 *
 * Vorlagen (`uretim_gorev_sablon*`) und die Pläne der Geräte
 * (`uretim_cihaz_gorev*`). Die entfernte Datenbank kostet je Anfrage einen
 * Rundgang — Lesewege schicken ihre Abfragen darum GLEICHZEITIG los, und
 * nur das Schreiben läuft in einem Vorgang (Transaktion).
 */
const newId = () => (0, nanoid_1.nanoid)(12);
const areaOf = (value) => ((0, productionTasks_1.isProductionTaskArea)(value) ? value : 'MECHANICAL');
/* Eine Stufe aus der Zeit vor den zwei Wegen (27.09.2026) liegt am passenden
   Platz des Weges — sonst am Anfang, damit keine Aufgabe unsichtbar wird. */
const stageOf = (area, value) => (0, productionTasks_1.stageOfArea)(area, value) ?? productionTasks_1.PRODUCTION_TASK_STAGES[area][0] ?? 'final';
const draftOf = (row) => ({
    id: row.id,
    area: areaOf(row.area),
    stage: stageOf(areaOf(row.area), row.stage),
    code: row.code,
    name: row.name,
    weight: (0, productionTasks_1.roundPercent)(Number(row.weight) || 0),
    assigneeIds: (0, productionTasks_1.assigneeIdsFrom)(row.assigneeIds),
    sortOrder: row.sortOrder,
});
const templateOf = (row, tasks) => ({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    areaShares: (0, productionTasks_1.areaSharesFrom)(row.areaShares),
    exampleKey: row.exampleKey,
    createdById: row.createdById,
    updatedById: row.updatedById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tasks: [...tasks].sort((left, right) => left.sortOrder - right.sortOrder),
});
/** Die Aufgaben einer Vorlage als Zeilen — die Reihenfolge der Eingabe bleibt. */
const templateTaskRows = (tenantId, templateId, tasks) => tasks.map((task, index) => ({
    id: newId(),
    tenantId,
    templateId,
    area: task.area,
    stage: task.stage,
    code: task.code,
    name: task.name,
    weight: task.weight,
    assigneeIds: task.assigneeIds,
    sortOrder: index,
}));
const templateTasksFromRows = (rows) => rows.map((row) => draftOf({ ...row, assigneeIds: row.assigneeIds }));
class PrismaProductionTaskTemplateRepository {
    async countEver(tenantId) {
        return prisma_client_1.default.productionTaskTemplate.count({ where: { tenantId } });
    }
    async list(tenantId) {
        const [templates, taskGroups, planGroups] = await Promise.all([
            prisma_client_1.default.productionTaskTemplate.findMany({
                where: { tenantId, deletedAt: null },
                select: { id: true, name: true, areaShares: true, exampleKey: true, updatedAt: true },
                orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
            }),
            prisma_client_1.default.productionTaskTemplateTask.groupBy({
                by: ['templateId', 'area'],
                where: { tenantId },
                _count: { _all: true },
                _sum: { weight: true },
            }),
            prisma_client_1.default.productionDeviceTaskPlan.groupBy({
                by: ['templateId'],
                where: { tenantId, templateId: { not: null } },
                _count: { _all: true },
            }),
        ]);
        const usage = new Map(planGroups.map((group) => [group.templateId ?? '', group._count._all]));
        return templates.map((template) => {
            const areas = {};
            for (const area of productionTasks_1.PRODUCTION_TASK_AREAS)
                areas[area] = { taskCount: 0, weightSum: 0 };
            let taskCount = 0;
            for (const group of taskGroups) {
                if (group.templateId !== template.id || !(0, productionTasks_1.isProductionTaskArea)(group.area))
                    continue;
                areas[group.area] = {
                    taskCount: group._count._all,
                    weightSum: (0, productionTasks_1.roundPercent)(Number(group._sum.weight) || 0),
                };
                taskCount += group._count._all;
            }
            return {
                id: template.id,
                name: template.name,
                areaShares: (0, productionTasks_1.areaSharesFrom)(template.areaShares),
                taskCount,
                areas,
                usedBy: usage.get(template.id) ?? 0,
                exampleKey: template.exampleKey,
                updatedAt: template.updatedAt,
            };
        });
    }
    async get(tenantId, id) {
        const [template, tasks] = await Promise.all([
            prisma_client_1.default.productionTaskTemplate.findFirst({ where: { id, tenantId, deletedAt: null } }),
            prisma_client_1.default.productionTaskTemplateTask.findMany({ where: { templateId: id, tenantId }, orderBy: { sortOrder: 'asc' } }),
        ]);
        return template ? templateOf(template, tasks.map(draftOf)) : null;
    }
    async nameTaken(tenantId, name, excludeId) {
        // Die Sortierfolge der Spalte (utf8mb4_unicode_ci) vergleicht ohne
        // Gross/klein — «chiller» ist also derselbe Name wie «Chiller».
        const found = await prisma_client_1.default.productionTaskTemplate.findFirst({
            where: { tenantId, deletedAt: null, name, ...(excludeId ? { id: { not: excludeId } } : {}) },
            select: { id: true },
        });
        return Boolean(found);
    }
    async create(tenantId, actorId, input, exampleKey) {
        const id = newId();
        const rows = templateTaskRows(tenantId, id, input.tasks);
        const created = await prisma_client_1.default.$transaction(async (tx) => {
            const template = await tx.productionTaskTemplate.create({
                data: {
                    id,
                    tenantId,
                    name: input.name,
                    areaShares: input.areaShares,
                    exampleKey: exampleKey ?? null,
                    createdById: actorId,
                    updatedById: actorId,
                },
            });
            if (rows.length)
                await tx.productionTaskTemplateTask.createMany({ data: rows });
            return template;
        });
        return templateOf(created, templateTasksFromRows(rows));
    }
    async replace(tenantId, id, actorId, input) {
        const rows = templateTaskRows(tenantId, id, input.tasks);
        const saved = await prisma_client_1.default.$transaction(async (tx) => {
            const updated = await tx.productionTaskTemplate.updateMany({
                where: { id, tenantId, deletedAt: null },
                data: {
                    name: input.name,
                    areaShares: input.areaShares,
                    updatedById: actorId,
                },
            });
            if (!updated.count)
                return null;
            await tx.productionTaskTemplateTask.deleteMany({ where: { templateId: id } });
            if (rows.length)
                await tx.productionTaskTemplateTask.createMany({ data: rows });
            return tx.productionTaskTemplate.findUnique({ where: { id } });
        });
        return saved ? templateOf(saved, templateTasksFromRows(rows)) : null;
    }
    async softDelete(tenantId, id, actorId) {
        const result = await prisma_client_1.default.productionTaskTemplate.updateMany({
            where: { id, tenantId, deletedAt: null },
            data: { deletedAt: new Date(), updatedById: actorId },
        });
        return result.count > 0;
    }
}
exports.PrismaProductionTaskTemplateRepository = PrismaProductionTaskTemplateRepository;
const deviceTaskOf = (row) => ({
    ...draftOf(row),
    planId: row.planId,
    updatedById: row.updatedById,
    updatedAt: row.updatedAt,
});
class PrismaProductionDeviceTaskRepository {
    async getPlan(tenantId, itemId) {
        // Plan und Aufgaben gleichzeitig: die Aufgaben tragen das Gerät selbst.
        const [plan, tasks] = await Promise.all([
            prisma_client_1.default.productionDeviceTaskPlan.findUnique({
                where: { tenantId_productionItemId: { tenantId, productionItemId: itemId } },
            }),
            prisma_client_1.default.productionDeviceTask.findMany({
                where: { tenantId, productionItemId: itemId },
                orderBy: { sortOrder: 'asc' },
            }),
        ]);
        if (!plan)
            return null;
        return {
            id: plan.id,
            tenantId: plan.tenantId,
            productionProjectId: plan.productionProjectId,
            productionItemId: plan.productionItemId,
            templateId: plan.templateId,
            templateName: plan.templateName,
            areaShares: (0, productionTasks_1.areaSharesFrom)(plan.areaShares),
            loadedById: plan.loadedById,
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
            // Ein gleichzeitiges Ersetzen könnte Aufgaben des alten Plans zeigen.
            tasks: tasks.filter((task) => task.planId === plan.id).map(deviceTaskOf),
        };
    }
    async replacePlan(tenantId, write) {
        const planId = newId();
        const now = new Date();
        const rows = write.tasks.map((task, index) => ({
            id: newId(),
            tenantId,
            planId,
            productionItemId: write.device.id,
            area: task.area,
            stage: task.stage,
            code: task.code,
            name: task.name,
            weight: task.weight,
            assigneeIds: task.assigneeIds,
            sortOrder: index,
            updatedById: write.actorId,
        }));
        const plan = await prisma_client_1.default.$transaction(async (tx) => {
            // Der alte Plan geht samt Aufgaben (ON DELETE CASCADE).
            await tx.productionDeviceTaskPlan.deleteMany({ where: { tenantId, productionItemId: write.device.id } });
            const created = await tx.productionDeviceTaskPlan.create({
                data: {
                    id: planId,
                    tenantId,
                    productionProjectId: write.device.productionProjectId,
                    productionItemId: write.device.id,
                    templateId: write.templateId,
                    templateName: write.templateName,
                    areaShares: write.areaShares,
                    loadedById: write.actorId,
                },
            });
            if (rows.length)
                await tx.productionDeviceTask.createMany({ data: rows });
            return created;
        });
        return {
            id: plan.id,
            tenantId,
            productionProjectId: plan.productionProjectId,
            productionItemId: plan.productionItemId,
            templateId: plan.templateId,
            templateName: plan.templateName,
            areaShares: (0, productionTasks_1.areaSharesFrom)(plan.areaShares),
            loadedById: plan.loadedById,
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
            tasks: rows.map((row) => deviceTaskOf({ ...row, assigneeIds: row.assigneeIds, updatedAt: now })),
        };
    }
    async setAssignees(tenantId, itemId, taskId, assigneeIds, actorId) {
        const current = await prisma_client_1.default.productionDeviceTask.findFirst({ where: { id: taskId, tenantId, productionItemId: itemId } });
        if (!current)
            return null;
        const updated = await prisma_client_1.default.productionDeviceTask.update({
            where: { id: current.id },
            data: { assigneeIds: assigneeIds, updatedById: actorId },
        });
        return { task: deviceTaskOf(updated), previous: (0, productionTasks_1.assigneeIdsFrom)(current.assigneeIds) };
    }
    async deletePlan(tenantId, itemId) {
        const result = await prisma_client_1.default.productionDeviceTaskPlan.deleteMany({ where: { tenantId, productionItemId: itemId } });
        return result.count > 0;
    }
}
exports.PrismaProductionDeviceTaskRepository = PrismaProductionDeviceTaskRepository;
const personName = (row) => `${row.firstName ?? ''} ${row.lastName ?? ''}`.replace(/\s+/g, ' ').trim();
class PrismaProductionTaskDirectory {
    async device(tenantId, itemId) {
        // Gerät und Projekt in EINER Abfrage (ein Rundgang statt zwei).
        const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT i.id, i.productionProjectId, i.name, i.positionNumber, i.isActive,
                   p.projectNumber, p.projectName
              FROM uretim_proje_kalemleri i
              JOIN uretim_projeler p ON p.id = i.productionProjectId
             WHERE i.id = ${itemId} AND i.tenantId = ${tenantId}
             LIMIT 1`);
        const row = rows[0];
        if (!row)
            return null;
        return {
            id: row.id,
            productionProjectId: row.productionProjectId,
            name: row.name,
            positionNumber: row.positionNumber ?? null,
            projectNumber: row.projectNumber,
            projectName: row.projectName,
            isActive: Boolean(row.isActive),
        };
    }
    async activePeople(tenantId, ids) {
        const unique = [...new Set(ids.filter(Boolean))];
        if (!unique.length)
            return new Set();
        const scope = await (0, serviceTenantScope_1.getPersonnelTenantScope)(tenantId);
        if (!scope.length)
            return new Set();
        const rows = await prisma_client_1.default.employee.findMany({
            where: {
                id: { in: unique },
                isActive: true,
                deletedAt: null,
                bannedAt: null,
                ...(0, serviceTenantScope_1.employeeScopeWhere)(scope),
            },
            select: { id: true },
        });
        return new Set(rows.map((row) => row.id));
    }
    async people(tenantId, ids) {
        const unique = [...new Set(ids.filter(Boolean))];
        if (!unique.length)
            return [];
        const [scope, rows] = await Promise.all([
            (0, serviceTenantScope_1.getPersonnelTenantScope)(tenantId),
            prisma_client_1.default.employee.findMany({
                where: { id: { in: unique } },
                select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    tenantId: true,
                    allowedTenantIds: true,
                    isActive: true,
                    deletedAt: true,
                    bannedAt: true,
                },
            }),
        ]);
        return rows
            .map((row) => ({
            id: row.id,
            name: personName(row) || row.id,
            active: row.isActive && !row.deletedAt && !row.bannedAt && (0, serviceTenantScope_1.isEmployeeInScope)(row, scope),
        }))
            .sort((left, right) => left.name.localeCompare(right.name, 'tr'));
    }
    async personName(id) {
        const row = await prisma_client_1.default.employee.findUnique({ where: { id }, select: { firstName: true, lastName: true } });
        return row ? personName(row) || null : null;
    }
}
exports.PrismaProductionTaskDirectory = PrismaProductionTaskDirectory;
//# sourceMappingURL=ProductionTaskRepository.js.map