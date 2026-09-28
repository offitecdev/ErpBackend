import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';

import prisma from '../database/prisma.client';
import type {
    ProductionSubtask,
    ProductionAreaTotals,
    ProductionDeviceTask,
    ProductionDeviceTaskPlan,
    ProductionTaskDevice,
    ProductionTaskDraft,
    ProductionTaskPerson,
    ProductionTaskSection,
    ProductionTaskStatus,
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
    areaSharesOf,
    areaTotals,
    assigneeIdsFrom,
    placeTask,
    roundPercent,
    sectionsFrom,
    statusFrom,
    statusOfSubtasks,
    subtasksFrom,
    mergeDeviceRecord,
    withoutDeviceRecord,
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

type TaskRow = {
    id: string;
    area: string;
    stage: string;
    code: string;
    name: string;
    weight: number;
    assigneeIds: Prisma.JsonValue;
    subtasks: Prisma.JsonValue;
    startDate: Date | null;
    dueDate: Date | null;
    createdAt: Date | null;
    sortOrder: number;
};

/* Beginn und Termin sind DATE-Spalten: Prisma liefert Mitternacht UTC —
   der Tag ist der Anfang der ISO-Zeit, geschrieben wird er genauso. */
const dayOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);
const dateOf = (day: string | null): Date | null => (day ? new Date(`${day}T00:00:00.000Z`) : null);

/* Eine Aufgabe liegt immer in einem Bereich und einer Stufe ihrer Vorlage —
   eine Stufe aus der Zeit vor den zwei Wegen (27.09.2026) am passenden Platz
   des Weges, sonst am Anfang, damit keine Aufgabe unsichtbar wird. */
const draftOf = (row: TaskRow, sections: readonly ProductionTaskSection[]): ProductionTaskDraft & { id: string; sortOrder: number } => ({
    id: row.id,
    ...placeTask(sections, row.area, row.stage),
    code: row.code,
    name: row.name,
    weight: roundPercent(Number(row.weight) || 0),
    assigneeIds: assigneeIdsFrom(row.assigneeIds),
    startDate: dayOf(row.startDate),
    dueDate: dayOf(row.dueDate),
    createdAt: dayOf(row.createdAt),
    subtasks: subtasksFrom(row.subtasks),
    sortOrder: row.sortOrder,
});

type TemplateRow = {
    id: string;
    tenantId: string;
    name: string;
    areaShares: Prisma.JsonValue;
    sections: Prisma.JsonValue;
    exampleKey: string | null;
    createdById: string | null;
    updatedById: string | null;
    createdAt: Date;
    updatedAt: Date;
};

const templateOf = (row: TemplateRow, taskRows: readonly TaskRow[]): ProductionTaskTemplate => {
    const sections = sectionsFrom(row.sections, row.areaShares);
    return {
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        sections,
        exampleKey: row.exampleKey,
        createdById: row.createdById,
        updatedById: row.updatedById,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        tasks: taskRows
            .map((task): ProductionTemplateTask => draftOf(task, sections))
            .sort((left, right) => left.sortOrder - right.sortOrder),
    };
};

/** Bereiche und Anteile, wie sie in die Zeile einer Vorlage oder eines Plans gehen. */
const sectionColumns = (sections: readonly ProductionTaskSection[]) => ({
    areaShares: areaSharesOf(sections) as Prisma.InputJsonValue,
    sections: sections as unknown as Prisma.InputJsonValue,
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
        subtasks: task.subtasks as unknown as Prisma.InputJsonValue,
        startDate: dateOf(task.startDate),
        dueDate: dateOf(task.dueDate),
        // Das Beispiel kommt ohne Tag: es entsteht heute.
        createdAt: dateOf(task.createdAt ?? new Date().toISOString().slice(0, 10)),
        sortOrder: index,
    }));

/** Die eben geschriebenen Zeilen wieder als Aufgaben — ohne neuen Rundgang. */
const writtenRows = <T extends { assigneeIds: Prisma.InputJsonValue; subtasks: Prisma.InputJsonValue }>(rows: T[]) =>
    rows.map((row) => ({ ...row, assigneeIds: row.assigneeIds as Prisma.JsonValue, subtasks: row.subtasks as Prisma.JsonValue }));

