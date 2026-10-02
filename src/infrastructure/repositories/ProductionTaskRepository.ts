import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';

import prisma from '../database/prisma.client';
import type {
    ProductionSubtask,
    ProductionDeviceTask,
    ProductionDeviceTaskPlan,
    ProductionTaskActivity,
    ProductionTaskActivityDraft,
    ProductionTaskActivityKind,
    ProductionTaskRequest,
    ProductionTaskRequestDraft,
    ProductionTaskRequestKind,
    ProductionTaskRequestResolution,
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
    IProductionTaskActivityLog,
    IProductionTaskDirectory,
    IProductionTaskRequestRepository,
    IProductionTaskTemplateRepository,
    ProductionDevicePlanWrite,
    ProductionTaskActivityQuery,
} from '../../domain/repositories/IProductionTaskRepository';
import {
    areaSharesOf,
    placeTask,
    resolveTaskWeights,
    sectionShareOf,
    sectionsFrom,
    stageWeightIn,
    storedStageWeightsComplete,
    statusFrom,
    statusOfSubtasks,
    withWorkClock,
    subtasksFrom,
    taskAssigneesOf,
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
    stageWeight: number | null;
    assigneeIds: Prisma.JsonValue;
    subtasks: Prisma.JsonValue;
    startDate: Date | null;
    dueDate: Date | null;
    createdAt: Date | null;
    sortOrder: number;
    customerVisible?: boolean;
};

/* Beginn und Termin sind DATE-Spalten: Prisma liefert Mitternacht UTC —
   der Tag ist der Anfang der ISO-Zeit, geschrieben wird er genauso. */
const dayOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null);
const dateOf = (day: string | null): Date | null => (day ? new Date(`${day}T00:00:00.000Z`) : null);

/* Eine Aufgabe liegt immer in einem Bereich und einer Stufe ihrer Vorlage —
   eine Stufe aus der Zeit vor den zwei Wegen (27.09.2026) am passenden Platz
   des Weges, sonst am Anfang, damit keine Aufgabe unsichtbar wird.
   `weight` ist das Gewicht in der Stufe (30.09.2026), aus `withWeights`. */
const draftOf = (row: TaskRow, sections: readonly ProductionTaskSection[], weight: number): ProductionTaskDraft & { id: string; sortOrder: number } => {
    const subtasks = subtasksFrom(row.subtasks);
    return {
        id: row.id,
        ...placeTask(sections, row.area, row.stage),
        code: row.code,
        name: row.name,
        weight,
        // Die Personen der Aufgabe sind die ihrer Unteraufgaben (29.09.2026). Die Spalte
        // `assigneeIds` hält nur noch diese Summe; früher an der Aufgabe gesetzte Personen fallen weg.
        assigneeIds: taskAssigneesOf(subtasks),
        startDate: dayOf(row.startDate),
        dueDate: dayOf(row.dueDate),
        createdAt: dayOf(row.createdAt),
        subtasks,
        sortOrder: row.sortOrder,
        customerVisible: row.customerVisible === true,
    };
};

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

/**
 * Die Bereiche samt Gewichten der Stufen und je Zeile das Gewicht der Aufgabe in ihrer Stufe
 * (30.09.2026) — gespeichert oder, bei Daten von vorher, aus den Anteilen am Bereich abgeleitet.
 */
const withWeights = (
    storedSections: Prisma.JsonValue,
    areaShares: Prisma.JsonValue,
    rows: ReadonlyArray<Pick<TaskRow, 'area' | 'stage' | 'weight' | 'stageWeight'>>,
): { sections: ProductionTaskSection[]; weights: number[] } => {
    const base = sectionsFrom(storedSections, areaShares);
    return resolveTaskWeights(base, storedStageWeightsComplete(storedSections), rows.map((row) => {
        const place = placeTask(base, row.area, row.stage);
        return {
            area: place.area,
            stage: place.stage,
            sectionShare: Number(row.weight) || 0,
            stageWeight: row.stageWeight === null || row.stageWeight === undefined ? null : Number(row.stageWeight),
        };
    }));
};

/** Was eine Aufgabe in die Zeile schreibt: Gewicht in der Stufe und — für ältere Stände — Anteil am Bereich. */
const weightColumns = (sections: readonly ProductionTaskSection[], task: Pick<ProductionTaskDraft, 'area' | 'stage' | 'weight'>) => ({
    weight: sectionShareOf(stageWeightIn(sections, task.area, task.stage), task.weight),
    stageWeight: task.weight,
});

