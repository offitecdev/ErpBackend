import { nanoid } from 'nanoid';

import { queueTaskIssueMail } from '../../../infrastructure/services/tasks/taskIssueMailService';
import prisma from '../../../infrastructure/database/prisma.client';
import { storeNewAttachments } from './attachmentService';
import type { TasksActor } from './taskActor';
import { logTaskActivity } from './taskActivity';
import {
    ACTIVITY,
    ISSUE_KINDS,
    NOTIFY,
    TASK_LIMITS,
    issueLinkUrl,
    type IssueKind,
    type IssuePersonRole,
    type IssueStatus,
} from './taskConstants';
import { runTasksTransaction } from './taskDb';
import { taskBadRequest, taskForbidden, taskNotFound } from './taskErrors';
import {
    ATTACHMENT_SELECT,
    collectAttachmentRefs,
    prepareTaskFiles,
    removeStoredFiles,
    toAttachmentDto,
    type AttachmentDto,
    type IncomingTaskFile,
} from './taskFiles';
import { queueTaskNotification } from './taskNotify';
import { getTasksPeople, loadPersonRefs, type PersonRef } from './taskPeople';
import { requireVisibleTask } from './taskRows';

/**
 * ── SORULAR & SORUNLAR (16.09.2026, Vorgabe Samet) ──────────────────────────
 *
 * «görev detayına soru ve sorunlar olarak bir bölüm aç … kişi etiketleme görev
 * etiketleme olacak … mail olarak da etiketlenen kişi ve kişiler ilk kişi
 * normal diğer kişi cc olarak gider … o kişide yanıtla diyebilsin».
 *
 * Ein FADEN je Frage («Sorular») oder Problem («Sorunlar») an einer Aufgabe:
 * eine grosse Sprechblase mit farbiger Überschrift, darunter die Antworten.
 * Text, Bild und PDF stehen in DERSELBEN Blase — Dateien sind Teil der
 * Nachricht, kein Anhangstreifen daneben.
 *
 * WER WIRD GEFRAGT: die markierten Personen. Die ERSTE steht im An-Feld der
 * Mail, alle weiteren in Kopie (`role` TO/CC). Wer markiert ist, DARF die
 * Aufgabe sehen und antworten (taskAccess: `issuePersonIds`) — eine Frage, die
 * auf eine gesperrte Seite zeigt, wäre keine Frage.
 *
 * WICHTIG (`important`): Ausrufezeichen auf der Karte, und die Mail geht als
 * wichtige Post raus (Importance/X-Priority).
 *
 * ANTWORTEN: wer antwortet, nimmt die FRAGENDE Person automatisch in den Faden
 * auf — sie bekommt Meldung und Mail, ohne sich selbst markiert zu haben. Die
 * Antwortmail geht an die Person, der geantwortet wird (An), alle übrigen
 * Beteiligten stehen in Kopie.
 *
 * Meldung und Mail sind getrennt: die Meldung (Glocke) wird immer geschrieben,
 * die Mail ist «feuern und vergessen» — ein stummer Mailserver darf eine Frage
 * nicht scheitern lassen.
 */

/* ── Gestalt der Antworten ──────────────────────────────────────────────── */

export interface IssuePersonDto {
    employeeId: string;
    role: IssuePersonRole;
}

export interface IssueLinkDto {
    taskId: string;
    title: string;
    status: string;
}

export interface IssueMessageDto {
    id: string;
    authorId: string;
    /** Klartext, nie maskiert. */
    text: string;
    createdAt: Date;
    /** Bilder und PDFs stehen IN der Blase. */
    attachments: AttachmentDto[];
    /** Die erste Nachricht ist die Frage selbst — sie lässt sich nicht einzeln löschen. */
    isOpening: boolean;
}

