"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.moveTask = exports.setTaskLabels = exports.setTaskAssignees = exports.completeTask = exports.blockTask = exports.setTaskStatus = exports.duplicateTask = exports.addTaskPartner = exports.rejectTaskDeletion = exports.cancelTaskDeletionRequest = exports.requestTaskDeletion = exports.deleteTask = exports.updateTask = exports.createTask = void 0;
const client_1 = require("@prisma/client");
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const AuditLogService_1 = require("../../../infrastructure/services/AuditLogService");
const taskAssignMailService_1 = require("../../../infrastructure/services/tasks/taskAssignMailService");
const taskActor_1 = require("./taskActor");
const taskActivity_1 = require("./taskActivity");
const taskConstants_1 = require("./taskConstants");
const taskAccess_1 = require("./taskAccess");
const taskDb_1 = require("./taskDb");
const taskErrors_1 = require("./taskErrors");
const taskFiles_1 = require("./taskFiles");
const taskNotify_1 = require("./taskNotify");
const taskParts_1 = require("./taskParts");
const taskPeople_1 = require("./taskPeople");
const taskQueries_1 = require("./taskQueries");
const taskRows_1 = require("./taskRows");
const taskTimer_1 = require("./taskTimer");
/**
 * Meldungen gehen erst NACH dem Commit raus und halten die Antwort nicht auf:
 * Name der handelnden Person und Leitung werden im Hintergrund gelesen (die
 * Leitung aus demselben 30-s-Speicher, den taskNotify ohnehin braucht).
 */
const notifyAfterWrite = (actor, taskId, build) => {
    void Promise.all([(0, taskPeople_1.loadPersonName)(actor.employeeId), (0, taskPeople_1.getTasksManagerIds)(actor.tenantId), (0, taskPeople_1.getTasksAdminIds)(actor.tenantId)])
        .then(([actorName, managerIds, adminIds]) => {
        for (const notice of build({ actor: actorName, managerIds, adminIds })) {
            (0, taskNotify_1.queueTaskNotification)({
                ...notice,
                tenantId: actor.tenantId,
                actorId: actor.employeeId,
                linkUrl: (0, taskConstants_1.taskLinkUrl)(taskId),
                meta: { taskId },
            });
        }
    })
        .catch((error) => {
        console.warn(`[tasks.notify] Meldung zur Aufgabe ${taskId} nicht vorbereitet`, error);
    });
};
const assignedNotice = (context, title, recipientIds) => ({
    type: taskConstants_1.NOTIFY.ASSIGNED,
    recipientIds,
    title: 'Neue Aufgabe',
    message: `${context.actor} hat Ihnen «${title}» zugewiesen.`,
    params: { actor: context.actor, title },
});
/**
 * EINE ZUTEILUNG, ZWEI WEGE (16.09.2026, Samet: «görev atanınca … size görev
 * atandı olarak mail gidecek»). Die Meldung im OCC erreicht nur, wer gerade
 * angemeldet ist; die Karte per Mail reist mit und liegt am Morgen im
 * Posteingang. Beide gehen an dieselben Personen — nie an die handelnde.
 * Jeder Weg, auf dem jemand NEU verantwortlich wird, ruft das hier auf.
 */
const announceAssignment = (actor, taskId, title, recipientIds) => {
    if (!recipientIds.length)
        return;
    notifyAfterWrite(actor, taskId, (context) => [assignedNotice(context, title, recipientIds)]);
    (0, taskAssignMailService_1.queueTaskAssignmentMail)({
        tenantId: actor.tenantId,
        taskId,
        actorId: actor.employeeId,
        employeeIds: recipientIds,
    });
};
/**
 * Erledigt (16.09.2026). Niemand muss den Abschluss mehr freigeben — damit ihn
 * trotzdem jemand MITBEKOMMT, geht die Meldung an die Administratorrolle und an
 * die Person, welche die Aufgabe angelegt hat. Die handelnde Person filtert
 * `notifyTaskPeople` selbst heraus.
 */
const completedNotice = (context, task) => ({
    type: taskConstants_1.NOTIFY.COMPLETION_APPROVED,
    recipientIds: [...context.adminIds, task.createdById],
    title: 'Aufgabe abgeschlossen',
    message: `${context.actor} hat «${task.title}» abgeschlossen.`,
    params: { actor: context.actor, title: task.title },
});
/** Löschanfragen gehen an die Admins — nicht an die ganze Leitung. */
const notifyAdminsAfterWrite = (actor, taskId, build) => {
    void Promise.all([(0, taskPeople_1.loadPersonName)(actor.employeeId), (0, taskPeople_1.getTasksAdminIds)(actor.tenantId)])
        .then(([actorName, adminIds]) => {
        (0, taskNotify_1.queueTaskNotification)({
            ...build(actorName, adminIds),
            tenantId: actor.tenantId,
            actorId: actor.employeeId,
            linkUrl: (0, taskConstants_1.taskLinkUrl)(taskId),
            meta: { taskId },
        });
    })
        .catch((error) => {
        console.warn(`[tasks.notify] Löschanfrage zur Aufgabe ${taskId} nicht vorbereitet`, error);
    });
};
/* ── Prüfungen und kleine Bausteine ─────────────────────────────────────── */
const assertDueAfterStart = (startAt, dueAt) => {
    if (startAt && dueAt && dueAt.getTime() < startAt.getTime()) {
        throw (0, taskErrors_1.taskBadRequest)('DUE_BEFORE_START', 'Das Ende liegt vor dem Anfang.');
    }
};
const requireReason = (reason) => {
    if (!reason)
        throw (0, taskErrors_1.taskBadRequest)('REASON_REQUIRED', 'Bitte angeben, warum die Aufgabe nicht machbar ist.');
};
const editForbidden = () => (0, taskErrors_1.taskForbidden)('TASK_EDIT_FORBIDDEN', 'Diese Aufgabe dürfen Sie nicht bearbeiten.');
/** Etiketten müssen der ausgewählten Firma gehören. */
const requireTenantLabels = async (db, tenantId, labelIds) => {
    const wanted = [...new Set(labelIds)];
    if (!wanted.length)
        return [];
    const rows = await db.taskLabel.findMany({ where: { tenantId, id: { in: wanted } }, select: { id: true } });
    const known = new Set(rows.map((row) => row.id));
    const missing = wanted.filter((id) => !known.has(id));
    if (missing.length) {
        throw (0, taskErrors_1.taskBadRequest)('LABEL_NOT_FOUND', 'Dieses Etikett gibt es in der ausgewählten Firma nicht.', { labelIds: missing });
    }
    return wanted;
};
/*
 * Verantwortliche und Etiketten bekommen createdAt in Eingangsreihenfolge
 * (+1 ms je Zeile): die Zeilen sortieren danach, und bei derselben
 * Millisekunde entschiede der Zufall der Kennung. Die erste verantwortliche
 * Person bekommt auch die Checklisten-Erinnerungen ohne eigene Zuweisung.
 */
