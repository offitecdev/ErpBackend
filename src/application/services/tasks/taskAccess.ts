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
 *   Abschluss      DIREKT: Verantwortliche und Leitung setzen eine offene
 *                  Aufgabe selbst auf erledigt — keine Anfrage, keine
 *                  Freigabe (16.09.2026); nur die Leitung öffnet sie wieder
 *   entscheiden    Leitung (Status, Zuweisung, Etiketten-Katalog)
 *   löschen        nur Admins (Administratorrolle oder tasks.delete); wer die
 *                  Aufgabe angelegt hat oder verantwortlich ist, BEANTRAGT das
 *                  Löschen — ein Admin entscheidet (13.09.2026)
 *   sehen          Administratorrolle alles; alle anderen (auch die Leitung)
 *                  NUR was ihnen zugewiesen ist, was sie angelegt haben — oder
 *                  wo sie in «Sorular & Sorunlar» markiert wurden (15./16.09.2026)
 *   zuweisen       nur die Administratorrolle; Verantwortliche fügen mit
 *                  «Ortak ekle» direkt EINE Person hinzu, ohne Anfrage (15.09.2026)
 *
 * Diese Datei rechnet NUR — sie liest nichts aus der Datenbank.
 */

/** Was die Regeln von einer Aufgabe wissen müssen. */
export interface TaskAccessFacts {
    status: string;
    createdById: string;
    reviewState: string;
    assigneeIds: readonly string[];
    deleteRequestedById?: string | null;
    /**
     * In «Sorular & Sorunlar» markierte Personen (16.09.2026). Wer an dieser
     * Aufgabe etwas gefragt wird, muss sie auch öffnen und antworten können —
     * sonst führt die Mail ins Leere. Markiert sein heisst NICHT verantwortlich
     * sein: messen, bearbeiten und abschliessen bleiben verschlossen.
     */
    issuePersonIds?: readonly string[];
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
    /**
     * Abschliessen (16.09.2026, Samet: «tamamlama talebi olmayacak, direkt
     * tamamlanabilecek»): Verantwortliche und die Leitung einer offenen
     * Aufgabe — es gibt nichts mehr zu beantragen und nichts zu bestätigen.
     */
    canComplete: boolean;
    canManage: boolean;
    canDelete: boolean;
    /** Nicht-Admin, verantwortlich oder Anlegende, noch keine offene Löschanfrage. */
    canRequestDelete: boolean;
    /** Offene Löschanfrage zurückziehen: wer sie gestellt hat (oder ein Admin). */
    canCancelDeleteRequest: boolean;
    /** Verantwortliche zuweisen/entfernen — nur die Administratorrolle. */
    canAssign: boolean;
    /** «Ortak ekle»: Nicht-Admin, verantwortlich, offene Aufgabe — fügt EINE Person direkt hinzu. */
    canAddPartner: boolean;
}

export const isTaskAssignee = (actor: TasksActor, task: Pick<TaskAccessFacts, 'assigneeIds'>): boolean =>
    task.assigneeIds.includes(actor.employeeId);

/** In einem Faden markiert («Sorular & Sorunlar»). */
export const isIssuePerson = (actor: TasksActor, task: Pick<TaskAccessFacts, 'issuePersonIds'>): boolean =>
    (task.issuePersonIds ?? []).includes(actor.employeeId);

export const canSeeTask = (actor: TasksActor, task: TaskAccessFacts): boolean =>
    actor.seesAll || isTaskAssignee(actor, task) || task.createdById === actor.employeeId
    || isIssuePerson(actor, task);

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
        canComplete: isOpenTaskStatus(task.status) && task.reviewState !== 'REJECTED'
            && (canTrack || (actor.isManager && canSee)),
        canManage: actor.isManager,
        canDelete: actor.canDelete,
        canRequestDelete: !actor.canDelete && (isAssignee || isCreator) && !deletePending,
        canCancelDeleteRequest: deletePending && (task.deleteRequestedById === actor.employeeId || actor.canDelete),
        canAssign: actor.isSystemAdmin,
        canAddPartner: !actor.isSystemAdmin && isAssignee
            && isOpenTaskStatus(task.status) && task.reviewState !== 'REJECTED',
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
