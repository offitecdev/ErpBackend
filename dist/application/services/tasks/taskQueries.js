"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listTaskActivity = exports.getTaskDetail = exports.buildWorkDto = exports.loadTaskSessions = exports.listTaskApprovals = exports.searchTasks = exports.listTasks = exports.SORT_DIRECTIONS = exports.TASK_LIST_SORTS = exports.TASK_LIST_VIEWS = exports.TASK_LIST_SCOPES = exports.TASK_LIST_FILTERS = exports.getTasksBootstrap = exports.getTasksSummary = exports.loadTaskEnvelope = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const taskActor_1 = require("./taskActor");
const commentService_1 = require("./commentService");
const taskConstants_1 = require("./taskConstants");
const taskErrors_1 = require("./taskErrors");
const taskForecast_1 = require("./taskForecast");
const taskParts_1 = require("./taskParts");
const taskPeople_1 = require("./taskPeople");
const taskRows_1 = require("./taskRows");
const taskTime_1 = require("./taskTime");
const taskTimer_1 = require("./taskTimer");
const taskOnboarding_1 = require("./taskOnboarding");
/**
 * ── GÖREVLER: LESEWEGE DER AUFGABEN ─────────────────────────────────────────
 *
 * Start der Seite (bootstrap), Zähler der Seitenleiste (summary), Liste, Pano
 * und Schnellsuche, die Anfragen der Leitung (approvals), die Detailansicht,
 * der Verlauf und die Zeitaufschlüsselung. Hier wird nur GELESEN — die
 * Zustandswechsel stehen in taskService.ts.
 *
 * Die Datenbank ist fern (50–170 ms je Anweisung): die Teile einer Antwort
 * laufen parallel, Aufgabenzeilen kommen aus EINER Anweisung
 * (TASK_CORE_COLUMNS). «Jetzt» ist die Uhr dieses Servers und geht als Wert in
 * die Abfragen — dieselbe Uhr rechnet `overdue` der Zeilen und `serverNow`.
 *
 * Zeiten (ms): die Leitung sieht alle Personen; ein Teammitglied nur die
 * EIGENEN Messungen (14.09.2026) — nie die Zeit oder Namen anderer.
 */
/* ── Bausteine ──────────────────────────────────────────────────────────── */
/** Offen = weder abgeschlossen noch abgelehnt (Görevly `isOpen`). */
const OPEN_TASK_SQL = client_1.Prisma.sql `t.status NOT IN (${client_1.Prisma.join([...taskConstants_1.CLOSED_TASK_STATUSES])})`;
/** Rang eines Zustands — TASK_STATUSES steht in der Reihenfolge von Görevly `STATUS.order`. */
const STATUS_RANK_SQL = client_1.Prisma.sql `FIELD(t.status, ${client_1.Prisma.join([...taskConstants_1.TASK_STATUSES])})`;
/** Görevly sortiert hoch vor mittel vor niedrig. */
const PRIORITY_RANK_SQL = client_1.Prisma.sql `FIELD(t.priority, 'HIGH', 'MEDIUM', 'LOW')`;
/**
 * Laufende Messungen und Personen der Zeilen in EINEM Rundgang. Messen dürfen
 * nur Verantwortliche, und wer entfernt wird, dessen Messung endet — ihre
 * Namen stehen darum schon in `taskPeopleIds`; nur eine Abweichung davon
 * kostet eine Nachlesung. Teammitglieder brauchen diese Namen nicht.
 */