const addAssignees = async (tx, tenantId, taskId, employeeIds) => {
    if (!employeeIds.length)
        return;
    const base = Date.now();
    await tx.taskAssignee.createMany({
        data: employeeIds.map((employeeId, index) => ({
            id: (0, nanoid_1.nanoid)(12), tenantId, taskId, employeeId, createdAt: new Date(base + index),
        })),
    });
};
const addLabelLinks = async (tx, tenantId, taskId, labelIds) => {
    if (!labelIds.length)
        return;
    const base = Date.now();
    await tx.taskLabelLink.createMany({
        data: labelIds.map((labelId, index) => ({
            id: (0, nanoid_1.nanoid)(12), tenantId, taskId, labelId, createdAt: new Date(base + index),
        })),
    });
};
/** Neue Karten stehen oben auf der Pano: kleinste Position der Firma minus ein Schritt. */
const topBoardPosition = async (tenantId) => {
    const { _min } = await prisma_client_1.default.task.aggregate({ where: { tenantId }, _min: { boardPosition: true } });
    return _min.boardPosition === null ? 0 : _min.boardPosition - taskConstants_1.BOARD_POSITION_STEP;
};
/** Anfang jedes Wechsels: Zeile sperren, gesperrten Stand laden, Sichtbarkeit prüfen. */
const withLockedTask = (actor, taskId, work) => (0, taskDb_1.runTasksTransaction)(async (tx) => {
    if (!(await (0, taskRows_1.lockTaskRow)(tx, actor.tenantId, taskId)))
        throw (0, taskErrors_1.taskNotFound)();
    return work(tx, await (0, taskRows_1.requireVisibleTask)(tx, actor, taskId));
});
/** Führt einen Plan auf der gesperrten Aufgabe aus; liefert die beendeten Messungen. */
const applyPlan = async (tx, actor, taskId, plan, extra = {}) => {
    const closed = plan.closeSessions
        ? await (0, taskTimer_1.closeRunningSessionsOnTask)(tx, actor.tenantId, taskId, actor.employeeId, plan.closeSessions.note, plan.closeSessions.employeeIds)
        : [];
    await tx.task.updateMany({ where: { id: taskId, tenantId: actor.tenantId }, data: { ...plan.data, ...extra } });
    await (0, taskActivity_1.logTaskActivity)(tx, actor.tenantId, actor.employeeId, { taskId, ...plan.activity });
    return closed;
};
/** Görevly: wer schon gemessen hat, arbeitet daran — sonst ist sie nicht begonnen. */
const resumedStatus = (task) => task.sessionCount > 0 ? 'IN_PROGRESS' : 'NOT_STARTED';
const statusActivity = (from, to) => ({ type: taskConstants_1.ACTIVITY.STATUS, meta: { from, to } });
/** Status von Hand (Menü «Durum», Spalte der Pano); null = nichts zu tun. */
const planManualStatus = (task, target, reason, now) => {
    if (target === 'BLOCKED') {
        if (task.status === 'BLOCKED' && task.blockReason === reason)
            return null;
        // Laufende Messungen laufen weiter (Görevly setBlockReason).
        return { data: { status: 'BLOCKED', blockReason: reason }, activity: { type: taskConstants_1.ACTIVITY.BLOCKED, meta: { reason } } };
    }
    if (task.status === target)
        return null;
    if (target === 'COMPLETED') {
        return {
            closeSessions: { note: 'TASK_COMPLETED' },
            data: { status: 'COMPLETED', completedAt: now, blockReason: null },
            activity: statusActivity(task.status, target),
        };
    }
    return {
        data: { status: target, blockReason: null, completedAt: null },
        activity: statusActivity(task.status, target),
    };
};
/** Blockade aufheben: weiter, wo sie stand. null = sie war nicht blockiert (nichts wieder öffnen). */
const planUnblock = (task) => {
    if (task.status !== 'BLOCKED')
        return null;
    const to = resumedStatus(task);
    return { data: { status: to, blockReason: null }, activity: statusActivity(task.status, to) };
};
/** Jeder Weg, der eine Aufgabe schliesst, meldet sich bei Leitung und Anlegenden. */
const notifyIfCompleted = (actor, task, plan) => {
    if (plan?.data.status !== 'COMPLETED')
        return;
    notifyAfterWrite(actor, task.id, (context) => [completedNotice(context, task)]);
};
/**
 * Jede Aufgabe ist sofort freigegeben — kein Görev-Talep, keine Ablehnung
 * (15.09.2026, Samet: «görev oluşturma talebini kaldır, direkt oluşturulsun»).
 * Wer anlegt, ist immer selbst verantwortlich; nur die Administratorrolle
 * weist weitere Personen zu.
 */
