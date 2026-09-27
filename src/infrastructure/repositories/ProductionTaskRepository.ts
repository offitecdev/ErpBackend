import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';

import prisma from '../database/prisma.client';
import type {
    ProductionDeviceTask,
    ProductionDeviceTaskPlan,
    ProductionTaskArea,
    ProductionTaskDevice,
    ProductionTaskDraft,
    ProductionTaskPerson,
    ProductionTaskStage,
    ProductionTaskTemplate,
    ProductionTaskTemplateInput,
    ProductionTaskTemplateSummary,
    ProductionTemplateTask,
} from '../../domain/entities/ProductionTask';
import type {
    IProductionDeviceTaskRepository,
    IProductionTaskDirectory,
    IProductionTaskTemplateRepository,
    ProductionDevicePlanWrite,
} from '../../domain/repositories/IProductionTaskRepository';
import {
    areaSharesFrom,
    assigneeIdsFrom,
    isProductionTaskArea,
    PRODUCTION_TASK_AREAS,
    PRODUCTION_TASK_STAGES,
    roundPercent,
    stageOfArea,
} from '../../domain/services/productionTasks';
import {
    employeeScopeWhere,
    getPersonnelTenantScope,
    isEmployeeInScope,
} from '../../presentation/controllers/serviceTenantScope';

/**
 * ── GÖREVLENDİRME · DIE DATENBANKSEITE (26.09.2026) ─────────────────────────
 *
 * Vorlagen (`uretim_gorev_sablon*`) und die Pläne der Geräte
 * (`uretim_cihaz_gorev*`). Die entfernte Datenbank kostet je Anfrage einen
 * Rundgang — Lesewege schicken ihre Abfragen darum GLEICHZEITIG los, und
 * nur das Schreiben läuft in einem Vorgang (Transaktion).
 */

const newId = (): string => nanoid(12);

const areaOf = (value: string): ProductionTaskArea => (isProductionTaskArea(value) ? value : 'MECHANICAL');

type TaskRow = {
    id: string;
    area: string;
    stage: string;
    code: string;
    name: string;
    weight: number;
    assigneeIds: Prisma.JsonValue;
    sortOrder: number;
};

/* Eine Stufe aus der Zeit vor den zwei Wegen (27.09.2026) liegt am passenden
   Platz des Weges — sonst am Anfang, damit keine Aufgabe unsichtbar wird. */
const stageOf = (area: ProductionTaskArea, value: string): ProductionTaskStage =>
    stageOfArea(area, value) ?? PRODUCTION_TASK_STAGES[area][0] ?? 'final';

const draftOf = (row: TaskRow): ProductionTaskDraft & { id: string; sortOrder: number } => ({
    id: row.id,
    area: areaOf(row.area),
    stage: stageOf(areaOf(row.area), row.stage),
    code: row.code,
    name: row.name,
    weight: roundPercent(Number(row.weight) || 0),
    assigneeIds: assigneeIdsFrom(row.assigneeIds),
    sortOrder: row.sortOrder,
});

type TemplateRow = {
    id: string;
    tenantId: string;
    name: string;
    areaShares: Prisma.JsonValue;
    exampleKey: string | null;
    createdById: string | null;
    updatedById: string | null;
    createdAt: Date;
    updatedAt: Date;
};

const templateOf = (row: TemplateRow, tasks: ProductionTemplateTask[]): ProductionTaskTemplate => ({
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    areaShares: areaSharesFrom(row.areaShares),
    exampleKey: row.exampleKey,
    createdById: row.createdById,
    updatedById: row.updatedById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tasks: [...tasks].sort((left, right) => left.sortOrder - right.sortOrder),
});

/** Die Aufgaben einer Vorlage als Zeilen — die Reihenfolge der Eingabe bleibt. */
const templateTaskRows = (tenantId: string, templateId: string, tasks: ProductionTaskDraft[]) =>
    tasks.map((task, index) => ({
        id: newId(),
        tenantId,
        templateId,
        area: task.area,
        stage: task.stage,
        code: task.code,
        name: task.name,
        weight: task.weight,
        assigneeIds: task.assigneeIds as Prisma.InputJsonValue,
        sortOrder: index,
    }));

const templateTasksFromRows = (rows: ReturnType<typeof templateTaskRows>): ProductionTemplateTask[] =>
    rows.map((row) => draftOf({ ...row, assigneeIds: row.assigneeIds as Prisma.JsonValue }));

export class PrismaProductionTaskTemplateRepository implements IProductionTaskTemplateRepository {
    async countEver(tenantId: string): Promise<number> {
        return prisma.productionTaskTemplate.count({ where: { tenantId } });
    }

