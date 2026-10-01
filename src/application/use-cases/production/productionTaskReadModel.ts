import type {
    ProductionAreaShares,
    ProductionDeviceTaskPlan,
    ProductionSubtask,
    ProductionSubtaskFile,
    ProductionTaskArea,
    ProductionTaskDevice,
    ProductionTaskDraft,
    ProductionTaskPerson,
    ProductionTaskSection,
    ProductionTaskStage,
    ProductionTaskStatus,
    ProductionTaskTemplate,
    ProductionTaskTemplateSummary,
} from '../../../domain/entities/ProductionTask';
import { areaSharesOf, templateCheck, type ProductionTaskTemplateCheck } from '../../../domain/services/productionTasks';

/**
 * ── GÖREVLENDİRME · WAS DIE OBERFLÄCHE BEKOMMT ──────────────────────────────
 * Spiegel in offitec-frontend/src/types/productionTasks.ts.
 *
 * `sections` (28.09.2026) sind die Bereiche mit ihren Stufen; `areaShares`
 * (Kennung → Anteil) steht nur noch für Browser mit älterem Stand daneben.
 */

/** Eine Datei, wie die Oberfläche sie sieht — ohne Verweis in die Ablage. */
export type ProductionSubtaskFileDto = Omit<ProductionSubtaskFile, 'ref'>;
export type ProductionSubtaskDto = Omit<ProductionSubtask, 'files'> & { files: ProductionSubtaskFileDto[] };

export interface ProductionTaskDto {
    id: string;
    area: ProductionTaskArea;
    stage: ProductionTaskStage;
    code: string;
    name: string;
    weight: number;
    assigneeIds: string[];
    startDate: string | null;
    dueDate: string | null;
    /** Der Tag des Anlegens (am Gerät: des Ladens). */
    createdAt: string | null;
    /** Der Stand am Gerät; in der Vorlage immer TODO (der Anfang). */
    status: ProductionTaskStatus;
    subtasks: ProductionSubtaskDto[];
}

export interface ProductionTaskTemplateSummaryDto {
    id: string;
    name: string;
    sections: ProductionTaskSection[];
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
    sections: ProductionTaskSection[];
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
        sections: ProductionTaskSection[];
        areaShares: ProductionAreaShares;
        loadedAt: string;
        loadedByName: string | null;
    } | null;
    tasks: ProductionTaskDto[];
    people: ProductionTaskPerson[];
}

export const taskDto = (task: ProductionTaskDraft & { id: string; status?: ProductionTaskStatus }): ProductionTaskDto => ({
    id: task.id,
    area: task.area,
    stage: task.stage,
    code: task.code,
    name: task.name,
    weight: task.weight,
    assigneeIds: [...task.assigneeIds],
    startDate: task.startDate,
    dueDate: task.dueDate,
    createdAt: task.createdAt,
    status: task.status ?? 'TODO',
    subtasks: task.subtasks.map((subtask) => ({
        ...subtask,
        files: subtask.files.map(({ ref: _ref, ...file }) => file),
    })),
});

export const summaryDto = (row: ProductionTaskTemplateSummary): ProductionTaskTemplateSummaryDto => ({
    id: row.id,
    name: row.name,
    sections: row.sections,
    areaShares: areaSharesOf(row.sections),
    taskCount: row.taskCount,
    check: templateCheck(row.sections, row.weights),
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
    sections: template.sections,
    areaShares: areaSharesOf(template.sections),
    tasks: template.tasks.map(taskDto),
    people,
    check: templateCheck(template.sections, template.tasks),
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
        sections: plan.sections,
        areaShares: areaSharesOf(plan.sections),
        loadedAt: plan.createdAt.toISOString(),
        loadedByName,
    } : null,
    tasks: plan ? plan.tasks.map(taskDto) : [],
    people,
});

/** Alle Personen, die in diesen Aufgaben stehen — jede einmal. */
export const assigneesOf = (tasks: ReadonlyArray<{ assigneeIds: string[] }>): string[] =>
    [...new Set(tasks.flatMap((task) => task.assigneeIds))];