const createTask = async (actor, input) => {
    const now = new Date();
    const startAt = input.startAt ?? now;
    const dueAt = input.dueAt ?? null;
    assertDueAfterStart(startAt, dueAt);
    // Wer anlegt, ist immer auch verantwortlich — die Leitung eingeschlossen (14.09.2026,
    // Samet: «biri görev eklediğinde kendi de otomatik eklensin, yönetici dahil»). Die
    // Leitung wählt weitere Personen dazu; die eigene Kennung wird nicht gegen das
    // Verzeichnis geprüft (wer hier anlegt, benutzt das Modul gerade).
    const [chosenIds, labelIds, boardPosition] = await Promise.all([
        // Zuweisen darf nur die Administratorrolle (15.09.2026); alle anderen legen nur für sich an.
        actor.isSystemAdmin
            ? (0, taskPeople_1.assertAssignablePeople)(actor.tenantId, (input.assigneeIds ?? []).filter((id) => id !== actor.employeeId))
            : [],
        requireTenantLabels(prisma_client_1.default, actor.tenantId, input.labelIds ?? []),
        topBoardPosition(actor.tenantId),
    ]);
    const assigneeIds = [actor.employeeId, ...chosenIds];
    const taskId = (0, nanoid_1.nanoid)(12);
    await (0, taskDb_1.runTasksTransaction)(async (tx) => {
        await tx.task.create({
            data: {
                id: taskId,
                tenantId: actor.tenantId,
                title: input.title,
                description: input.description || null,
                status: 'NOT_STARTED',
                priority: input.priority ?? 'MEDIUM',
                origin: actor.isManager ? 'MANAGER' : 'MEMBER',
                flagged: input.flagged ?? false,
                startAt,
                dueAt,
                reminderAt: input.reminderAt ?? null,
                approvalState: 'NONE',
                reviewState: 'APPROVED',
                reviewDecidedById: actor.employeeId,
                reviewDecidedAt: now,
                boardPosition,
                createdById: actor.employeeId,
            },
            select: { id: true },
        });
        await addAssignees(tx, actor.tenantId, taskId, assigneeIds);
        await addLabelLinks(tx, actor.tenantId, taskId, labelIds);
        await (0, taskActivity_1.logTaskActivity)(tx, actor.tenantId, actor.employeeId, {
            taskId,
            type: taskConstants_1.ACTIVITY.CREATED,
            meta: { title: input.title },
        });
    });
    // Die Zuweisung an sich selbst meldet niemand.
    announceAssignment(actor, taskId, input.title, chosenIds);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.createTask = createTask;
const sameInstant = (a, b) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
/** Was sich gegenüber der gespeicherten Aufgabe ändert — und was vorher galt (für den Verlauf). */
const diffTaskFields = (task, input) => {
    const data = {};
    const before = {};
    const description = input.description === undefined ? undefined : input.description || null;
    if (input.title !== undefined && input.title !== task.title) {
        data.title = input.title;
        before.title = task.title;
    }
    if (description !== undefined && description !== task.description) {
        data.description = description;
        // Der Verlauf ist kein zweiter Speicher: eine lange Beschreibung nur angeschnitten.
        before.description = task.description?.slice(0, 200) ?? null;
    }
    if (input.startAt !== undefined && !sameInstant(input.startAt, task.startAt)) {
        data.startAt = input.startAt;
        before.startAt = task.startAt;
    }
    if (input.dueAt !== undefined && !sameInstant(input.dueAt, task.dueAt)) {
        data.dueAt = input.dueAt;
        before.dueAt = task.dueAt;
    }
    if (input.reminderAt !== undefined && !sameInstant(input.reminderAt, task.reminderAt)) {
        data.reminderAt = input.reminderAt;
        before.reminderAt = task.reminderAt;
    }
    if (input.flagged !== undefined && input.flagged !== task.flagged) {
        data.flagged = input.flagged;
        before.flagged = task.flagged;
    }
    if (input.priority !== undefined && input.priority !== task.priority) {
        data.priority = input.priority;
        before.priority = task.priority;
    }
    return { data, before };
};
/**
 * Titel, Beschreibung, Termine, Fahne, Priorität. Bearbeiten darf die Leitung
 * oder wer den Vorschlag angelegt hat, solange er geprüft wird; NUR die Fahne
 * setzt auch, wer an der Aufgabe misst (Görevly-Menü «Bayrakla»).
 */
const updateTask = async (actor, taskId, input) => {
    const provided = Object.keys(input).filter((field) => input[field] !== undefined);
    const flagOnly = provided.length === 1 && provided[0] === 'flagged';
    await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (!(flagOnly ? permissions.canFlag : permissions.canEdit))
            throw editForbidden();
        if (input.startAt !== undefined || input.dueAt !== undefined) {
            assertDueAfterStart(input.startAt !== undefined ? input.startAt : core.startAt, input.dueAt !== undefined ? input.dueAt : core.dueAt);
        }
        const { data, before } = diffTaskFields(core, input);
        const fields = Object.keys(before);
        if (!fields.length)
            return;
        await tx.task.updateMany({ where: { id: taskId, tenantId: actor.tenantId }, data });
        await (0, taskActivity_1.logTaskActivity)(tx, actor.tenantId, actor.employeeId, {
            taskId,
            type: taskConstants_1.ACTIVITY.UPDATED,
            meta: { fields, before },
        });
    });
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.updateTask = updateTask;
/* ── Löschen ────────────────────────────────────────────────────────────── */
/**
 * Endgültig (tasks.delete). Die Ablage kennt keine Kaskade: die Verweise —
 * auch die der Kommentardateien, die taskId mittragen — werden VOR dem
 * Löschen gesammelt und danach entfernt.
 */