    async list(tenantId: string): Promise<ProductionTaskTemplateSummary[]> {
        const [templates, taskGroups, planGroups] = await Promise.all([
            prisma.productionTaskTemplate.findMany({
                where: { tenantId, deletedAt: null },
                select: { id: true, name: true, areaShares: true, exampleKey: true, updatedAt: true },
                orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
            }),
            prisma.productionTaskTemplateTask.groupBy({
                by: ['templateId', 'area'],
                where: { tenantId },
                _count: { _all: true },
                _sum: { weight: true },
            }),
            prisma.productionDeviceTaskPlan.groupBy({
                by: ['templateId'],
                where: { tenantId, templateId: { not: null } },
                _count: { _all: true },
            }),
        ]);

        const usage = new Map(planGroups.map((group) => [group.templateId ?? '', group._count._all]));
        return templates.map((template) => {
            const areas = {} as ProductionTaskTemplateSummary['areas'];
            for (const area of PRODUCTION_TASK_AREAS) areas[area] = { taskCount: 0, weightSum: 0 };
            let taskCount = 0;
            for (const group of taskGroups) {
                if (group.templateId !== template.id || !isProductionTaskArea(group.area)) continue;
                areas[group.area] = {
                    taskCount: group._count._all,
                    weightSum: roundPercent(Number(group._sum.weight) || 0),
                };
                taskCount += group._count._all;
            }
            return {
                id: template.id,
                name: template.name,
                areaShares: areaSharesFrom(template.areaShares),
                taskCount,
                areas,
                usedBy: usage.get(template.id) ?? 0,
                exampleKey: template.exampleKey,
                updatedAt: template.updatedAt,
            };
        });
    }

    async get(tenantId: string, id: string): Promise<ProductionTaskTemplate | null> {
        const [template, tasks] = await Promise.all([
            prisma.productionTaskTemplate.findFirst({ where: { id, tenantId, deletedAt: null } }),
            prisma.productionTaskTemplateTask.findMany({ where: { templateId: id, tenantId }, orderBy: { sortOrder: 'asc' } }),
        ]);
        return template ? templateOf(template, tasks.map(draftOf)) : null;
    }

    async nameTaken(tenantId: string, name: string, excludeId?: string): Promise<boolean> {
        // Die Sortierfolge der Spalte (utf8mb4_unicode_ci) vergleicht ohne
        // Gross/klein — «chiller» ist also derselbe Name wie «Chiller».
        const found = await prisma.productionTaskTemplate.findFirst({
            where: { tenantId, deletedAt: null, name, ...(excludeId ? { id: { not: excludeId } } : {}) },
            select: { id: true },
        });
        return Boolean(found);
    }

    async create(
        tenantId: string,
        actorId: string | null,
        input: ProductionTaskTemplateInput,
        exampleKey?: string,
    ): Promise<ProductionTaskTemplate> {
        const id = newId();
        const rows = templateTaskRows(tenantId, id, input.tasks);
        const created = await prisma.$transaction(async (tx) => {
            const template = await tx.productionTaskTemplate.create({
                data: {
                    id,
                    tenantId,
                    name: input.name,
                    areaShares: input.areaShares as unknown as Prisma.InputJsonValue,
                    exampleKey: exampleKey ?? null,
                    createdById: actorId,
                    updatedById: actorId,
                },
            });
            if (rows.length) await tx.productionTaskTemplateTask.createMany({ data: rows });
            return template;
        });
        return templateOf(created, templateTasksFromRows(rows));
    }

    async replace(
        tenantId: string,
        id: string,
        actorId: string,
        input: ProductionTaskTemplateInput,
    ): Promise<ProductionTaskTemplate | null> {
        const rows = templateTaskRows(tenantId, id, input.tasks);
        const saved = await prisma.$transaction(async (tx) => {
            const updated = await tx.productionTaskTemplate.updateMany({
                where: { id, tenantId, deletedAt: null },
                data: {
                    name: input.name,
                    areaShares: input.areaShares as unknown as Prisma.InputJsonValue,
                    updatedById: actorId,
                },
            });
            if (!updated.count) return null;
            await tx.productionTaskTemplateTask.deleteMany({ where: { templateId: id } });
            if (rows.length) await tx.productionTaskTemplateTask.createMany({ data: rows });
            return tx.productionTaskTemplate.findUnique({ where: { id } });
        });
        return saved ? templateOf(saved, templateTasksFromRows(rows)) : null;
    }

    async softDelete(tenantId: string, id: string, actorId: string): Promise<boolean> {
        const result = await prisma.productionTaskTemplate.updateMany({
            where: { id, tenantId, deletedAt: null },
            data: { deletedAt: new Date(), updatedById: actorId },
        });
        return result.count > 0;
    }
}

type DeviceTaskRow = TaskRow & { planId: string; updatedById: string | null; updatedAt: Date };

const deviceTaskOf = (row: DeviceTaskRow): ProductionDeviceTask => ({
    ...draftOf(row),
    planId: row.planId,
    updatedById: row.updatedById,
    updatedAt: row.updatedAt,
});