const loadRunningSessionsAndPeople = async (actor, cores) => {
    const [running, people] = await Promise.all([
        (0, taskRows_1.loadRunningSessionsByTask)(prisma_client_1.default, actor.tenantId, cores.map((core) => core.id)),
        (0, taskPeople_1.loadPersonRefs)(cores.flatMap((core) => (0, taskRows_1.taskPeopleIds)(core))),
    ]);
    if (actor.isManager) {
        const missing = [...running.values()].flat().map((session) => session.employeeId).filter((id) => !people[id]);
        if (missing.length)
            Object.assign(people, await (0, taskPeople_1.loadPersonRefs)(missing));
    }
    return { running, people };
};
/** Die Aufgabe im Zustand NACH dem Commit — die Antwort jedes Schreibwegs. */
const loadTaskEnvelope = async (actor, taskId) => {
    const [core, ownClosedMs] = await Promise.all([
        (0, taskRows_1.loadTaskCore)(prisma_client_1.default, actor.tenantId, taskId),
        actor.isManager ? Promise.resolve(undefined) : loadOwnClosedMs(actor, taskId),
    ]);
    if (!core)
        throw (0, taskErrors_1.taskNotFound)();
    const { running, people } = await loadRunningSessionsAndPeople(actor, [core]);
    const now = new Date();
    return { task: (0, taskRows_1.toTaskDetailDto)(core, actor, running.get(core.id) ?? [], now, ownClosedMs), people, serverNow: now };
};
exports.loadTaskEnvelope = loadTaskEnvelope;
/** Summe der eigenen abgeschlossenen Messungen an einer Aufgabe (Teammitglieder sehen nur ihre Zeit). */
const loadOwnClosedMs = async (actor, taskId) => {
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT COALESCE(SUM(durationMs), 0) AS ms
        FROM TaskTimeSession
        WHERE tenantId = ${actor.tenantId} AND taskId = ${taskId} AND employeeId = ${actor.employeeId} AND endedAt IS NOT NULL
    `);
    return (0, taskRows_1.rawNumber)(rows[0]?.ms);
};
const getTasksSummary = async (actor) => {
    const now = new Date();
    const [countRows, unreadRows, activeTimer] = await Promise.all([
        prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT
                COALESCE(SUM(CASE WHEN ${OPEN_TASK_SQL} THEN 1 ELSE 0 END), 0) AS openCount,
                COALESCE(SUM(CASE WHEN ${OPEN_TASK_SQL} AND t.dueAt < ${now} THEN 1 ELSE 0 END), 0) AS overdueCount,
                COALESCE(SUM(CASE WHEN ${OPEN_TASK_SQL} AND t.dueAt >= ${now} AND t.dueAt <= ${(0, taskTime_1.endOfLocalDay)(now)}
                    THEN 1 ELSE 0 END), 0) AS dueTodayCount,
                COALESCE(SUM(CASE WHEN FALSE
                    ${actor.isSystemAdmin ? client_1.Prisma.sql `OR t.approvalState = 'PENDING'` : client_1.Prisma.empty}
                    ${actor.canDelete ? client_1.Prisma.sql `OR t.deleteRequestedAt IS NOT NULL` : client_1.Prisma.empty}
                    ${actor.isSystemAdmin ? client_1.Prisma.sql `OR t.partnerRequestedAt IS NOT NULL` : client_1.Prisma.empty}
                    THEN 1 ELSE 0 END), 0) AS pendingCount
            FROM Task t
            WHERE ${(0, taskRows_1.visibleTasksSql)(actor)}
        `),
        // Ungelesen = Textnachrichten anderer nach dem eigenen Lesestand (sonst nach dem Beitritt).
        prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT COUNT(*) AS unread
            FROM TaskChatMember m
            JOIN TaskChatMessage msg ON msg.roomId = m.roomId
            WHERE m.tenantId = ${actor.tenantId}
              AND m.employeeId = ${actor.employeeId}
              AND msg.tenantId = ${actor.tenantId}
              AND msg.type = 'TEXT'
              AND msg.senderId <> ${actor.employeeId}
              AND msg.createdAt > COALESCE(m.lastReadAt, m.createdAt)
        `),
        (0, taskTimer_1.getActiveTimer)(actor.employeeId),
    ]);
    const counts = countRows[0] ?? {};
    return {
        openCount: (0, taskRows_1.rawNumber)(counts.openCount),
        overdueCount: (0, taskRows_1.rawNumber)(counts.overdueCount),
        dueTodayCount: (0, taskRows_1.rawNumber)(counts.dueTodayCount),
        // Anfragen entscheidet nur die Administratorrolle — nur sie sieht den Zähler.
        pendingApprovalCount: actor.isSystemAdmin ? (0, taskRows_1.rawNumber)(counts.pendingCount) : 0,
        unreadChatCount: (0, taskRows_1.rawNumber)(unreadRows[0]?.unread),
        activeTimer,
        serverNow: now,
    };
};
exports.getTasksSummary = getTasksSummary;
const loadTaskLabels = async (actor) => {
    if (!actor.isManager) {
        return prisma_client_1.default.taskLabel.findMany({
            where: { tenantId: actor.tenantId },
            select: { id: true, name: true, color: true },
            orderBy: [{ name: 'asc' }],
        });
    }
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT l.id, l.name, l.color, COUNT(k.id) AS usageCount
        FROM TaskLabel l
        LEFT JOIN TaskLabelLink k ON k.labelId = l.id AND k.tenantId = ${actor.tenantId}
        WHERE l.tenantId = ${actor.tenantId}
        GROUP BY l.id, l.name, l.color
        ORDER BY l.name
    `);
    return rows.map((row) => ({ id: row.id, name: row.name, color: row.color, usageCount: (0, taskRows_1.rawNumber)(row.usageCount) }));
};
/** Einstellungen gelten je Person über alle Firmen; ohne Zeile gilt der Standard. */
const loadReminderLeadMinutes = async (employeeId) => {
    const setting = await prisma_client_1.default.taskUserSetting.findUnique({
        where: { employeeId },
        select: { reminderLeadMinutes: true },
    });
    return setting?.reminderLeadMinutes ?? taskConstants_1.DEFAULT_REMINDER_LEAD_MINUTES;
};
const getTasksBootstrap = async (actor) => {
    const onboarding = await (0, taskOnboarding_1.ensureTaskOnboarding)(actor);
    const [labels, reminderLeadMinutes, summary] = await Promise.all([
        loadTaskLabels(actor),
        loadReminderLeadMinutes(actor.employeeId),
        (0, exports.getTasksSummary)(actor),
    ]);
    return {
        actor: { employeeId: actor.employeeId, isManager: actor.isManager, canDelete: actor.canDelete, seesAll: actor.seesAll, isSystemAdmin: actor.isSystemAdmin },
        labels,
        settings: { reminderLeadMinutes },
        summary,
        onboarding,
        serverNow: summary.serverNow,
    };
};
exports.getTasksBootstrap = getTasksBootstrap;
/* ── Liste, Pano, Schnellsuche ──────────────────────────────────────────── */
exports.TASK_LIST_FILTERS = ['open', 'done', 'late', 'all'];
exports.TASK_LIST_SCOPES = ['all', 'mine'];
exports.TASK_LIST_VIEWS = ['list', 'board', 'search'];
exports.TASK_LIST_SORTS = ['due', 'created', 'title', 'status', 'priority'];
exports.SORT_DIRECTIONS = ['asc', 'desc'];
/** Suchtext als Teilstring; `%` und `_` gelten wörtlich. */
const likePattern = (text) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
const listWhereSql = (actor, query, now) => {
    const conditions = [(0, taskRows_1.visibleTasksSql)(actor)];
    if (actor.seesAll && query.scope === 'mine')
        conditions.push((0, taskRows_1.memberVisibilitySql)(actor.employeeId));
    if (query.filter === 'open')
        conditions.push(OPEN_TASK_SQL);
    if (query.filter === 'done')
        conditions.push(client_1.Prisma.sql `t.status = 'COMPLETED'`);
    if (query.filter === 'late')
        conditions.push(client_1.Prisma.sql `${OPEN_TASK_SQL} AND t.dueAt < ${now}`);
    if (query.assigneeId) {
        conditions.push(client_1.Prisma.sql `EXISTS (SELECT 1 FROM TaskAssignee fa WHERE fa.taskId = t.id AND fa.employeeId = ${query.assigneeId})`);
    }
    if (query.labelId) {
        conditions.push(client_1.Prisma.sql `EXISTS (SELECT 1 FROM TaskLabelLink fl WHERE fl.taskId = t.id AND fl.labelId = ${query.labelId})`);
    }
    if (query.status)
        conditions.push(client_1.Prisma.sql `t.status = ${query.status}`);
    if (query.flagged)
        conditions.push(client_1.Prisma.sql `t.flagged = 1`);
    if (query.q)
        conditions.push(client_1.Prisma.sql `t.title LIKE ${likePattern(query.q)}`);
    if (query.from && query.to) {
        conditions.push(client_1.Prisma.sql `COALESCE(t.startAt, t.createdAt) <= ${query.to}`);
        conditions.push(client_1.Prisma.sql `(CASE WHEN t.status = 'COMPLETED'
            THEN COALESCE(t.completedAt, t.dueAt, t.startAt, t.createdAt)
            ELSE COALESCE(t.dueAt, t.startAt, t.createdAt) END) >= ${query.from}`);
    }
    return client_1.Prisma.join(conditions, ' AND ');
};
/**
 * Reihenfolge: die Pano nach Spalte, dann Position (neue Karten oben). Sonst
 * nach Wahl; «Ende» wie Görevly (`dueAt || Infinity`): ohne Termin steht
 * aufsteigend unten, absteigend oben. Gleichstand: neueste zuerst.
 */
