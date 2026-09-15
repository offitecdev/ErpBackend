"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTaskOverdue = exports.effectiveTaskStatus = exports.taskPermissions = exports.canTrackTask = exports.canEditTask = exports.canSeeTask = exports.isTaskAssignee = void 0;
const taskConstants_1 = require("./taskConstants");
const isTaskAssignee = (actor, task) => task.assigneeIds.includes(actor.employeeId);
exports.isTaskAssignee = isTaskAssignee;
const canSeeTask = (actor, task) => actor.seesAll || (0, exports.isTaskAssignee)(actor, task) || task.createdById === actor.employeeId;
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
    const approvalPending = task.approvalState === 'PENDING';
    const deletePending = Boolean(task.deleteRequestedById);
    const partnerPending = Boolean(task.partnerRequestedById);
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
        // Alle ausser der Administratorrolle BEANTRAGEN den Abschluss: Verantwortliche,
        // und die Leitung für sichtbare offene Aufgaben.
        canRequestCompletion: !actor.isSystemAdmin && !approvalPending
            && (canTrack || (actor.isManager && canSee && (0, taskConstants_1.isOpenTaskStatus)(task.status) && task.reviewState !== 'REJECTED')),
        canApproveCompletion: actor.isSystemAdmin && canSee,
        canCancelCompletionRequest: approvalPending
            && (task.approvalRequestedById === actor.employeeId || actor.isManager),
        canManage: actor.isManager,
        canDelete: actor.canDelete,
        canRequestDelete: !actor.canDelete && (isAssignee || isCreator) && !deletePending,
        canCancelDeleteRequest: deletePending && (task.deleteRequestedById === actor.employeeId || actor.canDelete),
        canAssign: actor.isSystemAdmin,
        canRequestPartner: !actor.isSystemAdmin && isAssignee && !partnerPending
            && (0, taskConstants_1.isOpenTaskStatus)(task.status) && task.reviewState !== 'REJECTED',
        canCancelPartnerRequest: partnerPending && (task.partnerRequestedById === actor.employeeId || actor.isSystemAdmin),
        canDecidePartnerRequest: partnerPending && actor.isSystemAdmin,
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