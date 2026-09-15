import type { TasksActor } from './taskActor';
import { isOpenTaskStatus, type TaskStatusKey } from './taskConstants';

/**
 * ── WER DARF WAS AN EINER AUFGABE (Görevly auth.js, serverseitig) ───────────
 *
 *   sehen          Leitung · Verantwortliche · wer sie angelegt hat
 *   bearbeiten     Leitung · die Anlegende, solange ihr Vorschlag geprüft wird
 *   messen         Verantwortliche, solange sie nicht abgeschlossen/abgelehnt ist
 *   Inhalt/Liste   bearbeiten ODER messen (Tabelle/Trenner neu: nur Leitung)
 *   Dateien        Leitung ODER messen
 *   kommentieren   wer sie sehen darf; löschen: eigener Kommentar oder Leitung
 *   Abschluss      beantragen: messen und keine offene Anfrage;
 *                  zurückziehen: wer beantragt hat (oder Leitung)
 *   entscheiden    Leitung (Anfragen, Vorschläge, Status, Zuweisung, Etiketten-Katalog)
 *   löschen        nur Admins (Administratorrolle oder tasks.delete); wer die
 *                  Aufgabe angelegt hat oder verantwortlich ist, BEANTRAGT das
 *                  Löschen — ein Admin entscheidet (13.09.2026)
 *   sehen          Administratorrolle alles; alle anderen (auch die Leitung)
 *                  NUR was ihnen zugewiesen ist oder was sie angelegt haben (15.09.2026)
 *   zuweisen       nur die Administratorrolle; Verantwortliche BEANTRAGEN
 *                  «Ortak ekle» — eine Anfrage, eine Person (15.09.2026)
 *
 * Diese Datei rechnet NUR — sie liest nichts aus der Datenbank.
 */

/** Was die Regeln von einer Aufgabe wissen müssen. */
export interface TaskAccessFacts {
    status: string;
    createdById: string;
    reviewState: string;
    approvalState: string;
    approvalRequestedById: string | null;
    assigneeIds: readonly string[];
    deleteRequestedById?: string | null;
    partnerRequestedById?: string | null;
}

export interface TaskPermissions {
    isAssignee: boolean;
    isCreator: boolean;
    canSee: boolean;
    canEdit: boolean;
    canTrack: boolean;
    canEditContent: boolean;
    canUpload: boolean;
    canComment: boolean;
    canFlag: boolean;
    canRequestCompletion: boolean;
    /** Abschluss bestätigen/ablehnen oder direkt abschliessen — nur die Administratorrolle. */
    canApproveCompletion: boolean;
    canCancelCompletionRequest: boolean;
    canManage: boolean;
    canDelete: boolean;
    /** Nicht-Admin, verantwortlich oder Anlegende, noch keine offene Löschanfrage. */
    canRequestDelete: boolean;
    /** Offene Löschanfrage zurückziehen: wer sie gestellt hat (oder ein Admin). */
    canCancelDeleteRequest: boolean;
    /** Verantwortliche zuweisen/entfernen — nur die Administratorrolle. */
    canAssign: boolean;
    /** Nicht-Admin, verantwortlich, offene Aufgabe, noch keine offene Ortak-Anfrage. */
    canRequestPartner: boolean;
    /** Offene Ortak-Anfrage zurückziehen: wer sie gestellt hat (oder die Administratorrolle). */
    canCancelPartnerRequest: boolean;
    /** Ortak-Anfrage annehmen/ablehnen — nur die Administratorrolle. */
    canDecidePartnerRequest: boolean;
}

export const isTaskAssignee = (actor: TasksActor, task: Pick<TaskAccessFacts, 'assigneeIds'>): boolean =>
    task.assigneeIds.includes(actor.employeeId);

export const canSeeTask = (actor: TasksActor, task: TaskAccessFacts): boolean =>
    actor.seesAll || isTaskAssignee(actor, task) || task.createdById === actor.employeeId;

export const canEditTask = (actor: TasksActor, task: TaskAccessFacts): boolean =>
    actor.isManager || (task.createdById === actor.employeeId && task.reviewState === 'PENDING');

export const canTrackTask = (actor: TasksActor, task: TaskAccessFacts): boolean =>
    isTaskAssignee(actor, task) && isOpenTaskStatus(task.status) && task.reviewState !== 'REJECTED';

export const taskPermissions = (actor: TasksActor, task: TaskAccessFacts): TaskPermissions => {
    const isAssignee = isTaskAssignee(actor, task);
    const isCreator = task.createdById === actor.employeeId;
    const canSee = canSeeTask(actor, task);
    const canEdit = canEditTask(actor, task);
    const canTrack = canTrackTask(actor, task);
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
            && (canTrack || (actor.isManager && canSee && isOpenTaskStatus(task.status) && task.reviewState !== 'REJECTED')),
        canApproveCompletion: actor.isSystemAdmin && canSee,
        canCancelCompletionRequest: approvalPending
            && (task.approvalRequestedById === actor.employeeId || actor.isManager),
        canManage: actor.isManager,
        canDelete: actor.canDelete,
        canRequestDelete: !actor.canDelete && (isAssignee || isCreator) && !deletePending,
        canCancelDeleteRequest: deletePending && (task.deleteRequestedById === actor.employeeId || actor.canDelete),
        canAssign: actor.isSystemAdmin,
        canRequestPartner: !actor.isSystemAdmin && isAssignee && !partnerPending
            && isOpenTaskStatus(task.status) && task.reviewState !== 'REJECTED',
        canCancelPartnerRequest: partnerPending && (task.partnerRequestedById === actor.employeeId || actor.isSystemAdmin),
        canDecidePartnerRequest: partnerPending && actor.isSystemAdmin,
    };
};

/** Görevly `effectiveStatus`: «läuft» ohne Messung und vor dem Anfang zeigt «nicht begonnen». */
export const effectiveTaskStatus = (
    task: { status: string; startAt: Date | null; hasSessions: boolean },
    now: Date = new Date(),
): TaskStatusKey => {
    if (task.status === 'IN_PROGRESS' && !task.hasSessions && task.startAt && task.startAt.getTime() > now.getTime()) {
        return 'NOT_STARTED';
    }
    return task.status as TaskStatusKey;
};

export const isTaskOverdue = (task: { status: string; dueAt: Date | null }, now: Date = new Date()): boolean =>
    Boolean(task.dueAt) && (task.dueAt as Date).getTime() < now.getTime() && isOpenTaskStatus(task.status);
