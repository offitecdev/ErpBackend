"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assigneesOf = exports.deviceTasksDto = exports.templateDto = exports.summaryDto = exports.taskDto = void 0;
const productionTasks_1 = require("../../../domain/services/productionTasks");
const taskDto = (task) => ({
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
    customerVisible: task.customerVisible === true,
    subtasks: task.subtasks.map((subtask) => ({
        ...subtask,
        // Eine liegengebliebene KI-Prüfung (01.10.2026) zeigt sich als gescheitert, «unterbrochen».
        files: subtask.files.map(({ ref: _ref, ...file }) => ({ ...file, analysis: (0, productionTasks_1.analysisAsSeen)(file.analysis) })),
    })),
});
exports.taskDto = taskDto;
const summaryDto = (row) => ({
    id: row.id,
    name: row.name,
    sections: row.sections,
    areaShares: (0, productionTasks_1.areaSharesOf)(row.sections),
    taskCount: row.taskCount,
    check: (0, productionTasks_1.templateCheck)(row.sections, row.weights),
    usedBy: row.usedBy,
    isExample: Boolean(row.exampleKey),
    updatedAt: row.updatedAt.toISOString(),
});
exports.summaryDto = summaryDto;
const templateDto = (template, people, updatedByName) => ({
    id: template.id,
    name: template.name,
    sections: template.sections,
    areaShares: (0, productionTasks_1.areaSharesOf)(template.sections),
    tasks: template.tasks.map(exports.taskDto),
    people,
    check: (0, productionTasks_1.templateCheck)(template.sections, template.tasks),
    isExample: Boolean(template.exampleKey),
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
    updatedByName,
});
exports.templateDto = templateDto;
const deviceTasksDto = (device, plan, people, loadedByName) => ({
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
        areaShares: (0, productionTasks_1.areaSharesOf)(plan.sections),
        loadedAt: plan.createdAt.toISOString(),
        loadedByName,
    } : null,
    tasks: plan ? plan.tasks.map(exports.taskDto) : [],
    people,
});
exports.deviceTasksDto = deviceTasksDto;
/** Alle Personen, die in diesen Aufgaben stehen — jede einmal. */
const assigneesOf = (tasks) => [...new Set(tasks.flatMap((task) => task.assigneeIds))];
exports.assigneesOf = assigneesOf;
//# sourceMappingURL=productionTaskReadModel.js.map