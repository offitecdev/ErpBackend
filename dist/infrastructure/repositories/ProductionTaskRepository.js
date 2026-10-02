"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaProductionTaskRequestRepository = exports.PrismaProductionTaskActivityLog = exports.PrismaProductionTaskDirectory = exports.PrismaProductionDeviceTaskRepository = exports.PrismaProductionTaskTemplateRepository = void 0;
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
/* Beginn und Termin sind DATE-Spalten: Prisma liefert Mitternacht UTC —
   der Tag ist der Anfang der ISO-Zeit, geschrieben wird er genauso. */
const dayOf = (value) => (value ? value.toISOString().slice(0, 10) : null);
const dateOf = (day) => (day ? new Date(`${day}T00:00:00.000Z`) : null);
/* Eine Aufgabe liegt immer in einem Bereich und einer Stufe ihrer Vorlage —
   eine Stufe aus der Zeit vor den zwei Wegen (27.09.2026) am passenden Platz
   des Weges, sonst am Anfang, damit keine Aufgabe unsichtbar wird.
   `weight` ist das Gewicht in der Stufe (30.09.2026), aus `withWeights`. */
const draftOf = (row, sections, weight) => {
    const subtasks = (0, productionTasks_1.subtasksFrom)(row.subtasks);
    return {
        id: row.id,
        ...(0, productionTasks_1.placeTask)(sections, row.area, row.stage),
        code: row.code,
        name: row.name,
        weight,
        // Die Personen der Aufgabe sind die ihrer Unteraufgaben (29.09.2026). Die Spalte
        // `assigneeIds` hält nur noch diese Summe; früher an der Aufgabe gesetzte Personen fallen weg.
        assigneeIds: (0, productionTasks_1.taskAssigneesOf)(subtasks),
        startDate: dayOf(row.startDate),
        dueDate: dayOf(row.dueDate),
        createdAt: dayOf(row.createdAt),
        subtasks,
        sortOrder: row.sortOrder,
        customerVisible: row.customerVisible === true,
    };
};
/**
 * Die Bereiche samt Gewichten der Stufen und je Zeile das Gewicht der Aufgabe in ihrer Stufe
 * (30.09.2026) — gespeichert oder, bei Daten von vorher, aus den Anteilen am Bereich abgeleitet.
 */