const deleteTask = async (actor, taskId, request) => {
    (0, taskActor_1.assertCanDelete)(actor);
    const [task, fileRefs] = await Promise.all([
        prisma_client_1.default.task.findFirst({ where: { id: taskId, tenantId: actor.tenantId }, select: { title: true, deleteRequestedById: true } }),
        (0, taskFiles_1.collectAttachmentRefs)(prisma_client_1.default, { tenantId: actor.tenantId, taskId }),
    ]);
    if (!task)
        throw (0, taskErrors_1.taskNotFound)();
    const { count } = await prisma_client_1.default.task.deleteMany({ where: { id: taskId, tenantId: actor.tenantId } });
    // Gleichzeitig schon gelöscht: jene Anfrage räumt die Dateien und protokolliert.
    if (!count)
        throw (0, taskErrors_1.taskNotFound)();
    AuditLogService_1.auditLog.log({
        action: 'tasks.task.delete',
        tenantId: actor.tenantId,
        employeeId: actor.employeeId,
        entityType: 'Task',
        entityId: taskId,
        metadata: { title: task.title, fileCount: fileRefs.length },
        ...request,
    });
    await (0, taskFiles_1.removeStoredFiles)(fileRefs);
    // Bestätigte Löschanfrage: die Person, die sie gestellt hat, erfährt es (ohne Link — die Aufgabe ist weg).
    if (task.deleteRequestedById) {
        const requesterId = task.deleteRequestedById;
        void (0, taskPeople_1.loadPersonName)(actor.employeeId)
            .then((actorName) => (0, taskNotify_1.queueTaskNotification)({
            type: taskConstants_1.NOTIFY.DELETE_APPROVED,
            recipientIds: [requesterId],
            title: 'Aufgabe gelöscht',
            message: `«${task.title}» wurde gelöscht.`,
            params: { actor: actorName, title: task.title },
            tenantId: actor.tenantId,
            actorId: actor.employeeId,
            linkUrl: '/tasks',
            meta: { taskId },
        }))
            .catch((error) => console.warn('[tasks.notify] Löschbestätigung nicht vorbereitet', error));
    }
};
exports.deleteTask = deleteTask;
/* ── Löschanfrage (13.09.2026, Samet: «sadece admin silebilir») ─────────── */
/** Wer verantwortlich ist oder die Aufgabe angelegt hat, beantragt das Löschen; ein Admin entscheidet. */
const requestTaskDeletion = async (actor, taskId, input) => {
    const note = input.note || null;
    const core = await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (core.deleteRequestedById)
            throw (0, taskErrors_1.taskConflict)('DELETE_ALREADY_REQUESTED', 'Das Löschen ist bereits beantragt.');
        if (!permissions.canRequestDelete) {
            throw (0, taskErrors_1.taskForbidden)('DELETE_REQUEST_FORBIDDEN', 'Das Löschen beantragen nur Verantwortliche oder wer die Aufgabe angelegt hat.');
        }
        await applyPlan(tx, actor, taskId, {
            data: { deleteRequestedById: actor.employeeId, deleteRequestedAt: new Date(), deleteRequestNote: note },
            activity: { type: taskConstants_1.ACTIVITY.DELETE_REQUESTED, meta: { note } },
        });
        return core;
    });
    notifyAdminsAfterWrite(actor, taskId, (actorName, adminIds) => ({
        type: taskConstants_1.NOTIFY.DELETE_REQUEST,
        recipientIds: adminIds,
        title: 'Löschung beantragt',
        message: `${actorName} möchte «${core.title}» löschen.`,
        params: { actor: actorName, title: core.title, note },
    }));
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.requestTaskDeletion = requestTaskDeletion;
const noPendingDeleteRequest = () => (0, taskErrors_1.taskConflict)('NO_PENDING_DELETE_REQUEST', 'Es gibt keine offene Löschanfrage.');
/** Anfrage zurückziehen: wer sie gestellt hat (oder ein Admin). */
const cancelTaskDeletionRequest = async (actor, taskId) => {
    await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (!core.deleteRequestedById)
            throw noPendingDeleteRequest();
        if (!permissions.canCancelDeleteRequest) {
            throw (0, taskErrors_1.taskForbidden)('DELETE_REQUEST_CANCEL_FORBIDDEN', 'Zurückziehen darf nur, wer das Löschen beantragt hat.');
        }
        await applyPlan(tx, actor, taskId, {
            data: { deleteRequestedById: null, deleteRequestedAt: null, deleteRequestNote: null },
            activity: { type: taskConstants_1.ACTIVITY.DELETE_REQUEST_CANCELLED },
        });
    });
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.cancelTaskDeletionRequest = cancelTaskDeletionRequest;
/** Admin lehnt ab: die Aufgabe bleibt, die Person erfährt den Grund. Bestätigen = DELETE /:taskId. */
const rejectTaskDeletion = async (actor, taskId, input) => {
    (0, taskActor_1.assertCanDelete)(actor);
    const note = input.note || null;
    const result = await withLockedTask(actor, taskId, async (tx, { core }) => {
        if (!core.deleteRequestedById)
            throw noPendingDeleteRequest();
        await applyPlan(tx, actor, taskId, {
            data: { deleteRequestedById: null, deleteRequestedAt: null, deleteRequestNote: null },
            activity: { type: taskConstants_1.ACTIVITY.DELETE_REJECTED, meta: { note } },
        });
        return { title: core.title, requesterId: core.deleteRequestedById };
    });
    notifyAfterWrite(actor, taskId, (context) => [{
            type: taskConstants_1.NOTIFY.DELETE_REJECTED,
            recipientIds: [result.requesterId],
            title: 'Löschung abgelehnt',
            message: note ? `«${result.title}»: ${note}` : `«${result.title}» bleibt bestehen.`,
            params: { actor: context.actor, title: result.title, note },
        }]);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.rejectTaskDeletion = rejectTaskDeletion;
/* ── Ortak ekle (15.09.2026, Samet: «ortak ekleme talebi olmayacak, direkt
   ortak ekleyebileceğiz ama tek tek; eklenen kişi görevi görsün») ─────────── */
/**
 * Eine verantwortliche Person nimmt GENAU EINE weitere Person sofort als
 * Verantwortliche auf — keine Anfrage, keine Freigabe. Die neue Person sieht die
 * Aufgabe damit (sehen = verantwortlich) und bekommt die Zuweisungsmeldung.
 */
const addTaskPartner = async (actor, taskId, input) => {
    const employeeId = input.employeeId;
    await (0, taskPeople_1.assertAssignablePeople)(actor.tenantId, [employeeId]);
    const core = await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (!permissions.canAddPartner) {
            throw (0, taskErrors_1.taskForbidden)('PARTNER_ADD_FORBIDDEN', 'Ortak hinzufügen dürfen nur Verantwortliche einer offenen Aufgabe.');
        }
        if (core.assigneeIds.includes(employeeId)) {
            throw (0, taskErrors_1.taskBadRequest)('PARTNER_ALREADY_ASSIGNED', 'Diese Person ist schon verantwortlich.', { employeeId });
        }
        await addAssignees(tx, actor.tenantId, taskId, [employeeId]);
        await (0, taskActivity_1.logTaskActivity)(tx, actor.tenantId, actor.employeeId, { taskId, type: taskConstants_1.ACTIVITY.ASSIGNED, meta: { employeeId } });
        return core;
    });
    announceAssignment(actor, taskId, core.title, [employeeId]);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.addTaskPartner = addTaskPartner;