const listOrderSql = (query) => {
    const tieBreak = client_1.Prisma.sql `t.createdAt DESC, t.id ASC`;
    if (query.view === 'board')
        return client_1.Prisma.sql `${STATUS_RANK_SQL} ASC, t.boardPosition ASC, ${tieBreak}`;
    const dir = client_1.Prisma.raw(query.dir === 'desc' ? 'DESC' : 'ASC');
    switch (query.sort) {
        case 'created': return client_1.Prisma.sql `t.createdAt ${dir}, t.id ASC`;
        case 'title': return client_1.Prisma.sql `t.title ${dir}, ${tieBreak}`;
        case 'status': return client_1.Prisma.sql `${STATUS_RANK_SQL} ${dir}, ${tieBreak}`;
        case 'priority': return client_1.Prisma.sql `${PRIORITY_RANK_SQL} ${dir}, ${tieBreak}`;
        default: return client_1.Prisma.sql `t.dueAt IS NULL ${dir}, t.dueAt ${dir}, ${tieBreak}`;
    }
};
const listTasks = async (actor, query) => {
    // Nach der ersten Prüfung im Prozess ohne Rundgang: die Kennung ist deterministisch.
    const onboardingTaskId = (0, taskOnboarding_1.knownOnboardingTaskId)(actor) ?? (await (0, taskOnboarding_1.ensureTaskOnboarding)(actor)).taskId;
    const now = new Date();
    const [result, directory] = await Promise.all([
        (0, taskRows_1.fetchTaskListRows)(prisma_client_1.default, actor, {
            where: listWhereSql(actor, query, now),
            // The unfinished guide is literally the person's first task: keep
            // it above normal sorting until the walkthrough completes.
            orderBy: client_1.Prisma.sql `(t.id = ${onboardingTaskId}) DESC, ${listOrderSql(query)}`,
            limit: query.pageSize,
            offset: (query.page - 1) * query.pageSize,
        }, now, query.day),
        (0, taskPeople_1.getTasksPeople)(actor.tenantId),
    ]);
    // Namen aus dem 30-s-Verzeichnis; nur ehemalige Personen kosten eine Nachlesung.
    const people = {};
    const missing = [];
    for (const id of result.personIds) {
        const person = directory.get(id);
        if (person)
            people[id] = { id, name: (0, taskPeople_1.personDisplayName)(person) };
        else
            missing.push(id);
    }
    if (missing.length) {
        for (const ref of Object.values(await (0, taskPeople_1.loadPersonRefs)(missing)))
            people[ref.id] = { id: ref.id, name: ref.name };
    }
    return {
        data: result.rows,
        // Eine Seite hinter dem Ende hat keine Zeile, die OVER() trägt.
        total: result.rows.length ? result.total : (query.page - 1) * query.pageSize,
        page: query.page,
        pageSize: query.pageSize,
        people,
        serverNow: now,
    };
};
exports.listTasks = listTasks;
/** Schnellsuche (⌘K): schlanke Treffer ohne Zähler und ohne Personen. */
const searchTasks = async (actor, query) => {
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT t.id, t.title, t.status, t.dueAt
        FROM Task t
        WHERE ${listWhereSql(actor, query, new Date())}
        ORDER BY ${listOrderSql(query)}
        LIMIT ${taskConstants_1.TASK_LIMITS.searchLimit}
    `);
    return { data: rows.map((row) => ({ id: row.id, title: row.title, status: row.status, dueAt: (0, taskRows_1.rawDate)(row.dueAt) })) };
};
exports.searchTasks = searchTasks;
/**
 * Offene Abschluss- und Partneranfragen (Administrator, nur sichtbare Aufgaben) und
 * Löschanfragen (nur Admins); eine Aufgabe kann in mehreren Gruppen stehen.
 */
const listTaskApprovals = async (actor) => {
    if (!actor.isManager && !actor.canDelete)
        (0, taskActor_1.assertManager)(actor);
    const now = new Date();
    // Abschlussanfragen entscheidet nur die Administratorrolle (14.09.2026); Görev-Talepe gibt es nicht mehr.
    const completionPart = actor.isSystemAdmin ? client_1.Prisma.sql `OR t.approvalState = 'PENDING'` : client_1.Prisma.empty;
    const deletePart = actor.canDelete ? client_1.Prisma.sql `OR t.deleteRequestedAt IS NOT NULL` : client_1.Prisma.empty;
    const partnerPart = actor.isSystemAdmin ? client_1.Prisma.sql `OR t.partnerRequestedAt IS NOT NULL` : client_1.Prisma.empty;
    const cores = await (0, taskRows_1.fetchTaskCores)(prisma_client_1.default, {
        where: client_1.Prisma.sql `${(0, taskRows_1.visibleTasksSql)(actor)} AND (FALSE ${completionPart} ${deletePart} ${partnerPart})`,
    });
    const { running, people } = await loadRunningSessionsAndPeople(actor, cores);
    const toCard = (core) => (0, taskRows_1.toTaskDetailDto)(core, actor, running.get(core.id) ?? [], now);
    return {
        completionRequests: actor.isSystemAdmin ? cores.filter((core) => core.approvalState === 'PENDING').map(toCard) : [],
        deleteRequests: actor.canDelete ? cores.filter((core) => core.deleteRequestedById).map(toCard) : [],
        partnerRequests: actor.isSystemAdmin ? cores.filter((core) => core.partnerRequestedById).map(toCard) : [],
        people,
        serverNow: now,
    };
};
exports.listTaskApprovals = listTaskApprovals;
/** Alle Messungen einer Aufgabe, abgeschlossene und laufende. */
const loadTaskSessions = (tenantId, taskId) => prisma_client_1.default.taskTimeSession.findMany({
    where: { tenantId, taskId },
    select: { employeeId: true, startedAt: true, endedAt: true, durationMs: true },
    orderBy: [{ startedAt: 'asc' }],
});
exports.loadTaskSessions = loadTaskSessions;
/** Dauer einer Messung — eine laufende zählt bis `now`. */
const sessionMs = (session, now) => session.endedAt ? session.durationMs ?? 0 : (0, taskTime_1.liveDurationMs)(session.startedAt, now);
/**
 * Wer wie lange an der Aufgabe gearbeitet hat (Görevly `timer.breakdown`),
 * meiste Zeit zuerst. Summen werden NICHT auf die INT-Grenze einer einzelnen
 * Messung gekürzt — viele Personen über Monate überschreiten sie zu Recht.
 */
/**
 * KEINE laufende Zeit (14.09.2026, Samet: «kronometre olmayacak, sadece
 * çalışılıyor»): eine laufende Messung setzt nur `live` und zählt nichts —
 * weder `ms` noch `dayMs`. Ihre Dauer entsteht beim Pausieren (Stopp − Start).
 * `ownEmployeeId` bleibt für ältere Aufrufer erhalten und ändert nichts mehr.
 */
const buildWorkDto = (sessions, now, day = (0, taskTime_1.resolveDayWindow)(undefined, undefined, now), ownEmployeeId) => {
    const byPerson = new Map();
    let closedMs = 0;
    let liveMs = 0;
    let dayMs = 0;
    for (const session of sessions) {
        const live = session.endedAt === null;
        void ownEmployeeId;
        const ms = live ? 0 : sessionMs(session, now);
        const inDay = live ? 0 : (0, taskTime_1.windowedMs)(session.startedAt, session.endedAt, day, now);
        const last = session.endedAt ?? now;
        if (live)
            liveMs += ms;
        else
            closedMs += ms;
        dayMs += inDay;
        const entry = byPerson.get(session.employeeId)
            ?? { employeeId: session.employeeId, ms: 0, dayMs: 0, sessions: 0, first: session.startedAt, last, live: false };
        entry.ms += ms;
        entry.dayMs += inDay;
        if (live)
            entry.live = true;
        else
            entry.sessions += 1;
        if (session.startedAt.getTime() < entry.first.getTime())
            entry.first = session.startedAt;
        if (last.getTime() > entry.last.getTime())
            entry.last = last;
        byPerson.set(session.employeeId, entry);
    }
    return {
        totalMs: closedMs + liveMs,
        closedMs,
        liveMs,
        dayMs,
        breakdown: [...byPerson.values()].sort((a, b) => b.dayMs - a.dayMs || b.ms - a.ms),
    };
};
exports.buildWorkDto = buildWorkDto;
/** Verknüpfte Räume, in denen ich Mitglied bin — auch die Leitung sieht nur ihre (Görevly). */
const loadLinkedChatRooms = (actor, taskId) => prisma_client_1.default.taskChatRoom.findMany({
    where: {
        tenantId: actor.tenantId,
        taskLinks: { some: { taskId } },
        members: { some: { employeeId: actor.employeeId } },
    },
    select: { id: true, name: true },
    orderBy: [{ name: 'asc' }],
});
const activePersonRef = (person) => ({
    id: person.id,
    firstName: person.firstName,
    lastName: person.lastName,
    name: `${person.firstName} ${person.lastName}`.trim(),
    title: person.title,
    active: true,
});
const getTaskDetail = async (actor, taskId, day) => {
    /* Aufgabe und alle Teile in EINEM parallelen Schritt (14.09.2026, Samet:
       «görev detayı 350 ms, max 200–250»). Früher lief die Sichtbarkeit als
       eigener Rundgang davor. Jede Teilabfrage ist auf die Firma beschränkt;
       ist die Aufgabe nicht sichtbar, verlässt nichts davon den Server —
       die Prüfung steht vor der Antwort. */
    const [visible, content, checklists, attachments, comments, chatRooms, sessions, directory] = await Promise.all([
        (0, taskRows_1.requireVisibleTask)(prisma_client_1.default, actor, taskId),
        (0, taskParts_1.loadTaskContent)(prisma_client_1.default, actor.tenantId, taskId),
        (0, taskParts_1.loadTaskChecklists)(prisma_client_1.default, actor.tenantId, taskId),
        (0, taskParts_1.loadTaskAttachments)(prisma_client_1.default, actor.tenantId, taskId),
        (0, commentService_1.loadVisibleTaskComments)(actor, taskId),
        loadLinkedChatRooms(actor, taskId),
        (0, exports.loadTaskSessions)(actor.tenantId, taskId),
        (0, taskPeople_1.getTasksPeople)(actor.tenantId),
    ]);
    const { core, permissions } = visible;
    const now = new Date();
    const running = sessions
        .filter((session) => session.endedAt === null)
        .map((session) => ({ employeeId: session.employeeId, startedAt: session.startedAt }));
    // Leitung: alle Personen; Teammitglied: nur die eigenen Messungen (14.09.2026).
    const ownSessions = sessions.filter((session) => session.employeeId === actor.employeeId);
    const work = (0, exports.buildWorkDto)(actor.isManager ? sessions : ownSessions, now, day ?? (0, taskTime_1.resolveDayWindow)(undefined, undefined, now), actor.employeeId);
    const ownClosedMs = actor.isManager ? undefined : ownSessions.reduce((sum, session) => sum + (session.endedAt ? session.durationMs ?? 0 : 0), 0);
    // Prognose aus denselben Checklisten, die die Antwort zeigt; sie nennt keine Zeiten.
    const forecast = (0, taskForecast_1.computeTaskForecast)({
        status: core.status,
        completedAt: core.completedAt,
        dueAt: core.dueAt,
        checkTotal: checklists.reduce((sum, list) => sum + list.progress.total, 0),
        checkDone: checklists.reduce((sum, list) => sum + list.progress.done, 0),
        sessions: sessions.map((session) => ({ startedAt: session.startedAt, ms: sessionMs(session, now) })),
        now,
    });
    const personIds = [...new Set([
            ...(0, taskRows_1.taskPeopleIds)(core, actor.isManager ? running : []),
            content.updatedById,
            ...checklists.flatMap((list) => [
                list.createdById,
                ...list.items.flatMap((item) => [item.assigneeId, item.doneById, item.createdById]),
            ]),
            ...attachments.map((attachment) => attachment.uploadedById),
            ...comments.personIds,
            ...(work?.breakdown.map((entry) => entry.employeeId) ?? []),
        ].filter((id) => typeof id === 'string' && id.length > 0))];
    const people = {};
    for (const id of personIds) {
        const person = directory.get(id);
        if (person)
            people[id] = activePersonRef(person);
    }
    // Historische Eintraege behalten den Namen auch nach Austritt/Loeschung.
    // Im Normalfall ist alles bereits im 30-s-Verzeichnis: kein weiterer RTT.
    const historicalIds = personIds.filter((id) => !people[id]);
    if (historicalIds.length)
        Object.assign(people, await (0, taskPeople_1.loadPersonRefs)(historicalIds));
    return {
        task: (0, taskRows_1.toTaskDetailDto)(core, actor, running, now, ownClosedMs),
        permissions,
        content,
        checklists,
        attachments,
        comments: comments.data,
        chatRooms,
        forecast,
        work,
        people,
        serverNow: now,
    };
};
exports.getTaskDetail = getTaskDetail;
/** Die im Verlauf genannte Person (ASSIGNED/UNASSIGNED, Pause einer anderen Person). */
const activityEmployeeId = (meta) => {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta))
        return null;
    const employeeId = meta.employeeId;
    return typeof employeeId === 'string' ? employeeId : null;
};
const listTaskActivity = async (actor, taskId) => {
    (0, taskActor_1.assertManager)(actor);
    const [task, rows] = await Promise.all([
        prisma_client_1.default.task.findFirst({ where: { id: taskId, tenantId: actor.tenantId }, select: { id: true } })
            // Sichtbarkeit wie überall: keine fremde Aufgabe, auch nicht ihr Verlauf.
            .then(async (found) => (found ? (await (0, taskRows_1.requireVisibleTask)(prisma_client_1.default, actor, taskId)).core : null)),
        prisma_client_1.default.taskActivity.findMany({
            where: { tenantId: actor.tenantId, taskId },
            select: { id: true, type: true, actorId: true, meta: true, createdAt: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: taskConstants_1.TASK_LIMITS.activityLimit,
        }),
    ]);
    if (!task)
        throw (0, taskErrors_1.taskNotFound)();
    const people = await (0, taskPeople_1.loadPersonRefs)(rows.flatMap((row) => [row.actorId, activityEmployeeId(row.meta)]));
    return { data: rows, people };
};
exports.listTaskActivity = listTaskActivity;
//# sourceMappingURL=taskQueries.js.map