export interface IssueDto {
    id: string;
    taskId: string;
    kind: IssueKind;
    title: string;
    status: IssueStatus;
    important: boolean;
    authorId: string;
    createdAt: Date;
    lastMessageAt: Date;
    resolvedById: string | null;
    resolvedAt: Date | null;
    people: IssuePersonDto[];
    links: IssueLinkDto[];
    messages: IssueMessageDto[];
    canReply: boolean;
    canResolve: boolean;
    canDelete: boolean;
}

export interface NewIssueInput {
    kind: IssueKind;
    title: string;
    text: string;
    important: boolean;
    /** Markierte Personen in der gewählten Reihenfolge — die erste ist die Empfängerin. */
    personIds: readonly string[];
    /** Markierte andere Aufgaben. */
    taskIds: readonly string[];
    files: readonly IncomingTaskFile[];
}

export interface IssueReplyInput {
    text: string;
    /** Zusätzlich markierte Personen (dürfen beim Antworten nachgetragen werden). */
    personIds: readonly string[];
    files: readonly IncomingTaskFile[];
}

/* ── Lesen ──────────────────────────────────────────────────────────────── */

const ISSUE_SELECT = {
    id: true,
    taskId: true,
    kind: true,
    title: true,
    status: true,
    important: true,
    authorId: true,
    createdAt: true,
    lastMessageAt: true,
    resolvedById: true,
    resolvedAt: true,
} as const;

type IssueRow = {
    id: string;
    taskId: string;
    kind: string;
    title: string;
    status: string;
    important: boolean;
    authorId: string;
    createdAt: Date;
    lastMessageAt: Date;
    resolvedById: string | null;
    resolvedAt: Date | null;
};

/** Wer darf am Faden antworten, ihn schliessen, ihn löschen. */
const issueRights = (actor: TasksActor, issue: Pick<IssueRow, 'authorId' | 'status'>) => ({
    // Antworten darf, wer die Aufgabe sieht — geprüft ist das schon beim Laden.
    canReply: true,
    // Schliessen/wieder öffnen: wer gefragt hat, und die Leitung.
    canResolve: issue.authorId === actor.employeeId || actor.isManager,
    canDelete: issue.authorId === actor.employeeId || actor.isManager,
});

const toIssueDto = (
    actor: TasksActor,
    issue: IssueRow,
    people: IssuePersonDto[],
    links: IssueLinkDto[],
    messages: IssueMessageDto[],
): IssueDto => ({
    id: issue.id,
    taskId: issue.taskId,
    kind: issue.kind as IssueKind,
    title: issue.title,
    status: issue.status as IssueStatus,
    important: issue.important,
    authorId: issue.authorId,
    createdAt: issue.createdAt,
    lastMessageAt: issue.lastMessageAt,
    resolvedById: issue.resolvedById,
    resolvedAt: issue.resolvedAt,
    people,
    links,
    messages,
    ...issueRights(actor, issue),
});

/**
 * Alle Fäden einer Aufgabe samt Blasen, markierten Personen und markierten
 * Aufgaben — VIER Abfragen für beide Reiter zusammen, nicht eine je Faden.
 */
