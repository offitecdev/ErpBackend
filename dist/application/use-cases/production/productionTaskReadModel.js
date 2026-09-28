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
});
exports.taskDto = taskDto;
const summaryDto = (row) => ({
    id: row.id,
    name: row.name,
    areaShares: row.areaShares,
    taskCount: row.taskCount,
    check: (0, productionTasks_1.templateCheck)(row.areaShares, row.areas),
    usedBy: row.usedBy,
    isExample: Boolean(row.exampleKey),
    updatedAt: row.updatedAt.toISOString(),
});
exports.summaryDto = summaryDto;
const templateDto = (template, people, updatedByName) => ({
    id: template.id,
    name: template.name,
    areaShares: template.areaShares,
    tasks: template.tasks.map(exports.taskDto),
    people,
    check: (0, productionTasks_1.templateCheck)(template.areaShares, (0, productionTasks_1.areaTotals)(template.tasks)),
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
        areaShares: plan.areaShares,
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