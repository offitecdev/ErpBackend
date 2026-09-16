"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTaskOverdue = exports.effectiveTaskStatus = exports.taskPermissions = exports.canTrackTask = exports.canEditTask = exports.canSeeTask = exports.isIssuePerson = exports.isTaskAssignee = void 0;
const taskConstants_1 = require("./taskConstants");
const isTaskAssignee = (actor, task) => task.assigneeIds.includes(actor.employeeId);
exports.isTaskAssignee = isTaskAssignee;
/** In einem Faden markiert («Sorular & Sorunlar»). */
const isIssuePerson = (actor, task) => (task.issuePersonIds ?? []).includes(actor.employeeId);
exports.isIssuePerson = isIssuePerson;
const canSeeTask = (actor, task) => actor.seesAll || (0, exports.isTaskAssignee)(actor, task) || task.createdById === actor.employeeId
    || (0, exports.isIssuePerson)(actor, task);
exports.canSeeTask = canSeeTask;
const canEditTask = (actor, task) => actor.isManager || (task.createdById === actor.employeeId && task.reviewState === 'PENDING');
exports.canEditTask = canEditTask;
const canTrackTask = (actor, task) => (0, exports.isTaskAssignee)(actor, task) && (0, taskConstants_1.isOpenTaskStatus)(task.status) && task.reviewState !== 'REJECTED';
exports.canTrackTask = canTrackTask;
const taskPermissions = (actor, task) => {
    const isAssignee = (0, exports.isTaskAssignee)(actor, task);
    const isCreator = task.createdById === actor.employeeId;
    const canSee = (0, exports.canSeeTask)(actor, task);
    const canEdit = (0, exports.canEditTask)(actor, task);
    const canTrack = (0, exports.canTrackTask)(actor, task);
    const deletePending = Boolean(task.deleteRequestedById);
    return {
        isAssignee,
        isCreator,
        canSee,
        canEdit,
        canTrack,
        canEditContent: canEdit || canTrack,
        canUpload: actor.isManager || canTrack,
        canComment: canSee,
        canFlag: canEdit || canTrack,
        // Fertig ist fertig: wer an der Aufgabe misst — und die Leitung — setzt
        // sie selbst auf erledigt. Keine Anfrage, keine Freigabe (16.09.2026).
        canComplete: (0, taskConstants_1.isOpenTaskStatus)(task.status) && task.reviewState !== 'REJECTED'
            && (canTrack || (actor.isManager && canSee)),
        canManage: actor.isManager,
        canDelete: actor.canDelete,
        canRequestDelete: !actor.canDelete && (isAssignee || isCreator) && !deletePending,
        canCancelDeleteRequest: deletePending && (task.deleteRequestedById === actor.employeeId || actor.canDelete),
        canAssign: actor.isSystemAdmin,
        canAddPartner: !actor.isSystemAdmin && isAssignee
            && (0, taskConstants_1.isOpenTaskStatus)(task.status) && task.reviewState !== 'REJECTED',
    };
};
exports.taskPermissions = taskPermissions;
/** Görevly `effectiveStatus`: «läuft» ohne Messung und vor dem Anfang zeigt «nicht begonnen». */
const effectiveTaskStatus = (task, now = new Date()) => {
    if (task.status === 'IN_PROGRESS' && !task.hasSessions && task.startAt && task.startAt.getTime() > now.getTime()) {
        return 'NOT_STARTED';
    }
    return task.status;
};
exports.effectiveTaskStatus = effectiveTaskStatus;
const isTaskOverdue = (task, now = new Date()) => Boolean(task.dueAt) && task.dueAt.getTime() < now.getTime() && (0, taskConstants_1.isOpenTaskStatus)(task.status);
exports.isTaskOverdue = isTaskOverdue;
//# sourceMappingURL=taskAccess.js.map