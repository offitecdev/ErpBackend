"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteTaskIssue = exports.setTaskIssueStatus = exports.replyToTaskIssue = exports.createTaskIssue = exports.listTaskIssues = void 0;
const nanoid_1 = require("nanoid");
const taskIssueMailService_1 = require("../../../infrastructure/services/tasks/taskIssueMailService");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const attachmentService_1 = require("./attachmentService");
const taskActivity_1 = require("./taskActivity");
const taskConstants_1 = require("./taskConstants");
const taskDb_1 = require("./taskDb");
const taskErrors_1 = require("./taskErrors");
const taskFiles_1 = require("./taskFiles");
const taskNotify_1 = require("./taskNotify");
const taskPeople_1 = require("./taskPeople");
const taskRows_1 = require("./taskRows");
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
};
/** Wer darf am Faden antworten, ihn schliessen, ihn löschen. */
const issueRights = (actor, issue) => ({
    // Antworten darf, wer die Aufgabe sieht — geprüft ist das schon beim Laden.
    canReply: true,
    // Schliessen/wieder öffnen: wer gefragt hat, und die Leitung.
    canResolve: issue.authorId === actor.employeeId || actor.isManager,
    canDelete: issue.authorId === actor.employeeId || actor.isManager,
});
const toIssueDto = (actor, issue, people, links, messages) => ({
    id: issue.id,
    taskId: issue.taskId,
    kind: issue.kind,
    title: issue.title,
    status: issue.status,
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
const listTaskIssues = async (actor, taskId) => {
    await (0, taskRows_1.requireVisibleTask)(prisma_client_1.default, actor, taskId);
    const issues = await prisma_client_1.default.taskIssue.findMany({
        where: { tenantId: actor.tenantId, taskId },
        select: ISSUE_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!issues.length)
        return { data: [], people: {} };
    const issueIds = issues.map((issue) => issue.id);
    const [messages, persons, links, files] = await Promise.all([
        prisma_client_1.default.taskIssueMessage.findMany({
            where: { tenantId: actor.tenantId, issueId: { in: issueIds } },
            select: { id: true, issueId: true, authorId: true, text: true, createdAt: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        prisma_client_1.default.taskIssuePerson.findMany({
            where: { tenantId: actor.tenantId, issueId: { in: issueIds } },
            select: { issueId: true, employeeId: true, role: true },
            /* `role: desc` heisst TO VOR CC — alphabetisch stünde «CC» zuerst,
               und die Oberfläche zeigte die Kopie an der Stelle der Empfängerin.
               Die erste Markierung ist die Person, an die die Mail ging. */
            orderBy: [{ role: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
        }),
        prisma_client_1.default.taskIssueTaskLink.findMany({
            where: { tenantId: actor.tenantId, issueId: { in: issueIds } },
            select: { issueId: true, task: { select: { id: true, title: true, status: true } } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        prisma_client_1.default.taskAttachment.findMany({
            where: { tenantId: actor.tenantId, taskId, kind: 'ISSUE' },
            select: taskFiles_1.ATTACHMENT_SELECT,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
    ]);
    const filesByMessage = new Map();
    for (const file of files) {
        if (!file.issueMessageId)
            continue;
        const list = filesByMessage.get(file.issueMessageId) ?? [];
        list.push((0, taskFiles_1.toAttachmentDto)(file));
        filesByMessage.set(file.issueMessageId, list);
    }
    const messagesByIssue = new Map();
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
    const peopleByIssue = new Map();
    for (const person of persons) {
        const list = peopleByIssue.get(person.issueId) ?? [];
        list.push({ employeeId: person.employeeId, role: person.role });
        peopleByIssue.set(person.issueId, list);
    }
    const linksByIssue = new Map();
    for (const link of links) {
        if (!link.task)
            continue;
        const list = linksByIssue.get(link.issueId) ?? [];
        list.push({ taskId: link.task.id, title: link.task.title, status: link.task.status });
        linksByIssue.set(link.issueId, list);
    }
    const data = issues.map((issue) => toIssueDto(actor, issue, peopleByIssue.get(issue.id) ?? [], linksByIssue.get(issue.id) ?? [], messagesByIssue.get(issue.id) ?? []));
    const personIds = [
        ...issues.map((issue) => issue.authorId),
        ...issues.map((issue) => issue.resolvedById),
        ...persons.map((person) => person.employeeId),
        ...messages.map((message) => message.authorId),
        ...files.map((file) => file.uploadedById),
    ];
    return { data, people: await (0, taskPeople_1.loadPersonRefs)(personIds) };
};
exports.listTaskIssues = listTaskIssues;
/** Einen einzelnen Faden holen (nach dem Schreiben, für die Antwort an den Browser). */
const loadIssue = async (actor, issueId, taskId) => {
    const { data } = await (0, exports.listTaskIssues)(actor, taskId);
    const issue = data.find((row) => row.id === issueId);
    if (!issue)
        throw (0, taskErrors_1.taskNotFound)('ISSUE_NOT_FOUND', 'Frage nicht gefunden.');
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
const cleanPersonIds = async (actor, ids, already = [], allowed) => {
    const seen = new Set([actor.employeeId, ...already]);
    const out = [];
    for (const raw of ids) {
        const id = String(raw ?? '').trim();
        if (!id || seen.has(id))
            continue;
        seen.add(id);
        out.push(id);
    }
    if (!out.length)
        return out;
    if (out.length > taskConstants_1.TASK_LIMITS.issuePeopleMax) {
        throw (0, taskErrors_1.taskBadRequest)('ISSUE_TOO_MANY_PEOPLE', `Höchstens ${taskConstants_1.TASK_LIMITS.issuePeopleMax} Personen je Frage.`);
    }
    // Nur Personal der ausgewählten Firma, das das Modul öffnen darf — sonst
    // zeigte die Mail auf eine Seite, die sich nicht öffnen lässt.
    const people = await (0, taskPeople_1.getTasksPeople)(actor.tenantId);
    const known = out.filter((id) => people.has(id));
    if (known.length !== out.length) {
        throw (0, taskErrors_1.taskBadRequest)('ISSUE_PERSON_UNKNOWN', 'Eine markierte Person gehört nicht zum Personal dieser Firma.');
    }
    if (allowed && known.some((id) => !allowed.has(id))) {
        throw (0, taskErrors_1.taskBadRequest)('ISSUE_PERSON_NOT_ON_TASK', 'Markieren lassen sich nur die Personen dieser Aufgabe.');
    }
    return known;
};
/**
 * Markierte Aufgaben prüfen: es sind Aufgaben DIESER Firma. Die eigene gehört
 * ausdrücklich dazu (16.09.2026, Samet: «tüm görevleri, bu görev dahil»).
 */
const cleanTaskIds = async (actor, ids, _ownTaskId) => {
    const seen = new Set();
    const out = [];
    for (const raw of ids) {
        const id = String(raw ?? '').trim();
        if (!id || seen.has(id))
            continue;
        seen.add(id);
        out.push(id);
    }
    if (!out.length)
        return out;
    if (out.length > taskConstants_1.TASK_LIMITS.issueTasksMax) {
        throw (0, taskErrors_1.taskBadRequest)('ISSUE_TOO_MANY_TASKS', `Höchstens ${taskConstants_1.TASK_LIMITS.issueTasksMax} Aufgaben je Frage.`);
    }
    const rows = await prisma_client_1.default.task.findMany({
        where: { tenantId: actor.tenantId, id: { in: out } },
        select: { id: true },
    });
    const known = new Set(rows.map((row) => row.id));
    return out.filter((id) => known.has(id));
};
const personRows = (actor, issueId, ids, startRole) => ids.map((employeeId, index) => ({
    id: (0, nanoid_1.nanoid)(12),
    tenantId: actor.tenantId,
    issueId,
    employeeId,
    // Die ERSTE markierte Person steht im An-Feld der Mail, alle weiteren in Kopie.
    role: (index === 0 ? startRole : 'CC'),
    addedById: actor.employeeId,
}));
const createTaskIssue = async (actor, taskId, input) => {
    const title = input.title.trim();
    const text = input.text.trim();
    if (!title)
        throw (0, taskErrors_1.taskBadRequest)('ISSUE_TITLE_REQUIRED', 'Eine Frage braucht eine Überschrift.');
    if (!taskConstants_1.ISSUE_KINDS.includes(input.kind)) {
        throw (0, taskErrors_1.taskBadRequest)('ISSUE_KIND_INVALID', 'Unbekannte Art.');
    }
    const prepared = (0, taskFiles_1.prepareTaskFiles)(input.files, taskConstants_1.TASK_LIMITS.issueFilesMax);
    if (!text && !prepared.length) {
        throw (0, taskErrors_1.taskBadRequest)('ISSUE_EMPTY', 'Eine Frage braucht Text oder eine Datei.');
    }
    const { core, permissions } = await (0, taskRows_1.requireVisibleTask)(prisma_client_1.default, actor, taskId);
    if (!permissions.canComment) {
        throw (0, taskErrors_1.taskForbidden)('ISSUE_FORBIDDEN', 'An dieser Aufgabe dürfen Sie nichts fragen.');
    }
    const onTask = new Set([...core.assigneeIds, core.createdById].filter(Boolean));
    const [personIds, linkTaskIds] = await Promise.all([
        cleanPersonIds(actor, input.personIds, [], onTask),
        cleanTaskIds(actor, input.taskIds, taskId),
    ]);
    const issueId = (0, nanoid_1.nanoid)(12);
    const messageId = (0, nanoid_1.nanoid)(12);
    const files = await (0, attachmentService_1.storeNewAttachments)({ tenantId: actor.tenantId, kind: 'ISSUE', taskId, commentId: null, issueMessageId: messageId, uploadedById: actor.employeeId }, prepared);
    const createdAt = new Date();
    try {
        await (0, taskDb_1.runTasksTransaction)(async (tx) => {
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
            if (personIds.length)
                await tx.taskIssuePerson.createMany({ data: personRows(actor, issueId, personIds, 'TO') });
            if (linkTaskIds.length) {
                await tx.taskIssueTaskLink.createMany({
                    data: linkTaskIds.map((linkedTaskId) => ({
                        id: (0, nanoid_1.nanoid)(12),
                        tenantId: actor.tenantId,
                        issueId,
                        taskId: linkedTaskId,
                        addedById: actor.employeeId,
                    })),
                });
            }
            if (files.length)
                await tx.taskAttachment.createMany({ data: files });
            await (0, taskActivity_1.logTaskActivity)(tx, actor.tenantId, actor.employeeId, {
                taskId,
                type: taskConstants_1.ACTIVITY.ISSUE_OPENED,
                meta: { kind: input.kind, title, important: input.important },
            });
        });
    }
    catch (error) {
        await (0, taskFiles_1.removeStoredFiles)(files.map((file) => file.fileRef));
        throw error;
    }
    const people = await (0, taskPeople_1.loadPersonRefs)([actor.employeeId, ...personIds]);
    const actorName = people[actor.employeeId]?.name ?? '';
    /* DIE MELDUNG: an die markierten Personen — und an die Verantwortlichen der
       Aufgabe, denn eine Frage zu ihrer Aufgabe geht sie an. */
    (0, taskNotify_1.queueTaskNotification)({
        tenantId: actor.tenantId,
        type: taskConstants_1.NOTIFY.ISSUE_TAGGED,
        recipientIds: [...personIds, ...core.assigneeIds, core.createdById],
        actorId: actor.employeeId,
        title: input.kind === 'ISSUE' ? 'Neues Problem' : 'Neue Frage',
        message: `${actorName}: «${title}» — ${core.title}`,
        linkUrl: (0, taskConstants_1.issueLinkUrl)(taskId, issueId),
        params: { actor: actorName, title, task: core.title },
        meta: { taskId, issueId, kind: input.kind, important: input.important },
    });
    // DIE MAIL: die erste markierte Person ins An-Feld, die übrigen in Kopie.
    if (personIds.length) {
        (0, taskIssueMailService_1.queueTaskIssueMail)({
            tenantId: actor.tenantId,
            actorEmployeeId: actor.employeeId,
            issueId,
            taskId,
            kind: input.kind,
            title,
            text,
            important: input.important,
            taskTitle: core.title,
            toEmployeeId: personIds[0],
            ccEmployeeIds: personIds.slice(1),
            stage: 'ASK',
        });
    }
    return { issue: await loadIssue(actor, issueId, taskId), people };
};
exports.createTaskIssue = createTaskIssue;
/** Faden samt Aufgabe laden und Sichtbarkeit prüfen. */
const requireIssue = async (actor, issueId) => {
    const issue = await prisma_client_1.default.taskIssue.findFirst({
        where: { id: issueId, tenantId: actor.tenantId },
        select: ISSUE_SELECT,
    });
    if (!issue)
        throw (0, taskErrors_1.taskNotFound)('ISSUE_NOT_FOUND', 'Frage nicht gefunden.');
    const visible = await (0, taskRows_1.requireVisibleTask)(prisma_client_1.default, actor, issue.taskId);
    return { issue, ...visible };
};
const replyToTaskIssue = async (actor, issueId, input) => {
    const text = input.text.trim();
    const prepared = (0, taskFiles_1.prepareTaskFiles)(input.files, taskConstants_1.TASK_LIMITS.issueFilesMax);
    if (!text && !prepared.length) {
        throw (0, taskErrors_1.taskBadRequest)('ISSUE_REPLY_EMPTY', 'Eine Antwort braucht Text oder eine Datei.');
    }
    const { issue, core, permissions } = await requireIssue(actor, issueId);
    if (!permissions.canComment) {
        throw (0, taskErrors_1.taskForbidden)('ISSUE_FORBIDDEN', 'An dieser Aufgabe dürfen Sie nicht antworten.');
    }
    const existing = await prisma_client_1.default.taskIssuePerson.findMany({
        where: { tenantId: actor.tenantId, issueId },
        select: { employeeId: true, role: true },
        orderBy: [{ role: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const existingIds = existing.map((row) => row.employeeId);
    /* WER ANTWORTET, NIMMT DIE FRAGENDE PERSON MIT AUF (Vorgabe Samet):
       «yanıtlanınca bu sefer o kişiye mesajı gönderen kişi otomatik eklenmesi
       lazım». Sie hat sich nicht selbst markiert — bekäme sonst aber weder
       Meldung noch Mail über die Antwort auf ihre eigene Frage. */
    const onTask = new Set([
        ...core.assigneeIds,
        core.createdById,
        issue.authorId,
        ...existingIds,
    ].filter(Boolean));
    const addedIds = await cleanPersonIds(actor, [issue.authorId, ...input.personIds], existingIds, onTask);
    const messageId = (0, nanoid_1.nanoid)(12);
    const files = await (0, attachmentService_1.storeNewAttachments)({ tenantId: actor.tenantId, kind: 'ISSUE', taskId: issue.taskId, commentId: null, issueMessageId: messageId, uploadedById: actor.employeeId }, prepared);
    const createdAt = new Date();
    try {
        await (0, taskDb_1.runTasksTransaction)(async (tx) => {
            await tx.taskIssueMessage.createMany({
                data: [{ id: messageId, tenantId: actor.tenantId, issueId, authorId: actor.employeeId, text, createdAt }],
            });
            if (files.length)
                await tx.taskAttachment.createMany({ data: files });
            if (addedIds.length) {
                // Nachgetragene Personen stehen immer in Kopie: das An-Feld gehört der ersten Markierung.
                await tx.taskIssuePerson.createMany({ data: personRows(actor, issueId, addedIds, 'CC') });
            }
            await tx.taskIssue.updateMany({
                where: { id: issueId, tenantId: actor.tenantId },
                data: { lastMessageAt: createdAt },
            });
            await (0, taskActivity_1.logTaskActivity)(tx, actor.tenantId, actor.employeeId, {
                taskId: issue.taskId,
                type: taskConstants_1.ACTIVITY.ISSUE_REPLIED,
                meta: { kind: issue.kind, title: issue.title },
            });
        });
    }
    catch (error) {
        await (0, taskFiles_1.removeStoredFiles)(files.map((file) => file.fileRef));
        throw error;
    }
    const audience = [...new Set([issue.authorId, ...existingIds, ...addedIds])].filter((id) => id !== actor.employeeId);
    const people = await (0, taskPeople_1.loadPersonRefs)([actor.employeeId, ...audience]);
    const actorName = people[actor.employeeId]?.name ?? '';
    (0, taskNotify_1.queueTaskNotification)({
        tenantId: actor.tenantId,
        type: taskConstants_1.NOTIFY.ISSUE_REPLY,
        recipientIds: audience,
        actorId: actor.employeeId,
        title: 'Antwort',
        message: `${actorName}: «${issue.title}» — ${core.title}`,
        linkUrl: (0, taskConstants_1.issueLinkUrl)(issue.taskId, issueId),
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
        (0, taskIssueMailService_1.queueTaskIssueMail)({
            tenantId: actor.tenantId,
            actorEmployeeId: actor.employeeId,
            issueId,
            taskId: issue.taskId,
            kind: issue.kind,
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
exports.replyToTaskIssue = replyToTaskIssue;
/** «Çözüldü» / wieder öffnen — wer gefragt hat, und die Leitung. */
const setTaskIssueStatus = async (actor, issueId, resolved) => {
    const { issue, core } = await requireIssue(actor, issueId);
    if (!issueRights(actor, issue).canResolve) {
        throw (0, taskErrors_1.taskForbidden)('ISSUE_RESOLVE_FORBIDDEN', 'Diesen Faden dürfen nur die fragende Person und die Leitung schliessen.');
    }
    const status = resolved ? 'RESOLVED' : 'OPEN';
    if (issue.status !== status) {
        await (0, taskDb_1.runTasksTransaction)(async (tx) => {
            await tx.taskIssue.updateMany({
                where: { id: issueId, tenantId: actor.tenantId },
                data: {
                    status,
                    resolvedById: resolved ? actor.employeeId : null,
                    resolvedAt: resolved ? new Date() : null,
                },
            });
            await (0, taskActivity_1.logTaskActivity)(tx, actor.tenantId, actor.employeeId, {
                taskId: issue.taskId,
                type: resolved ? taskConstants_1.ACTIVITY.ISSUE_RESOLVED : taskConstants_1.ACTIVITY.ISSUE_REOPENED,
                meta: { kind: issue.kind, title: issue.title },
            });
        });
        if (resolved) {
            const persons = await prisma_client_1.default.taskIssuePerson.findMany({
                where: { tenantId: actor.tenantId, issueId },
                select: { employeeId: true },
            });
            const people = await (0, taskPeople_1.loadPersonRefs)([actor.employeeId]);
            const actorName = people[actor.employeeId]?.name ?? '';
            (0, taskNotify_1.queueTaskNotification)({
                tenantId: actor.tenantId,
                type: taskConstants_1.NOTIFY.ISSUE_RESOLVED,
                recipientIds: [issue.authorId, ...persons.map((row) => row.employeeId)],
                actorId: actor.employeeId,
                title: 'Erledigt',
                message: `${actorName}: «${issue.title}» — ${core.title}`,
                linkUrl: (0, taskConstants_1.issueLinkUrl)(issue.taskId, issueId),
                params: { actor: actorName, title: issue.title, task: core.title },
                meta: { taskId: issue.taskId, issueId, kind: issue.kind },
            });
        }
    }
    return { issue: await loadIssue(actor, issueId, issue.taskId) };
};
exports.setTaskIssueStatus = setTaskIssueStatus;
const deleteTaskIssue = async (actor, issueId) => {
    const { issue } = await requireIssue(actor, issueId);
    if (!issueRights(actor, issue).canDelete) {
        throw (0, taskErrors_1.taskForbidden)('ISSUE_DELETE_FORBIDDEN', 'Diesen Faden dürfen nur die fragende Person und die Leitung löschen.');
    }
    // Genau die Dateien, die die Kaskade gleich mitnimmt — die Ablage kennt keine Kaskade.
    const messages = await prisma_client_1.default.taskIssueMessage.findMany({
        where: { tenantId: actor.tenantId, issueId },
        select: { id: true },
    });
    const refs = messages.length
        ? await (0, taskFiles_1.collectAttachmentRefs)(prisma_client_1.default, {
            tenantId: actor.tenantId,
            issueMessageId: { in: messages.map((row) => row.id) },
        })
        : [];
    await prisma_client_1.default.taskIssue.deleteMany({ where: { id: issueId, tenantId: actor.tenantId } });
    await (0, taskFiles_1.removeStoredFiles)(refs);
};
exports.deleteTaskIssue = deleteTaskIssue;
//# sourceMappingURL=issueService.js.map