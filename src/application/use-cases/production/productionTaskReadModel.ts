import type {
    ProductionAreaShares,
    ProductionDeviceTaskPlan,
    ProductionTaskArea,
    ProductionTaskDevice,
    ProductionTaskDraft,
    ProductionTaskPerson,
    ProductionTaskStage,
    ProductionTaskTemplate,
    ProductionTaskTemplateSummary,
} from '../../../domain/entities/ProductionTask';
import { areaTotals, templateCheck, type ProductionTaskTemplateCheck } from '../../../domain/services/productionTasks';

/**
 * ── GÖREVLENDİRME · WAS DIE OBERFLÄCHE BEKOMMT ──────────────────────────────
 * Spiegel in offitec-frontend/src/types/productionTasks.ts.
 */

export interface ProductionTaskDto {
    id: string;
    area: ProductionTaskArea;
    stage: ProductionTaskStage;
    code: string;
    name: string;
    weight: number;
    assigneeIds: string[];
}

export interface ProductionTaskTemplateSummaryDto {
    id: string;
    name: string;
    areaShares: ProductionAreaShares;
    taskCount: number;
    check: ProductionTaskTemplateCheck;
    usedBy: number;
    isExample: boolean;
    updatedAt: string;
}

export interface ProductionTaskTemplateDto {
    id: string;
    name: string;
    areaShares: ProductionAreaShares;
    tasks: ProductionTaskDto[];
    people: ProductionTaskPerson[];
    check: ProductionTaskTemplateCheck;
    isExample: boolean;
    createdAt: string;
    updatedAt: string;
    updatedByName: string | null;
}

export interface ProductionDeviceTasksDto {
    device: {
        id: string;
        projectId: string;
        name: string;
        positionNumber: string | null;
        projectNumber: string;
        projectName: string;
    };
    plan: {
        id: string;
        templateId: string | null;
        templateName: string;
        areaShares: ProductionAreaShares;
        loadedAt: string;
        loadedByName: string | null;
    } | null;
    tasks: ProductionTaskDto[];
    people: ProductionTaskPerson[];
}

export const taskDto = (task: ProductionTaskDraft & { id: string }): ProductionTaskDto => ({
    id: task.id,
    area: task.area,
    stage: task.stage,
    code: task.code,
    name: task.name,
    weight: task.weight,
    assigneeIds: [...task.assigneeIds],
});

export const summaryDto = (row: ProductionTaskTemplateSummary): ProductionTaskTemplateSummaryDto => ({
    id: row.id,
    name: row.name,
    areaShares: row.areaShares,
    taskCount: row.taskCount,
    check: templateCheck(row.areaShares, row.areas),
    usedBy: row.usedBy,
    isExample: Boolean(row.exampleKey),
    updatedAt: row.updatedAt.toISOString(),
});

export const templateDto = (
    template: ProductionTaskTemplate,
    people: ProductionTaskPerson[],
    updatedByName: string | null,
): ProductionTaskTemplateDto => ({
    id: template.id,
    name: template.name,
    areaShares: template.areaShares,
    tasks: template.tasks.map(taskDto),
    people,
    check: templateCheck(template.areaShares, areaTotals(template.tasks)),
    isExample: Boolean(template.exampleKey),
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
    updatedByName,
});

export const deviceTasksDto = (
    device: ProductionTaskDevice,
    plan: ProductionDeviceTaskPlan | null,
    people: ProductionTaskPerson[],
    loadedByName: string | null,
): ProductionDeviceTasksDto => ({
    device: {
        id: device.id,
        projectId: device.productionProjectId,
        name: device.name,
        positionNumber: device.positionNumber,
        projectNumber: device.projectNumber,
        projectName: device.projectName,
    },
    plan: plan ? {
        id: plan.id,
        templateId: plan.templateId,
        templateName: plan.templateName,
        areaShares: plan.areaShares,
        loadedAt: plan.createdAt.toISOString(),
        loadedByName,
    } : null,
    tasks: plan ? plan.tasks.map(taskDto) : [],
    people,
});

/** Alle Personen, die in diesen Aufgaben stehen — jede einmal. */
export const assigneesOf = (tasks: ReadonlyArray<{ assigneeIds: string[] }>): string[] =>
    [...new Set(tasks.flatMap((task) => task.assigneeIds))];