/**
 * Eigene Kopien der Dateien — eine nach der anderen, damit nie alle Bytes
 * zugleich im Speicher liegen. Scheitert eine, verschwinden die schon
 * abgelegten Kopien wieder, und der Fehler geht weiter.
 */
const copyAttachmentFiles = async (tenantId, sources) => {
    const copies = [];
    try {
        for (const source of sources) {
            const body = await (0, taskFiles_1.readStoredFile)(source.fileRef);
            const stored = await (0, taskFiles_1.storeTaskFiles)(tenantId, [
                { fileName: source.fileName, contentType: source.contentType, sizeBytes: body.length, body },
            ]);
            copies.push(...stored.map((fileRef) => ({
                ...source, id: (0, nanoid_1.nanoid)(12), sourceId: source.id, fileRef, sizeBytes: body.length,
            })));
        }
        return copies;
    }
    catch (error) {
        await (0, taskFiles_1.removeStoredFiles)(copies.map((copy) => copy.fileRef));
        throw error;
    }
};
/**
 * Inhaltsblöcke der Kopie: Checklisten- und Datei-/Bildblöcke zeigen auf die
 * NEUEN Kennungen (Görevly übernahm die alten Gruppen). Was sich nicht
 * zuordnen lässt, fällt weg — ein Block ohne Ziel wäre ein leerer Rahmen.
 */
const remapContentBlocks = (blocks, checklistIds, attachmentIds) => blocks.flatMap((block) => {
    const target = block.type === 'checklist'
        ? { key: 'groupId', ids: checklistIds }
        : block.type === 'image' || block.type === 'file' ? { key: 'attId', ids: attachmentIds } : null;
    if (!target)
        return [block];
    const ref = block.meta[target.key];
    const mapped = typeof ref === 'string' ? target.ids.get(ref) : undefined;
    return mapped ? [{ ...block, meta: { ...block.meta, [target.key]: mapped } }] : [];
});
/**
 * Kopie als frische Aufgabe der Leitung: Beschreibung, Priorität, Fahne,
 * Termine, Verantwortliche, Etiketten, Checklisten (alle Punkte wieder offen),
 * Dateien und Inhalt. Zeiten, Kommentare, Verlauf und Anfragen kommen nicht
 * mit; wer das Modul nicht mehr benutzen darf, wird nicht mitkopiert.
 */