export class PrismaProductionTaskTemplateRepository implements IProductionTaskTemplateRepository {
    async countEver(tenantId: string): Promise<number> {
        return prisma.productionTaskTemplate.count({ where: { tenantId } });
    }

    async list(tenantId: string): Promise<ProductionTaskTemplateSummary[]> {
        const [templates, taskRows, planGroups] = await Promise.all([
            prisma.productionTaskTemplate.findMany({
                where: { tenantId, deletedAt: null },
                select: { id: true, name: true, areaShares: true, sections: true, exampleKey: true, updatedAt: true },
                orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
            }),
            prisma.productionTaskTemplateTask.findMany({
                where: { tenantId },
                select: { templateId: true, area: true, weight: true },
            }),
            prisma.productionDeviceTaskPlan.groupBy({
                by: ['templateId'],
                where: { tenantId, templateId: { not: null } },
                _count: { _all: true },
            }),
        ]);

        const usage = new Map(planGroups.map((group) => [group.templateId ?? '', group._count._all]));
        return templates.map((template) => {
            const sections = sectionsFrom(template.sections, template.areaShares);
            const own = taskRows.filter((row) => row.templateId === template.id);
            // Wie beim Lesen der Vorlage: eine Aufgabe in einem unbekannten Bereich zählt zum ersten.
            const areas: ProductionAreaTotals = areaTotals(sections, own.map((row) => ({
                area: placeTask(sections, row.area, '').area,
                weight: roundPercent(Number(row.weight) || 0),
            })));
            const taskCount = own.length;
            return {
                id: template.id,
                name: template.name,
                sections,
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
        return template ? templateOf(template, tasks) : null;
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
                    ...sectionColumns(input.sections),
                    exampleKey: exampleKey ?? null,
                    createdById: actorId,
                    updatedById: actorId,
                },
            });
            if (rows.length) await tx.productionTaskTemplateTask.createMany({ data: rows });
            return template;
        });
        return templateOf(created, writtenRows(rows));
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
                    ...sectionColumns(input.sections),
                    updatedById: actorId,
                },
            });
            if (!updated.count) return null;
            await tx.productionTaskTemplateTask.deleteMany({ where: { templateId: id } });
            if (rows.length) await tx.productionTaskTemplateTask.createMany({ data: rows });
            return tx.productionTaskTemplate.findUnique({ where: { id } });
        });
        return saved ? templateOf(saved, writtenRows(rows)) : null;
    }

    async softDelete(tenantId: string, id: string, actorId: string): Promise<boolean> {
        const result = await prisma.productionTaskTemplate.updateMany({
            where: { id, tenantId, deletedAt: null },
            data: { deletedAt: new Date(), updatedById: actorId },
        });
        return result.count > 0;
    }
}

type DeviceTaskRow = TaskRow & { planId: string; status: string; updatedById: string | null; updatedAt: Date };

const deviceTaskOf = (row: DeviceTaskRow, sections: readonly ProductionTaskSection[]): ProductionDeviceTask => ({
    ...draftOf(row, sections),
    planId: row.planId,
    status: statusFrom(row.status),
    updatedById: row.updatedById,
    updatedAt: row.updatedAt,
});

type PlanRow = {
    id: string;
    tenantId: string;
    productionProjectId: string;
    productionItemId: string;
    templateId: string | null;
    templateName: string;
    areaShares: Prisma.JsonValue;
    sections: Prisma.JsonValue;
    loadedById: string | null;
    createdAt: Date;
    updatedAt: Date;
};

