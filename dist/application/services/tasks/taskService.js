"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.moveTask = exports.setTaskLabels = exports.setTaskAssignees = exports.rejectTaskReview = exports.approveTaskReview = exports.rejectTaskCompletion = exports.approveTaskCompletion = exports.cancelTaskCompletionRequest = exports.requestTaskCompletion = exports.blockTask = exports.setTaskStatus = exports.duplicateTask = exports.rejectTaskPartner = exports.approveTaskPartner = exports.cancelTaskPartnerRequest = exports.requestTaskPartner = exports.rejectTaskDeletion = exports.cancelTaskDeletionRequest = exports.requestTaskDeletion = exports.deleteTask = exports.updateTask = exports.createTask = void 0;
const client_1 = require("@prisma/client");
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const AuditLogService_1 = require("../../../infrastructure/services/AuditLogService");
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
/* Görev-Talepe entscheidet NUR die Administratorrolle (14.09.2026, Samet:
   «sadece Administrator rolü, görevler için ayrı bir rol asla oluşturma»). */
const reviewRequestNotice = (context, title) => ({
    type: taskConstants_1.NOTIFY.REVIEW_REQUEST,
    recipientIds: context.adminIds,
    title: 'Neuer Aufgabenantrag',
    message: `${context.actor} hat die Aufgabe «${title}» beantragt und wartet auf Freigabe.`,
    params: { actor: context.actor, title },
});
const completionRequestNotice = (context, title, note) => ({
    type: taskConstants_1.NOTIFY.COMPLETION_REQUEST,
    recipientIds: context.adminIds,
    title: 'Abschluss beantragt',
    message: `${context.actor} möchte «${title}» abschliessen.`,
    params: { actor: context.actor, title, note },
});
const completionApprovedNotice = (context, task) => ({
    type: taskConstants_1.NOTIFY.COMPLETION_APPROVED,
    recipientIds: [task.approvalRequestedById],
    title: 'Aufgabe abgeschlossen',
    message: `«${task.title}» wurde als erledigt bestätigt.`,
    params: { actor: context.actor, title: task.title },
});
const completionRejectedNotice = (context, task, note) => ({
    type: taskConstants_1.NOTIFY.COMPLETION_REJECTED,
    recipientIds: [task.approvalRequestedById],
    title: 'Abschluss abgelehnt',
    message: `«${task.title}»: ${note}`,
    params: { actor: context.actor, title: task.title, note },
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
const reviewApprovedNotice = (context, task) => ({
    type: taskConstants_1.NOTIFY.REVIEW_APPROVED,
    recipientIds: [task.createdById],
    title: 'Vorschlag freigegeben',
    message: `«${task.title}» wurde freigegeben.`,
    params: { actor: context.actor, title: task.title },
});
const reviewRejectedNotice = (context, task, note, wastedMs) => ({
    type: taskConstants_1.NOTIFY.REVIEW_REJECTED,
    recipientIds: [task.createdById],
    title: 'Vorschlag abgelehnt',
    message: `«${task.title}»: ${note}`,
    params: { actor: context.actor, title: task.title, note, wastedMs },
});
/* ── Prüfungen und kleine Bausteine ─────────────────────────────────────── */
const assertDueAfterStart = (startAt, dueAt) => {
    if (startAt && dueAt && dueAt.getTime() < startAt.getTime()) {
        throw (0, taskErrors_1.taskBadRequest)('DUE_BEFORE_START', 'Das Ende liegt vor dem Anfang.');
    }
};
/** Ablehnen braucht eine Begründung (Görevly: Pflichtfeld «Gerekçe»). */
const requireNote = (note) => {
    if (!note)
        throw (0, taskErrors_1.taskBadRequest)('NOTE_REQUIRED', 'Bitte eine Begründung angeben.');
    return note;
};
const requireReason = (reason) => {
    if (!reason)
        throw (0, taskErrors_1.taskBadRequest)('REASON_REQUIRED', 'Bitte angeben, warum die Aufgabe nicht machbar ist.');
};
const noPendingRequest = () => (0, taskErrors_1.taskConflict)('NO_PENDING_REQUEST', 'Es gibt keine offene Abschlussanfrage.');
const noPendingReview = () => (0, taskErrors_1.taskConflict)('NO_PENDING_REVIEW', 'Es gibt keinen offenen Vorschlag zu prüfen.');
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
const planApproveCompletion = (actorId, note, now) => ({
    // Mit dem Abschluss enden alle laufenden Messungen — die Zeit bleibt gebucht.
    closeSessions: { note: 'TASK_COMPLETED' },
    data: {
        approvalState: 'APPROVED',
        approvalDecidedById: actorId,
        approvalDecidedAt: now,
        approvalDecisionNote: note,
        status: 'COMPLETED',
        completedAt: now,
    },
    activity: { type: taskConstants_1.ACTIVITY.COMPLETION_APPROVED, meta: { note } },
});
/** Status von Hand (Menü «Durum», Spalte der Pano); null = nichts zu tun. */
const planManualStatus = (task, target, reason, actorId, now) => {
    // «Erledigt» auf eine offene Anfrage IST ihre Bestätigung (Görevly quickComplete).
    if (target === 'COMPLETED' && task.approvalState === 'PENDING')
        return planApproveCompletion(actorId, null, now);
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
/** Eine von Hand bestätigte Abschlussanfrage meldet sich bei der Person, die sie gestellt hat. */
const notifyIfCompletionApproved = (actor, task, plan) => {
    if (plan?.activity.type !== taskConstants_1.ACTIVITY.COMPLETION_APPROVED)
        return;
    notifyAfterWrite(actor, task.id, (context) => [completionApprovedNotice(context, task)]);
};
/**
 * Nur die Administratorrolle legt eine sofort freigegebene Aufgabe an. Alle
 * anderen stellen einen Görev-Talep: PENDING_APPROVAL, und die
 * Administratorrolle bekommt eine Meldung («uygun / uygun değil»). Wer anlegt,
 * ist immer selbst verantwortlich; die Leitung darf weitere Personen zuweisen
 * (sie hören davon erst bei der Freigabe).
 */
const createTask = async (actor, input) => {
    const now = new Date();
    const approved = actor.isSystemAdmin;
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
                status: approved ? 'NOT_STARTED' : 'PENDING_APPROVAL',
                priority: input.priority ?? 'MEDIUM',
                origin: actor.isManager ? 'MANAGER' : 'MEMBER',
                flagged: input.flagged ?? false,
                startAt,
                dueAt,
                reminderAt: input.reminderAt ?? null,
                approvalState: 'NONE',
                ...(approved
                    ? { reviewState: 'APPROVED', reviewDecidedById: actor.employeeId, reviewDecidedAt: now }
                    : { reviewState: 'PENDING', reviewRequestedById: actor.employeeId, reviewRequestedAt: now }),
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
    if (!approved) {
        notifyAfterWrite(actor, taskId, (context) => [reviewRequestNotice(context, input.title)]);
    }
    else if (chosenIds.length) {
        // Die Zuweisung an sich selbst meldet niemand.
        notifyAfterWrite(actor, taskId, (context) => [assignedNotice(context, input.title, chosenIds)]);
    }
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
/* ── Ortak-ekle-Anfrage (15.09.2026, Samet: «administratör olmayan kişi ortak
   ekleme talebi yöneticiye gönderilsin, yönetici kabul etsin; tek seferde bir
   istek ve bir kişi») ───────────────────────────────────────────────────── */
const noPendingPartnerRequest = () => (0, taskErrors_1.taskConflict)('NO_PENDING_PARTNER_REQUEST', 'Es gibt keine offene Ortak-Anfrage.');
const clearPartnerRequest = { partnerRequestedById: null, partnerRequestEmployeeId: null, partnerRequestedAt: null };
/** Eine verantwortliche Nicht-Admin-Person schlägt GENAU EINE weitere Person vor; die Administratorrolle entscheidet. */
const requestTaskPartner = async (actor, taskId, input) => {
    const employeeId = input.employeeId;
    await (0, taskPeople_1.assertAssignablePeople)(actor.tenantId, [employeeId]);
    const core = await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (core.partnerRequestedById) {
            throw (0, taskErrors_1.taskConflict)('PARTNER_ALREADY_REQUESTED', 'Für diese Aufgabe ist schon eine Ortak-Anfrage offen.');
        }
        if (!permissions.canRequestPartner) {
            throw (0, taskErrors_1.taskForbidden)('PARTNER_REQUEST_FORBIDDEN', 'Eine Ortak-Anfrage stellen nur Verantwortliche einer offenen Aufgabe.');
        }
        if (core.assigneeIds.includes(employeeId)) {
            throw (0, taskErrors_1.taskBadRequest)('PARTNER_ALREADY_ASSIGNED', 'Diese Person ist schon verantwortlich.', { employeeId });
        }
        await applyPlan(tx, actor, taskId, {
            data: { partnerRequestedById: actor.employeeId, partnerRequestEmployeeId: employeeId, partnerRequestedAt: new Date() },
            activity: { type: taskConstants_1.ACTIVITY.PARTNER_REQUESTED, meta: { employeeId } },
        });
        return core;
    });
    void (0, taskPeople_1.loadPersonName)(employeeId)
        .then((personName) => notifyAdminsAfterWrite(actor, taskId, (actorName, adminIds) => ({
        type: taskConstants_1.NOTIFY.PARTNER_REQUEST,
        recipientIds: adminIds,
        title: 'Ortak-Anfrage',
        message: `${actorName} möchte ${personName} zu «${core.title}» hinzufügen.`,
        params: { actor: actorName, person: personName, title: core.title },
    })))
        .catch((error) => console.warn('[tasks.notify] Ortak-Anfrage nicht vorbereitet', error));
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.requestTaskPartner = requestTaskPartner;
/** Anfrage zurückziehen: wer sie gestellt hat (oder die Administratorrolle). */
const cancelTaskPartnerRequest = async (actor, taskId) => {
    await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (!core.partnerRequestedById)
            throw noPendingPartnerRequest();
        if (!permissions.canCancelPartnerRequest) {
            throw (0, taskErrors_1.taskForbidden)('PARTNER_REQUEST_CANCEL_FORBIDDEN', 'Zurückziehen darf nur, wer die Anfrage gestellt hat.');
        }
        await applyPlan(tx, actor, taskId, {
            data: clearPartnerRequest,
            activity: { type: taskConstants_1.ACTIVITY.PARTNER_REQUEST_CANCELLED, meta: { employeeId: core.partnerRequestEmployeeId } },
        });
    });
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.cancelTaskPartnerRequest = cancelTaskPartnerRequest;
/** Administratorrolle nimmt die vorgeschlagene Person als Verantwortliche auf. */
const approveTaskPartner = async (actor, taskId) => {
    (0, taskActor_1.assertSystemAdmin)(actor);
    const result = await withLockedTask(actor, taskId, async (tx, { core }) => {
        if (!core.partnerRequestedById || !core.partnerRequestEmployeeId)
            throw noPendingPartnerRequest();
        const employeeId = core.partnerRequestEmployeeId;
        // Die Person muss das Modul noch benutzen dürfen.
        await (0, taskPeople_1.assertAssignablePeople)(actor.tenantId, [employeeId]);
        const added = !core.assigneeIds.includes(employeeId);
        if (added)
            await addAssignees(tx, actor.tenantId, taskId, [employeeId]);
        await tx.task.update({ where: { id: taskId }, data: clearPartnerRequest, select: { id: true } });
        if (added) {
            await (0, taskActivity_1.logTaskActivity)(tx, actor.tenantId, actor.employeeId, { taskId, type: taskConstants_1.ACTIVITY.ASSIGNED, meta: { employeeId } });
        }
        return { core, employeeId, requesterId: core.partnerRequestedById, added };
    });
    notifyAfterWrite(actor, taskId, (context) => [
        ...(result.added ? [assignedNotice(context, result.core.title, [result.employeeId])] : []),
        {
            type: taskConstants_1.NOTIFY.PARTNER_APPROVED,
            recipientIds: [result.requesterId],
            title: 'Ortak-Anfrage angenommen',
            message: `«${result.core.title}»: die Person wurde hinzugefügt.`,
            params: { actor: context.actor, title: result.core.title },
        },
    ]);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.approveTaskPartner = approveTaskPartner;
/** Administratorrolle lehnt ab: niemand kommt dazu; wer angefragt hat, erfährt es. */
const rejectTaskPartner = async (actor, taskId, input) => {
    (0, taskActor_1.assertSystemAdmin)(actor);
    const note = input.note || null;
    const result = await withLockedTask(actor, taskId, async (tx, { core }) => {
        if (!core.partnerRequestedById)
            throw noPendingPartnerRequest();
        await applyPlan(tx, actor, taskId, {
            data: clearPartnerRequest,
            activity: { type: taskConstants_1.ACTIVITY.PARTNER_REJECTED, meta: { employeeId: core.partnerRequestEmployeeId, note } },
        });
        return { title: core.title, requesterId: core.partnerRequestedById };
    });
    notifyAfterWrite(actor, taskId, (context) => [{
            type: taskConstants_1.NOTIFY.PARTNER_REJECTED,
            recipientIds: [result.requesterId],
            title: 'Ortak-Anfrage abgelehnt',
            message: note ? `«${result.title}»: ${note}` : `«${result.title}»: niemand wurde hinzugefügt.`,
            params: { actor: context.actor, title: result.title, note },
        }]);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.rejectTaskPartner = rejectTaskPartner;
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
    if (assigneeIds.length) {
        notifyAfterWrite(actor, newTaskId, (context) => [assignedNotice(context, title, assigneeIds)]);
    }
    return (0, taskQueries_1.loadTaskEnvelope)(actor, newTaskId);
};
exports.duplicateTask = duplicateTask;
/* ── Status von Hand und Blockade (Leitung) ─────────────────────────────── */
const setTaskStatus = async (actor, taskId, input) => {
    (0, taskActor_1.assertManager)(actor);
    // Abschliessen (auch das Bestätigen einer offenen Anfrage darüber) nur die Administratorrolle.
    if (input.status === 'COMPLETED')
        (0, taskActor_1.assertCompletionAdmin)(actor);
    const reason = input.reason ?? '';
    if (input.status === 'BLOCKED')
        requireReason(reason);
    const { core, plan } = await withLockedTask(actor, taskId, async (tx, { core }) => {
        const plan = planManualStatus(core, input.status, reason, actor.employeeId, new Date());
        if (plan)
            await applyPlan(tx, actor, taskId, plan);
        return { core, plan };
    });
    notifyIfCompletionApproved(actor, core, plan);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.setTaskStatus = setTaskStatus;
/** Mit Grund: «Yapılamadı» (oder neuer Grund). Leerer Grund: Blockade aufheben. */
const blockTask = async (actor, taskId, input) => {
    (0, taskActor_1.assertManager)(actor);
    const reason = input.reason ?? '';
    await withLockedTask(actor, taskId, async (tx, { core }) => {
        const plan = reason ? planManualStatus(core, 'BLOCKED', reason, actor.employeeId, new Date()) : planUnblock(core);
        if (plan)
            await applyPlan(tx, actor, taskId, plan);
    });
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.blockTask = blockTask;
/* ── Abschlussanfrage ───────────────────────────────────────────────────── */
/**
 * Eine verantwortliche Person meldet «fertig»: ihre Messung endet, die Leitung entscheidet.
 * Ist der Termin überschritten, geht das NUR mit Gecikme açıklaması (15.09.2026, Samet) —
 * sie bleibt an der Aufgabe stehen, auch nach der Entscheidung.
 */
const requestTaskCompletion = async (actor, taskId, input) => {
    const note = input.note || null;
    const delayReason = input.delayReason?.trim() || null;
    const core = await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (core.approvalState === 'PENDING') {
            throw (0, taskErrors_1.taskConflict)('COMPLETION_ALREADY_REQUESTED', 'Der Abschluss ist bereits beantragt.');
        }
        if (!permissions.canRequestCompletion) {
            throw (0, taskErrors_1.taskForbidden)('COMPLETION_REQUEST_FORBIDDEN', 'Den Abschluss beantragen Verantwortliche oder die Leitung einer offenen Aufgabe.');
        }
        const now = new Date();
        const overdue = (0, taskAccess_1.isTaskOverdue)(core, now);
        if (overdue && !delayReason) {
            throw (0, taskErrors_1.taskBadRequest)('DELAY_REASON_REQUIRED', 'Die Aufgabe ist überfällig — bitte den Verzug kurz erklären.');
        }
        await applyPlan(tx, actor, taskId, {
            closeSessions: { note: 'COMPLETION_REQUESTED', employeeIds: [actor.employeeId] },
            data: {
                ...(overdue && delayReason ? { delayReason, delayReasonById: actor.employeeId, delayReasonAt: now } : {}),
                approvalState: 'PENDING',
                approvalRequestedById: actor.employeeId,
                approvalRequestedAt: new Date(),
                approvalNote: note,
                approvalDecidedById: null,
                approvalDecidedAt: null,
                approvalDecisionNote: null,
                status: 'REVIEW',
            },
            activity: { type: taskConstants_1.ACTIVITY.COMPLETION_REQUESTED, meta: overdue ? { note, delayReason } : { note } },
        });
        return core;
    });
    notifyAfterWrite(actor, taskId, (context) => [completionRequestNotice(context, core.title, note)]);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.requestTaskCompletion = requestTaskCompletion;
/** «Geri al»: nur wer beantragt hat — oder die Leitung (Görevly liess es jedem). */
const cancelTaskCompletionRequest = async (actor, taskId) => {
    await withLockedTask(actor, taskId, async (tx, { core, permissions }) => {
        if (core.approvalState !== 'PENDING')
            throw noPendingRequest();
        if (!permissions.canCancelCompletionRequest) {
            throw (0, taskErrors_1.taskForbidden)('COMPLETION_CANCEL_FORBIDDEN', 'Zurückziehen darf nur, wer den Abschluss beantragt hat, oder die Leitung.');
        }
        await applyPlan(tx, actor, taskId, {
            data: {
                approvalState: 'NONE',
                approvalRequestedById: null,
                approvalRequestedAt: null,
                approvalNote: null,
                approvalDecidedById: null,
                approvalDecidedAt: null,
                approvalDecisionNote: null,
                status: resumedStatus(core),
            },
            activity: { type: taskConstants_1.ACTIVITY.COMPLETION_CANCELLED },
        });
    });
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.cancelTaskCompletionRequest = cancelTaskCompletionRequest;
const approveTaskCompletion = async (actor, taskId, input) => {
    (0, taskActor_1.assertCompletionAdmin)(actor);
    const note = input.note || null;
    const core = await withLockedTask(actor, taskId, async (tx, { core }) => {
        if (core.approvalState !== 'PENDING')
            throw noPendingRequest();
        await applyPlan(tx, actor, taskId, planApproveCompletion(actor.employeeId, note, new Date()));
        return core;
    });
    notifyAfterWrite(actor, taskId, (context) => [completionApprovedNotice(context, core)]);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.approveTaskCompletion = approveTaskCompletion;
/** Zurück an die Arbeit, mit Begründung für die Person, die beantragt hat. */
const rejectTaskCompletion = async (actor, taskId, input) => {
    (0, taskActor_1.assertCompletionAdmin)(actor);
    const note = requireNote(input.note);
    const core = await withLockedTask(actor, taskId, async (tx, { core }) => {
        if (core.approvalState !== 'PENDING')
            throw noPendingRequest();
        await applyPlan(tx, actor, taskId, {
            data: {
                approvalState: 'REJECTED',
                approvalDecidedById: actor.employeeId,
                approvalDecidedAt: new Date(),
                approvalDecisionNote: note,
                status: 'IN_PROGRESS',
            },
            activity: { type: taskConstants_1.ACTIVITY.COMPLETION_REJECTED, meta: { note } },
        });
        return core;
    });
    notifyAfterWrite(actor, taskId, (context) => [completionRejectedNotice(context, core, note)]);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.rejectTaskCompletion = rejectTaskCompletion;
/* ── Prüfung eines Vorschlags ───────────────────────────────────────────── */
const approveTaskReview = async (actor, taskId, input) => {
    (0, taskActor_1.assertSystemAdmin)(actor);
    const note = input.note || null;
    const core = await withLockedTask(actor, taskId, async (tx, { core }) => {
        if (core.reviewState !== 'PENDING')
            throw noPendingReview();
        await applyPlan(tx, actor, taskId, {
            data: {
                reviewState: 'APPROVED',
                reviewDecidedById: actor.employeeId,
                reviewDecidedAt: new Date(),
                reviewNote: note,
                // Nur was noch auf die Prüfung wartet, wechselt; ein von Hand gesetzter Status bleibt.
                ...(core.status === 'PENDING_APPROVAL' ? { status: resumedStatus(core) } : {}),
            },
            activity: { type: taskConstants_1.ACTIVITY.REVIEW_APPROVED, meta: { note } },
        });
        return core;
    });
    // Zugewiesene (ausser der Anlegenden) hören erst jetzt von der Aufgabe.
    const newlyAssigned = core.assigneeIds.filter((id) => id !== core.createdById && id !== actor.employeeId);
    notifyAfterWrite(actor, taskId, (context) => [
        reviewApprovedNotice(context, core),
        ...(newlyAssigned.length ? [assignedNotice(context, core.title, newlyAssigned)] : []),
    ]);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.approveTaskReview = approveTaskReview;
/**
 * Vorschlag abgelehnt: laufende Messungen enden (gebucht, nicht verworfen),
 * und die ganze gemessene Zeit gilt als verloren («kayıp süre»). Der
 * Blockadegrund bleibt leer — den Satz baut die Oberfläche aus `reviewNote`.
 */
const rejectTaskReview = async (actor, taskId, input) => {
    (0, taskActor_1.assertSystemAdmin)(actor);
    const note = requireNote(input.note);
    const { core, wastedMs } = await withLockedTask(actor, taskId, async (tx, { core }) => {
        if (core.reviewState !== 'PENDING')
            throw noPendingReview();
        const closed = await applyPlan(tx, actor, taskId, {
            closeSessions: { note: 'REVIEW_REJECTED' },
            data: {
                reviewState: 'REJECTED',
                reviewDecidedById: actor.employeeId,
                reviewDecidedAt: new Date(),
                reviewNote: note,
                status: 'REJECTED',
                completedAt: null,
            },
            activity: { type: taskConstants_1.ACTIVITY.REVIEW_REJECTED, meta: { note } },
        });
        const wastedMs = closed.reduce((sum, session) => sum + (session.discarded ? 0 : session.durationMs), core.closedMs);
        return { core, wastedMs };
    });
    notifyAfterWrite(actor, taskId, (context) => [reviewRejectedNotice(context, core, note, wastedMs)]);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.rejectTaskReview = rejectTaskReview;
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
    if (added.length)
        notifyAfterWrite(actor, taskId, (context) => [assignedNotice(context, core.title, added)]);
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
            ? planManualStatus(core, input.status, reason, actor.employeeId, new Date())
            : null;
        const boardPosition = await resolveBoardPosition(tx, actor.tenantId, taskId, column, input.beforeTaskId ?? null, input.afterTaskId ?? null);
        if (plan)
            await applyPlan(tx, actor, taskId, plan, { boardPosition });
        else
            await tx.task.updateMany({ where: { id: taskId, tenantId: actor.tenantId }, data: { boardPosition } });
        return { core, plan };
    });
    notifyIfCompletionApproved(actor, core, plan);
    return (0, taskQueries_1.loadTaskEnvelope)(actor, taskId);
};
exports.moveTask = moveTask;
//# sourceMappingURL=taskService.js.map