export class PrismaProductionDeviceTaskRepository implements IProductionDeviceTaskRepository {
    async getPlan(tenantId: string, itemId: string): Promise<ProductionDeviceTaskPlan | null> {
        // Plan und Aufgaben gleichzeitig: die Aufgaben tragen das Gerät selbst.
        const [plan, tasks] = await Promise.all([
            prisma.productionDeviceTaskPlan.findUnique({
                where: { tenantId_productionItemId: { tenantId, productionItemId: itemId } },
            }),
            prisma.productionDeviceTask.findMany({
                where: { tenantId, productionItemId: itemId },
                orderBy: { sortOrder: 'asc' },
            }),
        ]);
        if (!plan) return null;
        return {
            id: plan.id,
            tenantId: plan.tenantId,
            productionProjectId: plan.productionProjectId,
            productionItemId: plan.productionItemId,
            templateId: plan.templateId,
            templateName: plan.templateName,
            areaShares: areaSharesFrom(plan.areaShares),
            loadedById: plan.loadedById,
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
            // Ein gleichzeitiges Ersetzen könnte Aufgaben des alten Plans zeigen.
            tasks: tasks.filter((task) => task.planId === plan.id).map(deviceTaskOf),
        };
    }

    async replacePlan(tenantId: string, write: ProductionDevicePlanWrite): Promise<ProductionDeviceTaskPlan> {
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
            assigneeIds: task.assigneeIds as Prisma.InputJsonValue,
            sortOrder: index,
            updatedById: write.actorId,
        }));
        const plan = await prisma.$transaction(async (tx) => {
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
                    areaShares: write.areaShares as unknown as Prisma.InputJsonValue,
                    loadedById: write.actorId,
                },
            });
            if (rows.length) await tx.productionDeviceTask.createMany({ data: rows });
            return created;
        });
        return {
            id: plan.id,
            tenantId,
            productionProjectId: plan.productionProjectId,
            productionItemId: plan.productionItemId,
            templateId: plan.templateId,
            templateName: plan.templateName,
            areaShares: areaSharesFrom(plan.areaShares),
            loadedById: plan.loadedById,
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
            tasks: rows.map((row) => deviceTaskOf({ ...row, assigneeIds: row.assigneeIds as Prisma.JsonValue, updatedAt: now })),
        };
    }

    async setAssignees(
        tenantId: string,
        itemId: string,
        taskId: string,
        assigneeIds: string[],
        actorId: string,
    ): Promise<{ task: ProductionDeviceTask; previous: string[] } | null> {
        const current = await prisma.productionDeviceTask.findFirst({ where: { id: taskId, tenantId, productionItemId: itemId } });
        if (!current) return null;
        const updated = await prisma.productionDeviceTask.update({
            where: { id: current.id },
            data: { assigneeIds: assigneeIds as Prisma.InputJsonValue, updatedById: actorId },
        });
        return { task: deviceTaskOf(updated), previous: assigneeIdsFrom(current.assigneeIds) };
    }

    async deletePlan(tenantId: string, itemId: string): Promise<boolean> {
        const result = await prisma.productionDeviceTaskPlan.deleteMany({ where: { tenantId, productionItemId: itemId } });
        return result.count > 0;
    }
}

const personName = (row: { firstName: string | null; lastName: string | null }): string =>
    `${row.firstName ?? ''} ${row.lastName ?? ''}`.replace(/\s+/g, ' ').trim();

export class PrismaProductionTaskDirectory implements IProductionTaskDirectory {
    async device(tenantId: string, itemId: string): Promise<ProductionTaskDevice | null> {
        // Gerät und Projekt in EINER Abfrage (ein Rundgang statt zwei).
        const rows = await prisma.$queryRaw<Array<{
            id: string;
            productionProjectId: string;
            name: string;
            positionNumber: string | null;
            isActive: number | boolean;
            projectNumber: string;
            projectName: string;
        }>>(Prisma.sql`
            SELECT i.id, i.productionProjectId, i.name, i.positionNumber, i.isActive,
                   p.projectNumber, p.projectName
              FROM uretim_proje_kalemleri i
              JOIN uretim_projeler p ON p.id = i.productionProjectId
             WHERE i.id = ${itemId} AND i.tenantId = ${tenantId}
             LIMIT 1`);
        const row = rows[0];
        if (!row) return null;
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

    async activePeople(tenantId: string, ids: string[]): Promise<Set<string>> {
        const unique = [...new Set(ids.filter(Boolean))];
        if (!unique.length) return new Set();
        const scope = await getPersonnelTenantScope(tenantId);
        if (!scope.length) return new Set();
        const rows = await prisma.employee.findMany({
            where: {
                id: { in: unique },
                isActive: true,
                deletedAt: null,
                bannedAt: null,
                ...employeeScopeWhere(scope),
            },
            select: { id: true },
        });
        return new Set(rows.map((row) => row.id));
    }

    async people(tenantId: string, ids: string[]): Promise<ProductionTaskPerson[]> {
        const unique = [...new Set(ids.filter(Boolean))];
        if (!unique.length) return [];
        const [scope, rows] = await Promise.all([
            getPersonnelTenantScope(tenantId),
            prisma.employee.findMany({
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
                active: row.isActive && !row.deletedAt && !row.bannedAt && isEmployeeInScope(row, scope),
            }))
            .sort((left, right) => left.name.localeCompare(right.name, 'tr'));
    }

    async personName(id: string): Promise<string | null> {
        const row = await prisma.employee.findUnique({ where: { id }, select: { firstName: true, lastName: true } });
        return row ? personName(row) || null : null;
    }
}