const planOf = (plan: PlanRow, taskRows: readonly DeviceTaskRow[]): ProductionDeviceTaskPlan => {
    const sections = sectionsFrom(plan.sections, plan.areaShares);
    return {
        id: plan.id,
        tenantId: plan.tenantId,
        productionProjectId: plan.productionProjectId,
        productionItemId: plan.productionItemId,
        templateId: plan.templateId,
        templateName: plan.templateName,
        sections,
        loadedById: plan.loadedById,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        tasks: taskRows.map((task) => deviceTaskOf(task, sections)),
    };
};

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
        // Ein gleichzeitiges Ersetzen könnte Aufgaben des alten Plans zeigen.
        return planOf(plan, tasks.filter((task) => task.planId === plan.id));
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
            subtasks: task.subtasks as unknown as Prisma.InputJsonValue,
            startDate: dateOf(task.startDate),
            dueDate: dateOf(task.dueDate),
            status: 'TODO',
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
                    ...sectionColumns(write.sections),
                    loadedById: write.actorId,
                },
            });
            if (rows.length) await tx.productionDeviceTask.createMany({ data: rows });
            return created;
        });
        return planOf(plan, writtenRows(rows).map((row) => ({ ...row, createdAt: now, updatedAt: now })));
    }

    async setAssignees(
        tenantId: string,
        itemId: string,
        taskId: string,
        assigneeIds: string[],
        actorId: string,
    ): Promise<{ task: ProductionDeviceTask; previous: string[] } | null> {
        const [current, plan] = await Promise.all([
            prisma.productionDeviceTask.findFirst({ where: { id: taskId, tenantId, productionItemId: itemId } }),
            prisma.productionDeviceTaskPlan.findUnique({
                where: { tenantId_productionItemId: { tenantId, productionItemId: itemId } },
                select: { areaShares: true, sections: true },
            }),
        ]);
        if (!current) return null;
        const updated = await prisma.productionDeviceTask.update({
            where: { id: current.id },
            data: { assigneeIds: assigneeIds as Prisma.InputJsonValue, updatedById: actorId },
        });
        const sections = plan ? sectionsFrom(plan.sections, plan.areaShares) : [];
        return { task: deviceTaskOf(updated, sections), previous: assigneeIdsFrom(current.assigneeIds) };
    }

    async setSections(tenantId: string, itemId: string, sections: ProductionTaskSection[]): Promise<ProductionDeviceTaskPlan | null> {
        const updated = await prisma.productionDeviceTaskPlan.updateMany({
            where: { tenantId, productionItemId: itemId },
            // Nur Bereiche und Stufen — die Aufgaben (Stand, Dateien) fasst das nicht an.
            data: { ...sectionColumns(sections), updatedAt: new Date() },
        });
        return updated.count ? this.getPlan(tenantId, itemId) : null;
    }

    async replaceTasks(
        tenantId: string,
        itemId: string,
        tasks: Array<ProductionTaskDraft & { id: string | null }>,
        actorId: string,
    ): Promise<ProductionDeviceTaskPlan | null> {
        const saved = await prisma.$transaction(async (tx) => {
            const plan = await tx.productionDeviceTaskPlan.findUnique({
                where: { tenantId_productionItemId: { tenantId, productionItemId: itemId } },
            });
            if (!plan) return null;
            const before = await tx.productionDeviceTask.findMany({ where: { planId: plan.id } });
            const known = new Map(before.map((row) => [row.id, row]));
            const now = new Date();
            const used = new Set<string>();
            const rows = tasks.map((task, index) => {
                // Eine bekannte Aufgabe behält Kennung, Stand und Zeitpunkt des Anlegens.
                const previous = task.id && !used.has(task.id) ? known.get(task.id) : undefined;
                const id = previous ? previous.id : newId();
                used.add(id);
                // Stand, Dateien und Abschluss einer Unteraufgabe gehören dem Server:
                // die Anpassung ändert Name, Gewicht und Tage, nie diese (28.09.2026) —
                // ausser eine Pflicht kommt dazu: dann beginnt sie offen von vorn (mergeDeviceRecord).
                const earlier = new Map(previous ? subtasksFrom(previous.subtasks).map((entry) => [entry.id, entry]) : []);
                const subtasks = task.subtasks.map((subtask) => {
                    const kept = earlier.get(subtask.id);
                    return kept ? mergeDeviceRecord(subtask, kept) : withoutDeviceRecord(subtask);
                });
                return {
                    id,
                    tenantId,
                    planId: plan.id,
                    productionItemId: itemId,
                    area: task.area,
                    stage: task.stage,
                    code: task.code,
                    name: task.name,
                    weight: task.weight,
                    assigneeIds: task.assigneeIds as Prisma.InputJsonValue,
                    subtasks: subtasks as unknown as Prisma.InputJsonValue,
                    startDate: dateOf(task.startDate),
                    dueDate: dateOf(task.dueDate),
                    // Mit Unteraufgaben folgt der Stand ihnen; sonst bleibt er, wie er war.
                    status: statusOfSubtasks(subtasks) ?? previous?.status ?? 'TODO',
                    createdAt: previous?.createdAt ?? now,
                    sortOrder: index,
                    updatedById: actorId,
                };
            });
            await tx.productionDeviceTask.deleteMany({ where: { planId: plan.id } });
            if (rows.length) await tx.productionDeviceTask.createMany({ data: rows });
            await tx.productionDeviceTaskPlan.update({ where: { id: plan.id }, data: { updatedAt: now } });
            return { plan, rows: writtenRows(rows).map((row) => ({ ...row, updatedAt: now })) };
        });
        return saved ? planOf(saved.plan, saved.rows) : null;
    }

    private async sectionsOfPlan(tenantId: string, itemId: string): Promise<ProductionTaskSection[]> {
        const plan = await prisma.productionDeviceTaskPlan.findUnique({
            where: { tenantId_productionItemId: { tenantId, productionItemId: itemId } },
            select: { areaShares: true, sections: true },
        });
        return plan ? sectionsFrom(plan.sections, plan.areaShares) : [];
    }

    async getTask(tenantId: string, itemId: string, taskId: string): Promise<ProductionDeviceTask | null> {
        const [row, sections] = await Promise.all([
            prisma.productionDeviceTask.findFirst({ where: { id: taskId, tenantId, productionItemId: itemId } }),
            this.sectionsOfPlan(tenantId, itemId),
        ]);
        return row ? deviceTaskOf(row, sections) : null;
    }

    async setStatus(
        tenantId: string,
        itemId: string,
        taskId: string,
        status: ProductionTaskStatus,
        actorId: string,
    ): Promise<ProductionDeviceTask | null> {
        const result = await prisma.productionDeviceTask.updateMany({
            where: { id: taskId, tenantId, productionItemId: itemId },
            data: { status, updatedById: actorId },
        });
        return result.count ? this.getTask(tenantId, itemId, taskId) : null;
    }

    async changeSubtask(
        tenantId: string,
        itemId: string,
        taskId: string,
        subtaskId: string,
        change: (subtask: ProductionSubtask, task: ProductionDeviceTask) => ProductionSubtask,
        actorId: string,
    ): Promise<ProductionDeviceTask | null | 'no-subtask'> {
        const sections = await this.sectionsOfPlan(tenantId, itemId);
        const outcome = await prisma.$transaction(async (tx) => {
            // Die Zeile sperren: zwei gleichzeitige Änderungen (Datei, Stand) überschreiben einander nicht.
            await tx.$queryRaw`SELECT id FROM uretim_cihaz_gorevleri WHERE id = ${taskId} FOR UPDATE`;
            const row = await tx.productionDeviceTask.findFirst({ where: { id: taskId, tenantId, productionItemId: itemId } });
            if (!row) return null;
            const subtasks = subtasksFrom(row.subtasks);
            const current = subtasks.find((subtask) => subtask.id === subtaskId);
            if (!current) return 'no-subtask' as const;
            const changed = change(current, deviceTaskOf(row, sections));
            const next = subtasks.map((subtask) => (subtask.id === subtaskId ? changed : subtask));
            await tx.productionDeviceTask.update({
                where: { id: row.id },
                data: {
                    subtasks: next as unknown as Prisma.InputJsonValue,
                    // Die Aufgabe folgt ihren Unteraufgaben.
                    status: statusOfSubtasks(next) ?? row.status,
                    updatedById: actorId,
                },
            });
            return 'ok' as const;
        });
        if (outcome !== 'ok') return outcome;
        return this.getTask(tenantId, itemId, taskId);
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