const duplicateTask = async (actor, taskId, input) => {
    (0, taskActor_1.assertManager)(actor);
    const { tenantId } = actor;
    // Nur eine sichtbare Aufgabe (Nicht-Admins: eigene) — 404/403 wie überall.
    const { core: source } = await (0, taskRows_1.requireVisibleTask)(prisma_client_1.default, actor, taskId);
    const [people, checklists, items, attachments, content, boardPosition] = await Promise.all([
        (0, taskPeople_1.getTasksPeople)(tenantId),
        prisma_client_1.default.taskChecklist.findMany({
            where: { tenantId, taskId: source.id },
            select: { id: true, title: true, position: true, createdById: true, createdAt: true },
        }),
        prisma_client_1.default.taskChecklistItem.findMany({
            where: { tenantId, taskId: source.id },
            select: {
                checklistId: true, text: true, position: true, assigneeId: true, dueAt: true,
                reminderAt: true, flagged: true, createdById: true, createdAt: true,
            },
        }),
        prisma_client_1.default.taskAttachment.findMany({
            where: { tenantId, taskId: source.id, kind: 'TASK' },
            select: { id: true, fileName: true, contentType: true, fileRef: true, uploadedById: true, createdAt: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        (0, taskParts_1.loadTaskContent)(prisma_client_1.default, tenantId, source.id),
        topBoardPosition(tenantId),
    ]);
    const copies = await copyAttachmentFiles(tenantId, attachments);
    const newTaskId = (0, nanoid_1.nanoid)(12);
    const title = input.title || `${source.title} (kopya)`.slice(0, taskConstants_1.TASK_LIMITS.titleMax);
    // Die Kopie einer Nicht-Admin-Person gehört nur ihr: zuweisen darf nur die Administratorrolle.
    const assigneeIds = actor.isSystemAdmin ? source.assigneeIds.filter((id) => people.has(id)) : [actor.employeeId];
    const assigneeSet = new Set(assigneeIds);
    const checklistCopies = checklists.map((list) => ({ ...list, sourceId: list.id, id: (0, nanoid_1.nanoid)(12) }));
    const checklistIds = new Map(checklistCopies.map((copy) => [copy.sourceId, copy.id]));
    const attachmentIds = new Map(copies.map((copy) => [copy.sourceId, copy.id]));
    const itemRows = items.flatMap((item) => {
        const checklistId = checklistIds.get(item.checklistId);
        if (!checklistId)
            return [];
        return [{
                id: (0, nanoid_1.nanoid)(12),
                tenantId,
                taskId: newTaskId,
                checklistId,
                text: item.text,
                position: item.position,
                assigneeId: item.assigneeId && assigneeSet.has(item.assigneeId) ? item.assigneeId : null,
                dueAt: item.dueAt,
                reminderAt: item.reminderAt,
                flagged: item.flagged,
                createdById: item.createdById,
                createdAt: item.createdAt,
            }];
    });
    const blocks = remapContentBlocks(content.blocks, checklistIds, attachmentIds);
    const now = new Date();
    try {
        await (0, taskDb_1.runTasksTransaction)(async (tx) => {
            await tx.task.create({
                data: {
                    id: newTaskId,
                    tenantId,
                    title,
                    description: source.description,
                    status: 'NOT_STARTED',
                    priority: source.priority,
                    origin: 'MANAGER',
                    flagged: source.flagged,
                    startAt: source.startAt,
                    dueAt: source.dueAt,
                    reminderAt: source.reminderAt,
                    approvalState: 'NONE',
                    reviewState: 'APPROVED',
                    reviewDecidedById: actor.employeeId,
                    reviewDecidedAt: now,
                    boardPosition,
                    createdById: actor.employeeId,
                },
                select: { id: true },
            });
            await addAssignees(tx, tenantId, newTaskId, assigneeIds);
            await addLabelLinks(tx, tenantId, newTaskId, source.labelIds);
            if (checklistCopies.length) {
                await tx.taskChecklist.createMany({
                    data: checklistCopies.map((copy) => ({
                        id: copy.id,
                        tenantId,
                        taskId: newTaskId,
                        title: copy.title,
                        position: copy.position,
                        createdById: copy.createdById,
                        createdAt: copy.createdAt,
                    })),
                });
            }
            if (itemRows.length)
                await tx.taskChecklistItem.createMany({ data: itemRows });
            if (copies.length) {
                await tx.taskAttachment.createMany({
                    data: copies.map((copy) => ({
                        id: copy.id,
                        tenantId,
                        kind: 'TASK',
                        taskId: newTaskId,
                        fileName: copy.fileName,
                        contentType: copy.contentType,
                        sizeBytes: copy.sizeBytes,
                        fileRef: copy.fileRef,
                        uploadedById: copy.uploadedById,
                        createdAt: copy.createdAt,
                    })),
                });
            }
            if (blocks.length) {
                await tx.taskContent.create({
                    data: {
                        id: (0, nanoid_1.nanoid)(12),
                        tenantId,
                        taskId: newTaskId,
                        blocks: blocks,
                        version: 1,
                        updatedById: actor.employeeId,
                    },
                    select: { id: true },
                });
            }
            await (0, taskActivity_1.logTaskActivities)(tx, tenantId, actor.employeeId, [
                { taskId: newTaskId, type: taskConstants_1.ACTIVITY.CREATED, meta: { title } },
                { taskId: newTaskId, type: taskConstants_1.ACTIVITY.DUPLICATED, meta: { fromTaskId: source.id } },
            ]);
        });
    }
    catch (error) {
        // Ohne Zeilen gehören die Kopien niemandem.
        await (0, taskFiles_1.removeStoredFiles)(copies.map((copy) => copy.fileRef));
        throw error;
    }
    announceAssignment(actor, newTaskId, title, assigneeIds);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, newTaskId);
};
exports.duplicateTask = duplicateTask;
/* ── Status von Hand und Blockade (Leitung) ─────────────────────────────── */
const setTaskStatus = async (actor, taskId, input) => {
    (0, taskActor_1.assertManager)(actor);
    const reason = input.reason ?? '';
    if (input.status === 'BLOCKED')
        requireReason(reason);
    const { core, plan } = await withLockedTask(actor, taskId, async (tx, { core }) => {
        const plan = planManualStatus(core, input.status, reason, new Date());
        if (plan)
            await applyPlan(tx, actor, taskId, plan);
        return { core, plan };
    });
    notifyIfCompleted(actor, core, plan);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.setTaskStatus = setTaskStatus;
/** Mit Grund: «Yapılamadı» (oder neuer Grund). Leerer Grund: Blockade aufheben. */
const blockTask = async (actor, taskId, input) => {
    (0, taskActor_1.assertManager)(actor);
    const reason = input.reason ?? '';
    await withLockedTask(actor, taskId, async (tx, { core }) => {
        const plan = reason ? planManualStatus(core, 'BLOCKED', reason, new Date()) : planUnblock(core);
        if (plan)
            await applyPlan(tx, actor, taskId, plan);
    });
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.blockTask = blockTask;
/* ── Abschluss ──────────────────────────────────────────────────────────── */
/**
 * «Tamamlandı» — DIREKT (16.09.2026, Samet: «tamamlama talebi olmayacak, direkt
 * tamamlanabilecek, tamamlandı olarak geçecek listeye»). Wer an der Aufgabe
 * misst, und die Leitung, schliessen sie selbst ab: alle laufenden Messungen
 * enden, die Aufgabe steht ab sofort unter «Tamamlandı». Es gibt nichts mehr zu
 * beantragen, zu bestätigen oder abzulehnen.
 *
 * GEBLIEBEN ist die Gecikme açıklaması (15.09.2026): eine ÜBERFÄLLIGE Aufgabe
 * lässt sich nur mit einer kurzen Erklärung des Verzugs schliessen. Sie bleibt
 * an der Aufgabe stehen und ist das Einzige, was die Leitung im Nachhinein noch
 * über den Termin erfährt.
 */
const completeTask = async (actor, taskId, input = {}) => {
    const delayReason = input.delayReason?.trim() || null;
    const { core, plan } = await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (core.status === 'COMPLETED')
            throw (0, taskErrors_1.taskConflict)('TASK_ALREADY_COMPLETED', 'Diese Aufgabe ist bereits abgeschlossen.');
        if (!permissions.canComplete) {
            throw (0, taskErrors_1.taskForbidden)('COMPLETE_FORBIDDEN', 'Abschliessen dürfen Verantwortliche oder die Leitung einer offenen Aufgabe.');
        }
        const now = new Date();
        const overdue = (0, taskAccess_1.isTaskOverdue)(core, now);
        if (overdue && !delayReason) {
            throw (0, taskErrors_1.taskBadRequest)('DELAY_REASON_REQUIRED', 'Die Aufgabe ist überfällig — bitte den Verzug kurz erklären.');
        }
        const plan = {
            // Mit dem Abschluss enden ALLE laufenden Messungen — die Zeit bleibt gebucht.
            closeSessions: { note: 'TASK_COMPLETED' },
            data: {
                ...(overdue && delayReason ? { delayReason, delayReasonById: actor.employeeId, delayReasonAt: now } : {}),
                status: 'COMPLETED',
                completedAt: now,
                blockReason: null,
            },
            activity: { type: taskConstants_1.ACTIVITY.STATUS, meta: { from: core.status, to: 'COMPLETED', ...(delayReason ? { delayReason } : {}) } },
        };
        await applyPlan(tx, actor, taskId, plan);
        return { core, plan };
    });
    notifyIfCompleted(actor, core, plan);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.completeTask = completeTask;
/* ── Verantwortliche und Etiketten ──────────────────────────────────────── */
/**
 * Verantwortliche ersetzen (Leitung). Neue Personen werden geprüft; wer
 * entfernt wird, dessen laufende Messung an der Aufgabe endet (UNASSIGNED).
 * Verlauf und Meldung je Person.
 */
const setTaskAssignees = async (actor, taskId, input) => {
    // Nur die Administratorrolle (15.09.2026, Samet: «görev atama sadece yönetici yapabilir»).
    (0, taskActor_1.assertSystemAdmin)(actor);
    const wanted = [...new Set(input.employeeIds)];
    const { core, added } = await withLockedTask(actor, taskId, async (tx, { core }) => {
        const current = new Set(core.assigneeIds);
        const keep = new Set(wanted);
        const added = await (0, taskPeople_1.assertAssignablePeople)(actor.tenantId, wanted.filter((id) => !current.has(id)));
        const removed = core.assigneeIds.filter((id) => !keep.has(id));
        if (removed.length) {
            await (0, taskTimer_1.closeRunningSessionsOnTask)(tx, actor.tenantId, taskId, actor.employeeId, 'UNASSIGNED', removed);
            await tx.taskAssignee.deleteMany({ where: { tenantId: actor.tenantId, taskId, employeeId: { in: removed } } });
        }
        await addAssignees(tx, actor.tenantId, taskId, added);
        await (0, taskActivity_1.logTaskActivities)(tx, actor.tenantId, actor.employeeId, [
            ...added.map((employeeId) => ({ taskId, type: taskConstants_1.ACTIVITY.ASSIGNED, meta: { employeeId } })),
            ...removed.map((employeeId) => ({ taskId, type: taskConstants_1.ACTIVITY.UNASSIGNED, meta: { employeeId } })),
        ]);
        return { core, added };
    });
    announceAssignment(actor, taskId, core.title, added);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.setTaskAssignees = setTaskAssignees;
/** Etiketten ersetzen (wer bearbeiten darf); ohne Verlauf wie Görevly `toggleLabel`. */
const setTaskLabels = async (actor, taskId, input) => {
    await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (!permissions.canEdit)
            throw editForbidden();
        const labelIds = await requireTenantLabels(tx, actor.tenantId, input.labelIds);
        const keep = new Set(labelIds);
        const current = new Set(core.labelIds);
        const removed = core.labelIds.filter((id) => !keep.has(id));
        if (removed.length) {
            await tx.taskLabelLink.deleteMany({ where: { tenantId: actor.tenantId, taskId, labelId: { in: removed } } });
        }
        await addLabelLinks(tx, actor.tenantId, taskId, labelIds.filter((id) => !current.has(id)));
    });
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.setTaskLabels = setTaskLabels;
/** Enger als das passt zwischen zwei Positionen keine Karte mehr (Gleitkomma). */
const MIN_BOARD_GAP = 1e-6;
const RENUMBER_CHUNK = 500;
/** Spalte neu durchnummerieren — 0, 1, 2 … Schritte in ihrer bisherigen Reihenfolge. */
const renumberBoardColumn = async (tx, tenantId, status) => {
    const rows = await tx.task.findMany({
        where: { tenantId, status },
        select: { id: true },
        orderBy: [{ boardPosition: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
    });
    for (let offset = 0; offset < rows.length; offset += RENUMBER_CHUNK) {
        const chunk = rows.slice(offset, offset + RENUMBER_CHUNK);
        const cases = chunk.map((row, index) => client_1.Prisma.sql `WHEN ${row.id} THEN ${(offset + index) * taskConstants_1.BOARD_POSITION_STEP}`);
        await tx.$executeRaw(client_1.Prisma.sql `
            UPDATE Task SET boardPosition = CASE id ${client_1.Prisma.join(cases, ' ')} END
            WHERE tenantId = ${tenantId} AND id IN (${client_1.Prisma.join(chunk.map((row) => row.id))})
        `);
    }
    return new Map(rows.map((row, index) => [row.id, index * taskConstants_1.BOARD_POSITION_STEP]));
};
/**
 * Position zwischen den Nachbarn: Mitte zwischen der Karte darüber und der
 * darunter, mit nur einer ein Schritt daneben, ohne Nachbarn oben in die
 * Spalte. Nachbarn ausserhalb der Firma oder längst gelöschte zählen nicht.
 */
const resolveBoardPosition = async (tx, tenantId, taskId, status, beforeTaskId, afterTaskId) => {
    const neighbourIds = [beforeTaskId, afterTaskId].filter((id) => Boolean(id) && id !== taskId);
    const neighbours = neighbourIds.length
        ? await tx.task.findMany({ where: { tenantId, id: { in: neighbourIds } }, select: { id: true, boardPosition: true } })
        : [];
    let positions = new Map(neighbours.map((row) => [row.id, row.boardPosition]));
    const positionOf = (id) => (id ? positions.get(id) : undefined);
    let above = positionOf(beforeTaskId);
    let below = positionOf(afterTaskId);
    if (above !== undefined && below !== undefined && below - above < MIN_BOARD_GAP) {
        positions = new Map([...positions, ...(await renumberBoardColumn(tx, tenantId, status))]);
        above = positionOf(beforeTaskId);
        below = positionOf(afterTaskId);
    }
    if (above !== undefined && below !== undefined)
        return (above + below) / 2;
    if (above !== undefined)
        return above + taskConstants_1.BOARD_POSITION_STEP;
    if (below !== undefined)
        return below - taskConstants_1.BOARD_POSITION_STEP;
    const { _min } = await tx.task.aggregate({
        where: { tenantId, status, id: { not: taskId } },
        _min: { boardPosition: true },
    });
    return _min.boardPosition === null ? 0 : _min.boardPosition - taskConstants_1.BOARD_POSITION_STEP;
};
/**
 * Karte auf der Pano ablegen (Leitung). Ein Spaltenwechsel ist ein Status von
 * Hand mit allen Regeln; innerhalb der Spalte bleibt der Status, nur ein neuer
 * Blockadegrund wird übernommen.
 */
const moveTask = async (actor, taskId, input) => {
    (0, taskActor_1.assertManager)(actor);
    const reason = input.reason ?? '';
    const { core, plan } = await withLockedTask(actor, taskId, async (tx, { core }) => {
        const column = input.status ?? core.status;
        const changesStatus = column !== core.status;
        if (changesStatus && column === 'BLOCKED')
            requireReason(reason);
        const plan = input.status && (changesStatus || reason)
            ? planManualStatus(core, input.status, reason, new Date())
            : null;
        const boardPosition = await resolveBoardPosition(tx, actor.tenantId, taskId, column, input.beforeTaskId ?? null, input.afterTaskId ?? null);
        if (plan)
            await applyPlan(tx, actor, taskId, plan, { boardPosition });
        else
            await tx.task.updateMany({ where: { id: taskId, tenantId: actor.tenantId }, data: { boardPosition } });
        return { core, plan };
    });
    notifyIfCompleted(actor, core, plan);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.moveTask = moveTask;
//# sourceMappingURL=taskService.js.map