const withWeights = (storedSections, areaShares, rows) => {
    const base = (0, productionTasks_1.sectionsFrom)(storedSections, areaShares);
    return (0, productionTasks_1.resolveTaskWeights)(base, (0, productionTasks_1.storedStageWeightsComplete)(storedSections), rows.map((row) => {
        const place = (0, productionTasks_1.placeTask)(base, row.area, row.stage);
        return {
            area: place.area,
            stage: place.stage,
            sectionShare: Number(row.weight) || 0,
            stageWeight: row.stageWeight === null || row.stageWeight === undefined ? null : Number(row.stageWeight),
        };
    }));
};
/** Was eine Aufgabe in die Zeile schreibt: Gewicht in der Stufe und — für ältere Stände — Anteil am Bereich. */
const weightColumns = (sections, task) => ({
    weight: (0, productionTasks_1.sectionShareOf)((0, productionTasks_1.stageWeightIn)(sections, task.area, task.stage), task.weight),
    stageWeight: task.weight,
});
const templateOf = (row, taskRows) => {
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
            .map((task, index) => draftOf(task, sections, weights[index] ?? 0))
            .sort((left, right) => left.sortOrder - right.sortOrder),
    };
};
/** Bereiche und Anteile, wie sie in die Zeile einer Vorlage oder eines Plans gehen. */
const sectionColumns = (sections) => ({
    areaShares: (0, productionTasks_1.areaSharesOf)(sections),
    sections: sections,
});
/** Die Aufgaben einer Vorlage als Zeilen — die Reihenfolge der Eingabe bleibt. */
const templateTaskRows = (tenantId, templateId, tasks, sections) => tasks.map((task, index) => ({
    id: newId(),
    tenantId,
    templateId,
    area: task.area,
    stage: task.stage,
    code: task.code,
    name: task.name,
    ...weightColumns(sections, task),
    assigneeIds: task.assigneeIds,
    subtasks: task.subtasks,
    startDate: dateOf(task.startDate),
    dueDate: dateOf(task.dueDate),
    // Das Beispiel kommt ohne Tag: es entsteht heute.
    createdAt: dateOf(task.createdAt ?? new Date().toISOString().slice(0, 10)),
    sortOrder: index,
    customerVisible: task.customerVisible === true,
}));
/** Die eben geschriebenen Zeilen wieder als Aufgaben — ohne neuen Rundgang. */
const writtenRows = (rows) => rows.map((row) => ({ ...row, assigneeIds: row.assigneeIds, subtasks: row.subtasks }));
class PrismaProductionTaskTemplateRepository {
    async countEver(tenantId) {
        return prisma_client_1.default.productionTaskTemplate.count({ where: { tenantId } });
    }
    async list(tenantId) {
        const [templates, taskRows, planGroups] = await Promise.all([
            prisma_client_1.default.productionTaskTemplate.findMany({
                where: { tenantId, deletedAt: null },
                select: { id: true, name: true, areaShares: true, sections: true, exampleKey: true, updatedAt: true },
                orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
            }),
            prisma_client_1.default.productionTaskTemplateTask.findMany({
                where: { tenantId },
                select: { templateId: true, area: true, stage: true, weight: true, stageWeight: true },
            }),
            prisma_client_1.default.productionDeviceTaskPlan.groupBy({
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
                weights: own.map((row, index) => ({ ...(0, productionTasks_1.placeTask)(sections, row.area, row.stage), weight: weights[index] ?? 0 })),
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
        return template ? templateOf(template, tasks) : null;
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
        const rows = templateTaskRows(tenantId, id, input.tasks, input.sections);
        const created = await prisma_client_1.default.$transaction(async (tx) => {
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
            if (rows.length)
                await tx.productionTaskTemplateTask.createMany({ data: rows });
            return template;
        });
        return templateOf(created, writtenRows(rows));
    }
    async replace(tenantId, id, actorId, input) {
        const rows = templateTaskRows(tenantId, id, input.tasks, input.sections);
        const saved = await prisma_client_1.default.$transaction(async (tx) => {
            const updated = await tx.productionTaskTemplate.updateMany({
                where: { id, tenantId, deletedAt: null },
                data: {
                    name: input.name,
                    ...sectionColumns(input.sections),
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
        return saved ? templateOf(saved, writtenRows(rows)) : null;
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
const deviceTaskOf = (row, sections, weight) => ({
    ...draftOf(row, sections, weight),
    planId: row.planId,
    status: (0, productionTasks_1.statusFrom)(row.status),
    updatedById: row.updatedById,
    updatedAt: row.updatedAt,
});
const planOf = (plan, taskRows) => {
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
        // Ein gleichzeitiges Ersetzen könnte Aufgaben des alten Plans zeigen.
        return planOf(plan, tasks.filter((task) => task.planId === plan.id));
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
            ...weightColumns(write.sections, task),
            assigneeIds: task.assigneeIds,
            subtasks: task.subtasks,
            startDate: dateOf(task.startDate),
            dueDate: dateOf(task.dueDate),
            status: 'TODO',
            sortOrder: index,
            customerVisible: task.customerVisible === true,
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
                    ...sectionColumns(write.sections),
                    loadedById: write.actorId,
                },
            });
            if (rows.length)
                await tx.productionDeviceTask.createMany({ data: rows });
            return created;
        });
        return planOf(plan, writtenRows(rows).map((row) => ({ ...row, createdAt: now, updatedAt: now })));
    }
    async setSections(tenantId, itemId, sections) {
        const updated = await prisma_client_1.default.productionDeviceTaskPlan.updateMany({
            where: { tenantId, productionItemId: itemId },
            // Nur Bereiche und Stufen — die Aufgaben (Stand, Dateien) fasst das nicht an.
            data: { ...sectionColumns(sections), updatedAt: new Date() },
        });
        return updated.count ? this.getPlan(tenantId, itemId) : null;
    }
    async replaceTasks(tenantId, itemId, tasks, actorId, sections) {
        const saved = await prisma_client_1.default.$transaction(async (tx) => {
            const plan = await tx.productionDeviceTaskPlan.findUnique({
                where: { tenantId_productionItemId: { tenantId, productionItemId: itemId } },
            });
            if (!plan)
                return null;
            const before = await tx.productionDeviceTask.findMany({ where: { planId: plan.id } });
            const known = new Map(before.map((row) => [row.id, row]));
            const now = new Date();
            const used = new Set();
            const rows = tasks.map((task, index) => {
                // Eine bekannte Aufgabe behält Kennung, Stand und Zeitpunkt des Anlegens.
                const previous = task.id && !used.has(task.id) ? known.get(task.id) : undefined;
                const id = previous ? previous.id : newId();
                used.add(id);
                // Stand, Dateien und Abschluss einer Unteraufgabe gehören dem Server:
                // die Anpassung ändert Name, Gewicht und Tage, nie diese (28.09.2026) —
                // ausser eine Pflicht kommt dazu: dann beginnt sie offen von vorn (mergeDeviceRecord).
                const earlier = new Map(previous ? (0, productionTasks_1.subtasksFrom)(previous.subtasks).map((entry) => [entry.id, entry]) : []);
                const subtasks = task.subtasks.map((subtask) => {
                    const kept = earlier.get(subtask.id);
                    return kept ? (0, productionTasks_1.mergeDeviceRecord)(subtask, kept) : (0, productionTasks_1.withoutDeviceRecord)(subtask);
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
                    assigneeIds: task.assigneeIds,
                    subtasks: subtasks,
                    startDate: dateOf(task.startDate),
                    dueDate: dateOf(task.dueDate),
                    // Mit Unteraufgaben folgt der Stand ihnen; sonst bleibt er, wie er war.
                    status: (0, productionTasks_1.statusOfSubtasks)(subtasks) ?? previous?.status ?? 'TODO',
                    createdAt: previous?.createdAt ?? now,
                    sortOrder: index,
                    customerVisible: task.customerVisible === true,
                    updatedById: actorId,
                };
            });
            await tx.productionDeviceTask.deleteMany({ where: { planId: plan.id } });
            if (rows.length)
                await tx.productionDeviceTask.createMany({ data: rows });
            // Die Gewichte der Stufen (30.09.2026) gehen mit — im selben Vorgang wie die Aufgaben.
            const updated = await tx.productionDeviceTaskPlan.update({ where: { id: plan.id }, data: { updatedAt: now, ...sectionColumns(sections) } });
            return { plan: updated, rows: writtenRows(rows).map((row) => ({ ...row, updatedAt: now })) };
        });
        return saved ? planOf(saved.plan, saved.rows) : null;
    }
    async sectionsOfPlan(tenantId, itemId) {
        const plan = await prisma_client_1.default.productionDeviceTaskPlan.findUnique({
            where: { tenantId_productionItemId: { tenantId, productionItemId: itemId } },
            select: { areaShares: true, sections: true },
        });
        return plan ? (0, productionTasks_1.sectionsFrom)(plan.sections, plan.areaShares) : [];
    }
    async getTask(tenantId, itemId, taskId) {
        // Das Gewicht in der Stufe kann von den übrigen Aufgaben abhängen (Daten von vorher) — darum der ganze Plan.
        const plan = await this.getPlan(tenantId, itemId);
        return plan?.tasks.find((task) => task.id === taskId) ?? null;
    }
    async setStatus(tenantId, itemId, taskId, status, actorId) {
        const result = await prisma_client_1.default.productionDeviceTask.updateMany({
            where: { id: taskId, tenantId, productionItemId: itemId },
            data: { status, updatedById: actorId },
        });
        return result.count ? this.getTask(tenantId, itemId, taskId) : null;
    }
    async changeSubtask(tenantId, itemId, taskId, subtaskId, change, actorId) {
        const sections = await this.sectionsOfPlan(tenantId, itemId);
        const outcome = await prisma_client_1.default.$transaction(async (tx) => {
            // Die Zeile sperren: zwei gleichzeitige Änderungen (Datei, Stand) überschreiben einander nicht.
            await tx.$queryRaw `SELECT id FROM uretim_cihaz_gorevleri WHERE id = ${taskId} FOR UPDATE`;
            const row = await tx.productionDeviceTask.findFirst({ where: { id: taskId, tenantId, productionItemId: itemId } });
            if (!row)
                return null;
            const subtasks = (0, productionTasks_1.subtasksFrom)(row.subtasks);
            const current = subtasks.find((subtask) => subtask.id === subtaskId);
            if (!current)
                return 'no-subtask';
            // Der Rückruf braucht die Aufgabe nur zum Lesen von Stand und Personen — das Gewicht zählt hier nicht.
            // Die Arbeitszeit folgt dem Stand — bei jeder Änderung, wer sie auch macht (02.10.2026).
            const changed = (0, productionTasks_1.withWorkClock)(current, change(current, deviceTaskOf(row, sections, Number(row.stageWeight ?? 0))), new Date());
            const next = subtasks.map((subtask) => (subtask.id === subtaskId ? changed : subtask));
            await tx.productionDeviceTask.update({
                where: { id: row.id },
                data: {
                    subtasks: next,
                    // Die Aufgabe folgt ihren Unteraufgaben — im Stand wie in den Personen.
                    status: (0, productionTasks_1.statusOfSubtasks)(next) ?? row.status,
                    assigneeIds: (0, productionTasks_1.taskAssigneesOf)(next),
                    updatedById: actorId,
                },
            });
            return 'ok';
        });
        if (outcome !== 'ok')
            return outcome;
        return this.getTask(tenantId, itemId, taskId);
    }
    async deletePlan(tenantId, itemId) {
        const result = await prisma_client_1.default.productionDeviceTaskPlan.deleteMany({ where: { tenantId, productionItemId: itemId } });
        return result.count > 0;
    }
    async itemIdsForAssignee(tenantId, employeeId) {
        // `assigneeIds` hält die Personen aller Unteraufgaben der Aufgabe (JSON-Liste) — EIN Rundgang.
        const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT DISTINCT productionItemId
              FROM uretim_cihaz_gorevleri
             WHERE tenantId = ${tenantId}
               AND JSON_CONTAINS(assigneeIds, JSON_QUOTE(${employeeId}))`);
        return rows.map((row) => row.productionItemId);
    }
    async itemIdsWithPendingSubtasks(tenantId) {
        // Der Stand jeder Unteraufgabe steht in der JSON-Liste `subtasks` — EIN Rundgang.
        const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT DISTINCT productionItemId
              FROM uretim_cihaz_gorevleri
             WHERE tenantId = ${tenantId}
               AND JSON_SEARCH(subtasks, 'one', 'PENDING', NULL, '$[*].status') IS NOT NULL`);
        return rows.map((row) => row.productionItemId);
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
    async taskDevices(tenantId) {
        // Die Geräte mit Aufgaben und ihre Projekte in EINER Abfrage (ein Rundgang).
        const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
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
exports.PrismaProductionTaskDirectory = PrismaProductionTaskDirectory;
/** Texte kürzen, wie die Spalten sie fassen — ein langer Name bricht den Verlauf nicht. */
const clip = (value, max) => (value ? value.slice(0, max) : null);
/**
 * ── DER VERLAUF JE STUFE (30.09.2026) ───────────────────────────────────────
 * `uretim_cihaz_gorev_aktiviteleri`: nur angehängt. Gelesen wird eine Stufe
 * samt den Zeilen ohne Bereich (das ganze Gerät), neueste zuerst.
 */
class PrismaProductionTaskActivityLog {
    async record(entries) {
        if (!entries.length)
            return;
        // Dieselbe Millisekunde für alle Zeilen EINER Handlung — die Reihenfolge der Eingabe bleibt über die Kennung.
        const now = Date.now();
        await prisma_client_1.default.productionDeviceTaskActivity.createMany({
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
                details: entry.details === null ? client_1.Prisma.DbNull : entry.details,
                createdAt: new Date(now),
            })),
        });
    }
    async list(tenantId, itemId, place, query) {
        const where = {
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
            prisma_client_1.default.productionDeviceTaskActivity.findMany({
                where,
                // Die Kennung hält die Reihenfolge EINER Handlung (dieselbe Millisekunde).
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: query.offset,
                take: query.limit,
            }),
            prisma_client_1.default.productionDeviceTaskActivity.count({ where }),
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
                kind: row.kind,
                actorId: row.actorId,
                actorName: row.actorName,
                details: row.details && typeof row.details === 'object' && !Array.isArray(row.details)
                    ? row.details
                    : null,
                createdAt: row.createdAt,
            })), total };
    }
    async actors(tenantId, itemId, place) {
        const rows = await prisma_client_1.default.productionDeviceTaskActivity.findMany({
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
exports.PrismaProductionTaskActivityLog = PrismaProductionTaskActivityLog;
const requestOf = (row) => ({
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
    kind: row.kind,
    note: row.note,
    requestedById: row.requestedById,
    requestedByName: row.requestedByName,
    createdAt: row.createdAt,
    solvedAt: row.solvedAt,
    solvedById: row.solvedById,
    solvedByName: row.solvedByName,
    resolution: row.resolution ?? null,
});
/**
 * ── ANFRAGEN AN DIE VERWALTUNG (30.09.2026) ─────────────────────────────────
 * `uretim_cihaz_gorev_talepleri`: Freigabe- und Entsperr-Anfragen je Unteraufgabe.
 */
class PrismaProductionTaskRequestRepository {
    async create(draft) {
        const row = await prisma_client_1.default.productionDeviceTaskRequest.create({
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
    async findOpen(tenantId, itemId, subtaskId, kind) {
        const row = await prisma_client_1.default.productionDeviceTaskRequest.findFirst({
            where: { tenantId, productionItemId: itemId, subtaskId, kind, solvedAt: null },
            orderBy: { createdAt: 'desc' },
        });
        return row ? requestOf(row) : null;
    }
    async list(tenantId, itemId, place, status) {
        const rows = await prisma_client_1.default.productionDeviceTaskRequest.findMany({
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
    async countOpen(tenantId, itemId, place) {
        return prisma_client_1.default.productionDeviceTaskRequest.count({
            where: { tenantId, productionItemId: itemId, ...(place ? { area: place.area, stage: place.stage } : {}), solvedAt: null },
        });
    }
    async openByDevice(tenantId) {
        const groups = await prisma_client_1.default.productionDeviceTaskRequest.groupBy({
            by: ['productionItemId'],
            where: { tenantId, solvedAt: null },
            _count: { _all: true },
        });
        return new Map(groups.map((group) => [group.productionItemId, group._count._all]));
    }
    async solve(tenantId, itemId, id, by, resolution) {
        const updated = await prisma_client_1.default.productionDeviceTaskRequest.updateMany({
            where: { id, tenantId, productionItemId: itemId, solvedAt: null },
            data: { solvedAt: new Date(), solvedById: by.id, solvedByName: clip(by.name, 160), resolution },
        });
        if (!updated.count)
            return null;
        const row = await prisma_client_1.default.productionDeviceTaskRequest.findUnique({ where: { id } });
        return row ? requestOf(row) : null;
    }
    async solveOpenFor(tenantId, itemId, subtaskId, kinds, by, resolution) {
        const updated = await prisma_client_1.default.productionDeviceTaskRequest.updateMany({
            where: { tenantId, productionItemId: itemId, subtaskId, kind: { in: [...kinds] }, solvedAt: null },
            data: { solvedAt: new Date(), solvedById: by.id, solvedByName: clip(by.name, 160), resolution },
        });
        return updated.count;
    }
}
exports.PrismaProductionTaskRequestRepository = PrismaProductionTaskRequestRepository;
//# sourceMappingURL=ProductionTaskRepository.js.map