const templateOf = (row: TemplateRow, taskRows: readonly TaskRow[]): ProductionTaskTemplate => {
    const { sections, weights } = withWeights(row.sections, row.areaShares, taskRows);
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
            .map((task, index): ProductionTemplateTask => draftOf(task, sections, weights[index] ?? 0))
            .sort((left, right) => left.sortOrder - right.sortOrder),
    };
};

/** Bereiche und Anteile, wie sie in die Zeile einer Vorlage oder eines Plans gehen. */
const sectionColumns = (sections: readonly ProductionTaskSection[]) => ({
    areaShares: areaSharesOf(sections) as Prisma.InputJsonValue,
    sections: sections as unknown as Prisma.InputJsonValue,
});

/** Die Aufgaben einer Vorlage als Zeilen — die Reihenfolge der Eingabe bleibt. */
const templateTaskRows = (tenantId: string, templateId: string, tasks: ProductionTaskDraft[], sections: readonly ProductionTaskSection[]) =>
    tasks.map((task, index) => ({
        id: newId(),
        tenantId,
        templateId,
        area: task.area,
        stage: task.stage,
        code: task.code,
        name: task.name,
        ...weightColumns(sections, task),
        assigneeIds: task.assigneeIds as Prisma.InputJsonValue,
        subtasks: task.subtasks as unknown as Prisma.InputJsonValue,
        startDate: dateOf(task.startDate),
        dueDate: dateOf(task.dueDate),
        // Das Beispiel kommt ohne Tag: es entsteht heute.
        createdAt: dateOf(task.createdAt ?? new Date().toISOString().slice(0, 10)),
        sortOrder: index,
        customerVisible: task.customerVisible === true,
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
                select: { templateId: true, area: true, stage: true, weight: true, stageWeight: true },
            }),
            prisma.productionDeviceTaskPlan.groupBy({
                by: ['templateId'],
                where: { tenantId, templateId: { not: null } },
                _count: { _all: true },
            }),
        ]);

        const usage = new Map(planGroups.map((group) => [group.templateId ?? '', group._count._all]));
        return templates.map((template) => {
            const own = taskRows.filter((row) => row.templateId === template.id);
            // Wie beim Lesen der Vorlage: Gewichte der Stufen und Aufgaben, eine unbekannte Stelle am Anfang des Weges.
            const { sections, weights } = withWeights(template.sections, template.areaShares, own);
            const taskCount = own.length;
            return {
                id: template.id,
                name: template.name,
                sections,
                taskCount,
                weights: own.map((row, index) => ({ ...placeTask(sections, row.area, row.stage), weight: weights[index] ?? 0 })),
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
        const rows = templateTaskRows(tenantId, id, input.tasks, input.sections);
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
        const rows = templateTaskRows(tenantId, id, input.tasks, input.sections);
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

const deviceTaskOf = (row: DeviceTaskRow, sections: readonly ProductionTaskSection[], weight: number): ProductionDeviceTask => ({
    ...draftOf(row, sections, weight),
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
    const { sections, weights } = withWeights(plan.sections, plan.areaShares, taskRows);
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
        tasks: taskRows.map((task, index) => deviceTaskOf(task, sections, weights[index] ?? 0)),
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
            ...weightColumns(write.sections, task),
            assigneeIds: task.assigneeIds as Prisma.InputJsonValue,
            subtasks: task.subtasks as unknown as Prisma.InputJsonValue,
            startDate: dateOf(task.startDate),
            dueDate: dateOf(task.dueDate),
            status: 'TODO',
            sortOrder: index,
            customerVisible: task.customerVisible === true,
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
        sections: readonly ProductionTaskSection[],
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
                    ...weightColumns(sections, task),
                    assigneeIds: task.assigneeIds as Prisma.InputJsonValue,
                    subtasks: subtasks as unknown as Prisma.InputJsonValue,
                    startDate: dateOf(task.startDate),
                    dueDate: dateOf(task.dueDate),
                    // Mit Unteraufgaben folgt der Stand ihnen; sonst bleibt er, wie er war.
                    status: statusOfSubtasks(subtasks) ?? previous?.status ?? 'TODO',
                    createdAt: previous?.createdAt ?? now,
                    sortOrder: index,
                    customerVisible: task.customerVisible === true,
                    updatedById: actorId,
                };
            });
            await tx.productionDeviceTask.deleteMany({ where: { planId: plan.id } });
            if (rows.length) await tx.productionDeviceTask.createMany({ data: rows });
            // Die Gewichte der Stufen (30.09.2026) gehen mit — im selben Vorgang wie die Aufgaben.
            const updated = await tx.productionDeviceTaskPlan.update({ where: { id: plan.id }, data: { updatedAt: now, ...sectionColumns(sections) } });
            return { plan: updated, rows: writtenRows(rows).map((row) => ({ ...row, updatedAt: now })) };
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
        // Das Gewicht in der Stufe kann von den übrigen Aufgaben abhängen (Daten von vorher) — darum der ganze Plan.
        const plan = await this.getPlan(tenantId, itemId);
        return plan?.tasks.find((task) => task.id === taskId) ?? null;
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
            // Der Rückruf braucht die Aufgabe nur zum Lesen von Stand und Personen — das Gewicht zählt hier nicht.
            // Die Arbeitszeit folgt dem Stand — bei jeder Änderung, wer sie auch macht (02.10.2026).
            const changed = withWorkClock(current, change(current, deviceTaskOf(row, sections, Number(row.stageWeight ?? 0))), new Date());
            const next = subtasks.map((subtask) => (subtask.id === subtaskId ? changed : subtask));
            await tx.productionDeviceTask.update({
                where: { id: row.id },
                data: {
                    subtasks: next as unknown as Prisma.InputJsonValue,
                    // Die Aufgabe folgt ihren Unteraufgaben — im Stand wie in den Personen.
                    status: statusOfSubtasks(next) ?? row.status,
                    assigneeIds: taskAssigneesOf(next) as Prisma.InputJsonValue,
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

    async itemIdsForAssignee(tenantId: string, employeeId: string): Promise<string[]> {
        // `assigneeIds` hält die Personen aller Unteraufgaben der Aufgabe (JSON-Liste) — EIN Rundgang.
        const rows = await prisma.$queryRaw<Array<{ productionItemId: string }>>(Prisma.sql`
            SELECT DISTINCT productionItemId
              FROM uretim_cihaz_gorevleri
             WHERE tenantId = ${tenantId}
               AND JSON_CONTAINS(assigneeIds, JSON_QUOTE(${employeeId}))`);
        return rows.map((row) => row.productionItemId);
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

    async taskDevices(tenantId: string) {
        // Die Geräte mit Aufgaben und ihre Projekte in EINER Abfrage (ein Rundgang).
        const rows = await prisma.$queryRaw<Array<{
            projectId: string;
            projectNumber: string;
            projectName: string;
            deviceId: string;
            deviceName: string;
            positionNumber: string | null;
            templateName: string;
            taskCount: bigint | number;
        }>>(Prisma.sql`
            SELECT p.id AS projectId, p.projectNumber, p.projectName,
                   i.id AS deviceId, i.name AS deviceName, i.positionNumber,
                   g.templateName,
                   (SELECT COUNT(*) FROM uretim_cihaz_gorevleri t WHERE t.planId = g.id) AS taskCount
              FROM uretim_cihaz_gorev_planlari g
              JOIN uretim_proje_kalemleri i ON i.id = g.productionItemId AND i.tenantId = g.tenantId
              JOIN uretim_projeler p ON p.id = i.productionProjectId
             WHERE g.tenantId = ${tenantId} AND i.isActive = 1`);
        // COUNT(*) kommt als BigInt — für JSON eine Zahl.
        return rows.map((row) => ({ ...row, positionNumber: row.positionNumber ?? null, taskCount: Number(row.taskCount) || 0 }));
    }
}

/** Texte kürzen, wie die Spalten sie fassen — ein langer Name bricht den Verlauf nicht. */
const clip = (value: string | null, max: number): string | null => (value ? value.slice(0, max) : null);

/**
 * ── DER VERLAUF JE STUFE (30.09.2026) ───────────────────────────────────────
 * `uretim_cihaz_gorev_aktiviteleri`: nur angehängt. Gelesen wird eine Stufe
 * samt den Zeilen ohne Bereich (das ganze Gerät), neueste zuerst.
 */
export class PrismaProductionTaskActivityLog implements IProductionTaskActivityLog {
    async record(entries: ProductionTaskActivityDraft[]): Promise<void> {
        if (!entries.length) return;
        // Dieselbe Millisekunde für alle Zeilen EINER Handlung — die Reihenfolge der Eingabe bleibt über die Kennung.
        const now = Date.now();
        await prisma.productionDeviceTaskActivity.createMany({
            data: entries.map((entry, index) => ({
                id: `${now.toString(36)}${String(index).padStart(3, '0')}${newId()}`,
                tenantId: entry.tenantId,
                productionItemId: entry.productionItemId,
                area: clip(entry.area, 16),
                stage: clip(entry.stage, 24),
                taskId: entry.taskId,
                taskCode: clip(entry.taskCode, 16),
                taskName: clip(entry.taskName, 200),
                subtaskId: clip(entry.subtaskId, 40),
                subtaskCode: clip(entry.subtaskCode, 24),
                subtaskName: clip(entry.subtaskName, 200),
                kind: entry.kind,
                actorId: entry.actorId,
                actorName: clip(entry.actorName, 160),
                details: entry.details === null ? Prisma.DbNull : (entry.details as Prisma.InputJsonValue),
                createdAt: new Date(now),
            })),
        });
    }

    async list(
        tenantId: string,
        itemId: string,
        place: { area: string; stage: string } | null,
        query: ProductionTaskActivityQuery,
    ): Promise<{ rows: ProductionTaskActivity[]; total: number }> {
        const where: Prisma.ProductionDeviceTaskActivityWhereInput = {
            tenantId,
            productionItemId: itemId,
            // Eine Stufe samt den Zeilen am ganzen Gerät — oder ohne Stufe: alles des Geräts.
            ...(place ? { OR: [{ area: place.area, stage: place.stage }, { area: null }] } : {}),
            ...(query.kinds ? { kind: { in: query.kinds } } : {}),
            ...(query.actorId ? { actorId: query.actorId } : {}),
            ...(query.from || query.to
                ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } }
                : {}),
        };
        // Seite und Summe gleichzeitig — ein Rundgang statt zwei.
        const [rows, total] = await Promise.all([
            prisma.productionDeviceTaskActivity.findMany({
                where,
                // Die Kennung hält die Reihenfolge EINER Handlung (dieselbe Millisekunde).
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: query.offset,
                take: query.limit,
            }),
            prisma.productionDeviceTaskActivity.count({ where }),
        ]);
        return { rows: rows.map((row) => ({
            id: row.id,
            tenantId: row.tenantId,
            productionItemId: row.productionItemId,
            area: row.area,
            stage: row.stage,
            taskId: row.taskId,
            taskCode: row.taskCode,
            taskName: row.taskName,
            subtaskId: row.subtaskId,
            subtaskCode: row.subtaskCode,
            subtaskName: row.subtaskName,
            kind: row.kind as ProductionTaskActivityKind,
            actorId: row.actorId,
            actorName: row.actorName,
            details: row.details && typeof row.details === 'object' && !Array.isArray(row.details)
                ? row.details as Record<string, unknown>
                : null,
            createdAt: row.createdAt,
        })), total };
    }

    async actors(tenantId: string, itemId: string, place: { area: string; stage: string } | null): Promise<Array<{ id: string; name: string }>> {
        const rows = await prisma.productionDeviceTaskActivity.findMany({
            where: {
                tenantId,
                productionItemId: itemId,
                ...(place ? { OR: [{ area: place.area, stage: place.stage }, { area: null }] } : {}),
                actorId: { not: null },
            },
            // Der jüngste Name gilt, falls jemand inzwischen anders heisst.
            orderBy: { createdAt: 'desc' },
            distinct: ['actorId'],
            select: { actorId: true, actorName: true },
        });
        return rows
            .map((row) => ({ id: row.actorId ?? '', name: row.actorName || '—' }))
            .sort((left, right) => left.name.localeCompare(right.name, 'tr'));
    }
}

type RequestRow = Awaited<ReturnType<typeof prisma.productionDeviceTaskRequest.findFirst>>;

const requestOf = (row: NonNullable<RequestRow>): ProductionTaskRequest => ({
    id: row.id,
    tenantId: row.tenantId,
    productionItemId: row.productionItemId,
    area: row.area,
    stage: row.stage,
    taskId: row.taskId,
    taskCode: row.taskCode,
    taskName: row.taskName,
    subtaskId: row.subtaskId,
    subtaskCode: row.subtaskCode,
    subtaskName: row.subtaskName,
    kind: row.kind as ProductionTaskRequestKind,
    note: row.note,
    requestedById: row.requestedById,
    requestedByName: row.requestedByName,
    createdAt: row.createdAt,
    solvedAt: row.solvedAt,
    solvedById: row.solvedById,
    solvedByName: row.solvedByName,
    resolution: (row.resolution as ProductionTaskRequestResolution | null) ?? null,
});

/**
 * ── ANFRAGEN AN DIE VERWALTUNG (30.09.2026) ─────────────────────────────────
 * `uretim_cihaz_gorev_talepleri`: Freigabe- und Entsperr-Anfragen je Unteraufgabe.
 */
export class PrismaProductionTaskRequestRepository implements IProductionTaskRequestRepository {
    async create(draft: ProductionTaskRequestDraft): Promise<ProductionTaskRequest> {
        const row = await prisma.productionDeviceTaskRequest.create({
            data: {
                id: newId(),
                ...draft,
                area: clip(draft.area, 16) ?? '',
                stage: clip(draft.stage, 24) ?? '',
                taskCode: clip(draft.taskCode, 16) ?? '',
                taskName: clip(draft.taskName, 200) ?? '',
                subtaskId: clip(draft.subtaskId, 40) ?? '',
                subtaskCode: clip(draft.subtaskCode, 24) ?? '',
                subtaskName: clip(draft.subtaskName, 200) ?? '',
                note: clip(draft.note, 500),
                requestedByName: clip(draft.requestedByName, 160),
            },
        });
        return requestOf(row);
    }

    async findOpen(tenantId: string, itemId: string, subtaskId: string, kind: ProductionTaskRequestKind): Promise<ProductionTaskRequest | null> {
        const row = await prisma.productionDeviceTaskRequest.findFirst({
            where: { tenantId, productionItemId: itemId, subtaskId, kind, solvedAt: null },
            orderBy: { createdAt: 'desc' },
        });
        return row ? requestOf(row) : null;
    }

    async list(tenantId: string, itemId: string, place: { area: string; stage: string } | null, status: 'open' | 'solved' | 'all'): Promise<ProductionTaskRequest[]> {
        const rows = await prisma.productionDeviceTaskRequest.findMany({
            where: {
                tenantId,
                productionItemId: itemId,
                ...(place ? { area: place.area, stage: place.stage } : {}),
                ...(status === 'open' ? { solvedAt: null } : status === 'solved' ? { solvedAt: { not: null } } : {}),
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 200,
        });
        return rows.map(requestOf);
    }

    async countOpen(tenantId: string, itemId: string, place: { area: string; stage: string } | null): Promise<number> {
        return prisma.productionDeviceTaskRequest.count({
            where: { tenantId, productionItemId: itemId, ...(place ? { area: place.area, stage: place.stage } : {}), solvedAt: null },
        });
    }

    async openByDevice(tenantId: string): Promise<Map<string, number>> {
        const groups = await prisma.productionDeviceTaskRequest.groupBy({
            by: ['productionItemId'],
            where: { tenantId, solvedAt: null },
            _count: { _all: true },
        });
        return new Map(groups.map((group) => [group.productionItemId, group._count._all]));
    }

    async solve(
        tenantId: string,
        itemId: string,
        id: string,
        by: { id: string; name: string | null },
        resolution: ProductionTaskRequestResolution,
    ): Promise<ProductionTaskRequest | null> {
        const updated = await prisma.productionDeviceTaskRequest.updateMany({
            where: { id, tenantId, productionItemId: itemId, solvedAt: null },
            data: { solvedAt: new Date(), solvedById: by.id, solvedByName: clip(by.name, 160), resolution },
        });
        if (!updated.count) return null;
        const row = await prisma.productionDeviceTaskRequest.findUnique({ where: { id } });
        return row ? requestOf(row) : null;
    }

    async solveOpenFor(
        tenantId: string,
        itemId: string,
        subtaskId: string,
        kinds: readonly ProductionTaskRequestKind[],
        by: { id: string; name: string | null },
        resolution: ProductionTaskRequestResolution,
    ): Promise<number> {
        const updated = await prisma.productionDeviceTaskRequest.updateMany({
            where: { tenantId, productionItemId: itemId, subtaskId, kind: { in: [...kinds] }, solvedAt: null },
            data: { solvedAt: new Date(), solvedById: by.id, solvedByName: clip(by.name, 160), resolution },
        });
        return updated.count;
    }
}