export const listTaskIssues = async (
    actor: TasksActor,
    taskId: string,
): Promise<{ data: IssueDto[]; people: Record<string, PersonRef> }> => {
    await requireVisibleTask(prisma, actor, taskId);

    const issues = await prisma.taskIssue.findMany({
        where: { tenantId: actor.tenantId, taskId },
        select: ISSUE_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!issues.length) return { data: [], people: {} };

    const issueIds = issues.map((issue) => issue.id);
    const [messages, persons, links, files] = await Promise.all([
        prisma.taskIssueMessage.findMany({
            where: { tenantId: actor.tenantId, issueId: { in: issueIds } },
            select: { id: true, issueId: true, authorId: true, text: true, createdAt: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        prisma.taskIssuePerson.findMany({
            where: { tenantId: actor.tenantId, issueId: { in: issueIds } },
            select: { issueId: true, employeeId: true, role: true },
            /* `role: desc` heisst TO VOR CC — alphabetisch stünde «CC» zuerst,
               und die Oberfläche zeigte die Kopie an der Stelle der Empfängerin.
               Die erste Markierung ist die Person, an die die Mail ging. */
            orderBy: [{ role: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        }),
        prisma.taskIssueTaskLink.findMany({
            where: { tenantId: actor.tenantId, issueId: { in: issueIds } },
            select: { issueId: true, task: { select: { id: true, title: true, status: true } } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        prisma.taskAttachment.findMany({
            where: { tenantId: actor.tenantId, taskId, kind: 'ISSUE' },
            select: ATTACHMENT_SELECT,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
    ]);

    const filesByMessage = new Map<string, AttachmentDto[]>();
    for (const file of files) {
        if (!file.issueMessageId) continue;
        const list = filesByMessage.get(file.issueMessageId) ?? [];
        list.push(toAttachmentDto(file));
        filesByMessage.set(file.issueMessageId, list);
    }

    const messagesByIssue = new Map<string, IssueMessageDto[]>();
    for (const message of messages) {
        const list = messagesByIssue.get(message.issueId) ?? [];
        list.push({
            id: message.id,
            authorId: message.authorId,
            text: message.text,
            createdAt: message.createdAt,
            attachments: filesByMessage.get(message.id) ?? [],
            isOpening: list.length === 0,
        });
        messagesByIssue.set(message.issueId, list);
    }

    const peopleByIssue = new Map<string, IssuePersonDto[]>();
    for (const person of persons) {
        const list = peopleByIssue.get(person.issueId) ?? [];
        list.push({ employeeId: person.employeeId, role: person.role as IssuePersonRole });
        peopleByIssue.set(person.issueId, list);
    }

    const linksByIssue = new Map<string, IssueLinkDto[]>();
    for (const link of links) {
        if (!link.task) continue;
        const list = linksByIssue.get(link.issueId) ?? [];
        list.push({ taskId: link.task.id, title: link.task.title, status: link.task.status });
        linksByIssue.set(link.issueId, list);
    }

    const data = issues.map((issue) => toIssueDto(
        actor,
        issue,
        peopleByIssue.get(issue.id) ?? [],
        linksByIssue.get(issue.id) ?? [],
        messagesByIssue.get(issue.id) ?? [],
    ));

    const personIds = [
        ...issues.map((issue) => issue.authorId),
        ...issues.map((issue) => issue.resolvedById),
        ...persons.map((person) => person.employeeId),
        ...messages.map((message) => message.authorId),
        ...files.map((file) => file.uploadedById),
    ];
    return { data, people: await loadPersonRefs(personIds) };
};

/** Einen einzelnen Faden holen (nach dem Schreiben, für die Antwort an den Browser). */
const loadIssue = async (actor: TasksActor, issueId: string, taskId: string): Promise<IssueDto> => {
    const { data } = await listTaskIssues(actor, taskId);
    const issue = data.find((row) => row.id === issueId);
    if (!issue) throw taskNotFound('ISSUE_NOT_FOUND', 'Frage nicht gefunden.');
    return issue;
};

/* ── Schreiben ──────────────────────────────────────────────────────────── */

/**
 * Markierte Personen prüfen: Personal DIESER Firma mit Modulzugang, ohne
 * Doppelte, ohne sich selbst — und nur, wer zu DIESER AUFGABE gehört
 * (16.09.2026, Samet: «sadece görevdeki kişileri etiketleyebilirsiniz»).
 * `allowed` ist dieser Kreis: Verantwortliche, die anlegende Person, und am
 * laufenden Faden zusätzlich die fragende Person und die schon Markierten —
 * sonst könnte man der eigenen Gegenüberin nicht antworten.
 */
const cleanPersonIds = async (
    actor: TasksActor,
    ids: readonly string[],
    already: readonly string[] = [],
    allowed?: ReadonlySet<string>,
): Promise<string[]> => {
    const seen = new Set<string>([actor.employeeId, ...already]);
    const out: string[] = [];
    for (const raw of ids) {
        const id = String(raw ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    if (!out.length) return out;
    if (out.length > TASK_LIMITS.issuePeopleMax) {
        throw taskBadRequest('ISSUE_TOO_MANY_PEOPLE', `Höchstens ${TASK_LIMITS.issuePeopleMax} Personen je Frage.`);
    }
    // Nur Personal der ausgewählten Firma, das das Modul öffnen darf — sonst
    // zeigte die Mail auf eine Seite, die sich nicht öffnen lässt.
    const people = await getTasksPeople(actor.tenantId);
    const known = out.filter((id) => people.has(id));
    if (known.length !== out.length) {
        throw taskBadRequest('ISSUE_PERSON_UNKNOWN', 'Eine markierte Person gehört nicht zum Personal dieser Firma.');
    }
    if (allowed && known.some((id) => !allowed.has(id))) {
        throw taskBadRequest('ISSUE_PERSON_NOT_ON_TASK', 'Markieren lassen sich nur die Personen dieser Aufgabe.');
    }
    return known;
};

/**
 * Markierte Aufgaben prüfen: es sind Aufgaben DIESER Firma. Die eigene gehört
 * ausdrücklich dazu (16.09.2026, Samet: «tüm görevleri, bu görev dahil»).
 */
const cleanTaskIds = async (actor: TasksActor, ids: readonly string[], _ownTaskId: string): Promise<string[]> => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of ids) {
        const id = String(raw ?? '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    if (!out.length) return out;
    if (out.length > TASK_LIMITS.issueTasksMax) {
        throw taskBadRequest('ISSUE_TOO_MANY_TASKS', `Höchstens ${TASK_LIMITS.issueTasksMax} Aufgaben je Frage.`);
    }
    const rows = await prisma.task.findMany({
        where: { tenantId: actor.tenantId, id: { in: out } },
        select: { id: true },
    });
    const known = new Set(rows.map((row) => row.id));
    return out.filter((id) => known.has(id));
};

const personRows = (
    actor: TasksActor,
    issueId: string,
    ids: readonly string[],
    startRole: IssuePersonRole,
) => ids.map((employeeId, index) => ({
    id: nanoid(12),
    tenantId: actor.tenantId,
    issueId,
    employeeId,
    // Die ERSTE markierte Person steht im An-Feld der Mail, alle weiteren in Kopie.
    role: (index === 0 ? startRole : 'CC') as IssuePersonRole,
    addedById: actor.employeeId,
}));

export const createTaskIssue = async (
    actor: TasksActor,
    taskId: string,
    input: NewIssueInput,
): Promise<{ issue: IssueDto; people: Record<string, PersonRef> }> => {
    const title = input.title.trim();
    const text = input.text.trim();
    if (!title) throw taskBadRequest('ISSUE_TITLE_REQUIRED', 'Eine Frage braucht eine Überschrift.');
    if (!(ISSUE_KINDS as readonly string[]).includes(input.kind)) {
        throw taskBadRequest('ISSUE_KIND_INVALID', 'Unbekannte Art.');
    }
    const prepared = prepareTaskFiles(input.files, TASK_LIMITS.issueFilesMax);
    if (!text && !prepared.length) {
        throw taskBadRequest('ISSUE_EMPTY', 'Eine Frage braucht Text oder eine Datei.');
    }

    const { core, permissions } = await requireVisibleTask(prisma, actor, taskId);
    if (!permissions.canComment) {
        throw taskForbidden('ISSUE_FORBIDDEN', 'An dieser Aufgabe dürfen Sie nichts fragen.');
    }

    const onTask = new Set<string>([...core.assigneeIds, core.createdById].filter(Boolean));
    const [personIds, linkTaskIds] = await Promise.all([
        cleanPersonIds(actor, input.personIds, [], onTask),
        cleanTaskIds(actor, input.taskIds, taskId),
    ]);

    const issueId = nanoid(12);
    const messageId = nanoid(12);
    const files = await storeNewAttachments(
        { tenantId: actor.tenantId, kind: 'ISSUE', taskId, commentId: null, issueMessageId: messageId, uploadedById: actor.employeeId },
        prepared,
    );
    const createdAt = new Date();
    try {
        await runTasksTransaction(async (tx) => {
            await tx.taskIssue.createMany({
                data: [{
                    id: issueId,
                    tenantId: actor.tenantId,
                    taskId,
                    kind: input.kind,
                    title,
                    status: 'OPEN',
                    important: input.important,
                    authorId: actor.employeeId,
                    lastMessageAt: createdAt,
                    createdAt,
                }],
            });
            await tx.taskIssueMessage.createMany({
                data: [{ id: messageId, tenantId: actor.tenantId, issueId, authorId: actor.employeeId, text, createdAt }],
            });
            if (personIds.length) await tx.taskIssuePerson.createMany({ data: personRows(actor, issueId, personIds, 'TO') });
            if (linkTaskIds.length) {
                await tx.taskIssueTaskLink.createMany({
                    data: linkTaskIds.map((linkedTaskId) => ({
                        id: nanoid(12),
                        tenantId: actor.tenantId,
                        issueId,
                        taskId: linkedTaskId,
                        addedById: actor.employeeId,
                    })),
                });
            }
            if (files.length) await tx.taskAttachment.createMany({ data: files });
            await logTaskActivity(tx, actor.tenantId, actor.employeeId, {
                taskId,
                type: ACTIVITY.ISSUE_OPENED,
                meta: { kind: input.kind, title, important: input.important },
            });
        });
    } catch (error) {
        await removeStoredFiles(files.map((file) => file.fileRef));
        throw error;
    }

    const people = await loadPersonRefs([actor.employeeId, ...personIds]);
    const actorName = people[actor.employeeId]?.name ?? '';

    /* DIE MELDUNG: an die markierten Personen — und an die Verantwortlichen der
       Aufgabe, denn eine Frage zu ihrer Aufgabe geht sie an. */
    queueTaskNotification({
        tenantId: actor.tenantId,
        type: NOTIFY.ISSUE_TAGGED,
        recipientIds: [...personIds, ...core.assigneeIds, core.createdById],
        actorId: actor.employeeId,
        title: input.kind === 'ISSUE' ? 'Neues Problem' : 'Neue Frage',
        message: `${actorName}: «${title}» — ${core.title}`,
        linkUrl: issueLinkUrl(taskId, issueId),
        params: { actor: actorName, title, task: core.title },
        meta: { taskId, issueId, kind: input.kind, important: input.important },
    });

    // DIE MAIL: die erste markierte Person ins An-Feld, die übrigen in Kopie.
    if (personIds.length) {
        queueTaskIssueMail({
            tenantId: actor.tenantId,
            actorEmployeeId: actor.employeeId,
            issueId,
            taskId,
            kind: input.kind,
            title,
            text,
            important: input.important,
            taskTitle: core.title,
            toEmployeeId: personIds[0] as string,
            ccEmployeeIds: personIds.slice(1),
            stage: 'ASK',
        });
    }

    return { issue: await loadIssue(actor, issueId, taskId), people };
};

/** Faden samt Aufgabe laden und Sichtbarkeit prüfen. */
const requireIssue = async (actor: TasksActor, issueId: string) => {
    const issue = await prisma.taskIssue.findFirst({
        where: { id: issueId, tenantId: actor.tenantId },
        select: ISSUE_SELECT,
    });
    if (!issue) throw taskNotFound('ISSUE_NOT_FOUND', 'Frage nicht gefunden.');
    const visible = await requireVisibleTask(prisma, actor, issue.taskId);
    return { issue, ...visible };
};

export const replyToTaskIssue = async (
    actor: TasksActor,
    issueId: string,
    input: IssueReplyInput,
): Promise<{ issue: IssueDto; people: Record<string, PersonRef> }> => {
    const text = input.text.trim();
    const prepared = prepareTaskFiles(input.files, TASK_LIMITS.issueFilesMax);
    if (!text && !prepared.length) {
        throw taskBadRequest('ISSUE_REPLY_EMPTY', 'Eine Antwort braucht Text oder eine Datei.');
    }

    const { issue, core, permissions } = await requireIssue(actor, issueId);
    if (!permissions.canComment) {
        throw taskForbidden('ISSUE_FORBIDDEN', 'An dieser Aufgabe dürfen Sie nicht antworten.');
    }

    const existing = await prisma.taskIssuePerson.findMany({
        where: { tenantId: actor.tenantId, issueId },
        select: { employeeId: true, role: true },
        orderBy: [{ role: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const existingIds = existing.map((row) => row.employeeId);

    /* WER ANTWORTET, NIMMT DIE FRAGENDE PERSON MIT AUF (Vorgabe Samet):
       «yanıtlanınca bu sefer o kişiye mesajı gönderen kişi otomatik eklenmesi
       lazım». Sie hat sich nicht selbst markiert — bekäme sonst aber weder
       Meldung noch Mail über die Antwort auf ihre eigene Frage. */
    const onTask = new Set<string>([
        ...core.assigneeIds,
        core.createdById,
        issue.authorId,
        ...existingIds,
    ].filter(Boolean));
    const addedIds = await cleanPersonIds(
        actor,
        [issue.authorId, ...input.personIds],
        existingIds,
        onTask,
    );

    const messageId = nanoid(12);
    const files = await storeNewAttachments(
        { tenantId: actor.tenantId, kind: 'ISSUE', taskId: issue.taskId, commentId: null, issueMessageId: messageId, uploadedById: actor.employeeId },
        prepared,
    );
    const createdAt = new Date();
    try {
        await runTasksTransaction(async (tx) => {
            await tx.taskIssueMessage.createMany({
                data: [{ id: messageId, tenantId: actor.tenantId, issueId, authorId: actor.employeeId, text, createdAt }],
            });
            if (files.length) await tx.taskAttachment.createMany({ data: files });
            if (addedIds.length) {
                // Nachgetragene Personen stehen immer in Kopie: das An-Feld gehört der ersten Markierung.
                await tx.taskIssuePerson.createMany({ data: personRows(actor, issueId, addedIds, 'CC') });
            }
            await tx.taskIssue.updateMany({
                where: { id: issueId, tenantId: actor.tenantId },
                data: { lastMessageAt: createdAt },
            });
            await logTaskActivity(tx, actor.tenantId, actor.employeeId, {
                taskId: issue.taskId,
                type: ACTIVITY.ISSUE_REPLIED,
                meta: { kind: issue.kind, title: issue.title },
            });
        });
    } catch (error) {
        await removeStoredFiles(files.map((file) => file.fileRef));
        throw error;
    }

    const audience = [...new Set([issue.authorId, ...existingIds, ...addedIds])].filter((id) => id !== actor.employeeId);
    const people = await loadPersonRefs([actor.employeeId, ...audience]);
    const actorName = people[actor.employeeId]?.name ?? '';

    queueTaskNotification({
        tenantId: actor.tenantId,
        type: NOTIFY.ISSUE_REPLY,
        recipientIds: audience,
        actorId: actor.employeeId,
        title: 'Antwort',
        message: `${actorName}: «${issue.title}» — ${core.title}`,
        linkUrl: issueLinkUrl(issue.taskId, issueId),
        params: { actor: actorName, title: issue.title, task: core.title },
        meta: { taskId: issue.taskId, issueId, kind: issue.kind },
    });

    /* Die Antwortmail geht an die Person, DER geantwortet wird — das ist die
       fragende Person; antwortet sie selbst, an die zuerst markierte. Alle
       übrigen Beteiligten stehen in Kopie. */
    const toId = audience.includes(issue.authorId)
        ? issue.authorId
        : (existing.find((row) => row.role === 'TO')?.employeeId ?? audience[0] ?? null);
    if (toId) {
        queueTaskIssueMail({
            tenantId: actor.tenantId,
            actorEmployeeId: actor.employeeId,
            issueId,
            taskId: issue.taskId,
            kind: issue.kind as IssueKind,
            title: issue.title,
            text,
            important: issue.important,
            taskTitle: core.title,
            toEmployeeId: toId,
            ccEmployeeIds: audience.filter((id) => id !== toId),
            stage: 'REPLY',
        });
    }

    return { issue: await loadIssue(actor, issueId, issue.taskId), people };
};

/** «Çözüldü» / wieder öffnen — wer gefragt hat, und die Leitung. */
export const setTaskIssueStatus = async (
    actor: TasksActor,
    issueId: string,
    resolved: boolean,
): Promise<{ issue: IssueDto }> => {
    const { issue, core } = await requireIssue(actor, issueId);
    if (!issueRights(actor, issue).canResolve) {
        throw taskForbidden('ISSUE_RESOLVE_FORBIDDEN', 'Diesen Faden dürfen nur die fragende Person und die Leitung schliessen.');
    }
    const status: IssueStatus = resolved ? 'RESOLVED' : 'OPEN';
    if (issue.status !== status) {
        await runTasksTransaction(async (tx) => {
            await tx.taskIssue.updateMany({
                where: { id: issueId, tenantId: actor.tenantId },
                data: {
                    status,
                    resolvedById: resolved ? actor.employeeId : null,
                    resolvedAt: resolved ? new Date() : null,
                },
            });
            await logTaskActivity(tx, actor.tenantId, actor.employeeId, {
                taskId: issue.taskId,
                type: resolved ? ACTIVITY.ISSUE_RESOLVED : ACTIVITY.ISSUE_REOPENED,
                meta: { kind: issue.kind, title: issue.title },
            });
        });

        if (resolved) {
            const persons = await prisma.taskIssuePerson.findMany({
                where: { tenantId: actor.tenantId, issueId },
                select: { employeeId: true },
            });
            const people = await loadPersonRefs([actor.employeeId]);
            const actorName = people[actor.employeeId]?.name ?? '';
            queueTaskNotification({
                tenantId: actor.tenantId,
                type: NOTIFY.ISSUE_RESOLVED,
                recipientIds: [issue.authorId, ...persons.map((row) => row.employeeId)],
                actorId: actor.employeeId,
                title: 'Erledigt',
                message: `${actorName}: «${issue.title}» — ${core.title}`,
                linkUrl: issueLinkUrl(issue.taskId, issueId),
                params: { actor: actorName, title: issue.title, task: core.title },
                meta: { taskId: issue.taskId, issueId, kind: issue.kind },
            });
        }
    }
    return { issue: await loadIssue(actor, issueId, issue.taskId) };
};

export const deleteTaskIssue = async (actor: TasksActor, issueId: string): Promise<void> => {
    const { issue } = await requireIssue(actor, issueId);
    if (!issueRights(actor, issue).canDelete) {
        throw taskForbidden('ISSUE_DELETE_FORBIDDEN', 'Diesen Faden dürfen nur die fragende Person und die Leitung löschen.');
    }
    // Genau die Dateien, die die Kaskade gleich mitnimmt — die Ablage kennt keine Kaskade.
    const messages = await prisma.taskIssueMessage.findMany({
        where: { tenantId: actor.tenantId, issueId },
        select: { id: true },
    });
    const refs = messages.length
        ? await collectAttachmentRefs(prisma, {
            tenantId: actor.tenantId,
            issueMessageId: { in: messages.map((row) => row.id) },
        })
        : [];
    await prisma.taskIssue.deleteMany({ where: { id: issueId, tenantId: actor.tenantId } });
    await removeStoredFiles(refs);
};
