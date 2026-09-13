import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';

import prisma from '../../database/prisma.client';
import { isModuleEnabledForTenant } from '../../../shared/tenantModules';
import {
    DEFAULT_REMINDER_LEAD_MINUTES,
    NOTIFY,
    TASKS_MODULE_KEY,
    taskLinkUrl,
    type NotifyType,
    type ReminderKind,
} from '../../../application/services/tasks/taskConstants';
import { notifyTaskPeople } from '../../../application/services/tasks/taskNotify';

/**
 * ── ERINNERUNGSSCHLEIFE DES GÖREVLER-MODULS ─────────────────────────────────
 *
 * Görevly prüfte alle 30 s im Browser (notify.js) — nur solange ein Tab offen
 * war, und mit einem Gedächtnis, das beim Neuladen verschwand. Hier läuft es
 * auf dem Server, jede Minute:
 *   REMINDER        Erinnerungszeit erreicht (bis 6 h rückwirkend)
 *   DUE_SOON        Ende naht — Vorlauf je EMPFÄNGER (TaskUserSetting, sonst 30 min)
 *   OVERDUE         Ende überschritten (bis 24 h rückwirkend — kein Schwall nach Stillstand)
 *   CHECK_REMINDER  Erinnerung eines offenen Checklistenpunkts
 * Empfänger: Verantwortliche ∪ Anlegende; beim Checklistenpunkt dessen Person,
 * sonst die erste Verantwortliche. Nur offene Aufgaben.
 *
 * GENAU EINMAL: jede Meldung wird zuerst als Zeile in TaskNotifyDispatch
 * «beansprucht» — eindeutig je (Art, Ziel, Person, Termin). `INSERT IGNORE …
 * SELECT` schreibt nur, was noch nicht da ist, und markiert es mit dem
 * Losungswort dieses Laufs; gelesen wird danach genau diese Losung. Das hält
 * auch bei zwei Serverinstanzen, und ein verschobener Termin ist von selbst
 * wieder scharf (er steht im Schlüssel).
 *
 * Die Zeit kommt als Parameter aus dem Programm, nicht NOW() der Datenbank —
 * dieselbe Uhr, mit der die Termine geschrieben wurden.
 */

const TICK_MS = 60_000;
const FIRST_TICK_MS = 20_000;
const CLEANUP_EVERY_MS = 60 * 60_000;
const CLAIM_LIMIT = 500;
const REMINDER_WINDOW_MS = 6 * 3_600_000;
const OVERDUE_WINDOW_MS = 24 * 3_600_000;
const DISPATCH_RETENTION_DAYS = 45;
/** Grösster erlaubter Vorlauf (REMINDER_LEAD_MINUTES) — grenzt die Abfrage vorab ein. */
const MAX_LEAD_MS = 120 * 60_000;

const OPEN_TASK_SQL = Prisma.sql`t.status NOT IN ('COMPLETED', 'REJECTED')`;

let started = false;
let running = false;
let lastCleanupAt = 0;

interface ClaimedRow {
    tenantId: string;
    kind: ReminderKind;
    targetId: string;
    recipientId: string;
}

/** Zwei Zielgruppen einer Aufgabe: Verantwortliche und Anlegende. */
const taskAudiences = (): Array<{ join: Prisma.Sql; recipient: Prisma.Sql }> => [
    { join: Prisma.sql`JOIN TaskAssignee a ON a.taskId = t.id`, recipient: Prisma.sql`a.employeeId` },
    { join: Prisma.empty, recipient: Prisma.sql`t.createdById` },
];

const claimTaskKind = async (
    kind: Exclude<ReminderKind, 'CHECK_REMINDER'>,
    batch: string,
    now: Date,
): Promise<void> => {
    for (const audience of taskAudiences()) {
        let dueColumn: Prisma.Sql;
        let lead = Prisma.empty;
        let window: Prisma.Sql;
        if (kind === 'REMINDER') {
            dueColumn = Prisma.sql`t.reminderAt`;
            window = Prisma.sql`t.reminderAt <= ${now} AND t.reminderAt > ${new Date(now.getTime() - REMINDER_WINDOW_MS)}`;
        } else if (kind === 'DUE_SOON') {
            dueColumn = Prisma.sql`t.dueAt`;
            lead = Prisma.sql`LEFT JOIN TaskUserSetting s ON s.employeeId = ${audience.recipient}`;
            window = Prisma.sql`t.dueAt > ${now}
                AND t.dueAt <= ${new Date(now.getTime() + MAX_LEAD_MS)}
                AND t.dueAt <= DATE_ADD(${now}, INTERVAL COALESCE(s.reminderLeadMinutes, ${DEFAULT_REMINDER_LEAD_MINUTES}) MINUTE)`;
        } else {
            dueColumn = Prisma.sql`t.dueAt`;
            window = Prisma.sql`t.dueAt < ${now} AND t.dueAt > ${new Date(now.getTime() - OVERDUE_WINDOW_MS)}`;
        }
        await prisma.$executeRaw(Prisma.sql`
            INSERT IGNORE INTO TaskNotifyDispatch (id, tenantId, kind, targetId, recipientId, dueAt, batch, firedAt)
            SELECT UUID(), t.tenantId, ${kind}, t.id, ${audience.recipient}, ${dueColumn}, ${batch}, ${now}
            FROM Task t
            ${audience.join}
            ${lead}
            WHERE ${OPEN_TASK_SQL} AND ${window}
            LIMIT ${CLAIM_LIMIT}
        `);
    }
};

const claimChecklistReminders = async (batch: string, now: Date): Promise<void> => {
    await prisma.$executeRaw(Prisma.sql`
        INSERT IGNORE INTO TaskNotifyDispatch (id, tenantId, kind, targetId, recipientId, dueAt, batch, firedAt)
        SELECT UUID(), x.tenantId, 'CHECK_REMINDER', x.id, x.recipientId, x.reminderAt, ${batch}, ${now}
        FROM (
            SELECT i.id, i.tenantId, i.reminderAt,
                   COALESCE(i.assigneeId, (
                       SELECT fa.employeeId FROM TaskAssignee fa
                       WHERE fa.taskId = i.taskId
                       ORDER BY fa.createdAt, fa.id
                       LIMIT 1
                   )) AS recipientId
            FROM TaskChecklistItem i
            JOIN Task t ON t.id = i.taskId
            WHERE i.done = 0
              AND i.reminderAt <= ${now}
              AND i.reminderAt > ${new Date(now.getTime() - REMINDER_WINDOW_MS)}
              AND ${OPEN_TASK_SQL}
        ) x
        WHERE x.recipientId IS NOT NULL
        LIMIT ${CLAIM_LIMIT}
    `);
};

const readClaims = (batch: string): Promise<ClaimedRow[]> =>
    prisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
        SELECT tenantId, kind, targetId, recipientId FROM TaskNotifyDispatch WHERE batch = ${batch}
    `);

const NOTIFY_BY_KIND: Record<ReminderKind, NotifyType> = {
    REMINDER: NOTIFY.REMINDER,
    DUE_SOON: NOTIFY.DUE_SOON,
    OVERDUE: NOTIFY.OVERDUE,
    CHECK_REMINDER: NOTIFY.CHECK_REMINDER,
};

const TEXT_BY_KIND: Record<Exclude<ReminderKind, 'CHECK_REMINDER'>, (title: string) => { title: string; message: string }> = {
    REMINDER: (title) => ({ title: 'Erinnerung', message: `«${title}»` }),
    DUE_SOON: (title) => ({ title: 'Termin naht', message: `«${title}» endet bald.` }),
    OVERDUE: (title) => ({ title: 'Aufgabe überfällig', message: `«${title}» hat den Termin überschritten.` }),
};

/** Beanspruchte Zeilen in Meldungen verwandeln — eine je (Firma, Art, Ziel). */
const dispatchClaims = async (claims: ClaimedRow[]): Promise<number> => {
    if (!claims.length) return 0;

    const taskIds = [...new Set(claims.filter((row) => row.kind !== 'CHECK_REMINDER').map((row) => row.targetId))];
    const itemIds = [...new Set(claims.filter((row) => row.kind === 'CHECK_REMINDER').map((row) => row.targetId))];
    const [tasks, items] = await Promise.all([
        taskIds.length
            ? prisma.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, title: true, dueAt: true } })
            : Promise.resolve([]),
        itemIds.length
            ? prisma.taskChecklistItem.findMany({
                where: { id: { in: itemIds } },
                select: { id: true, text: true, taskId: true, task: { select: { title: true } } },
            })
            : Promise.resolve([]),
    ]);
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const itemById = new Map(items.map((item) => [item.id, item]));

    const groups = new Map<string, { row: ClaimedRow; recipients: string[] }>();
    for (const row of claims) {
        const key = `${row.tenantId}|${row.kind}|${row.targetId}`;
        const group = groups.get(key) ?? { row, recipients: [] };
        group.recipients.push(row.recipientId);
        groups.set(key, group);
    }

    const enabledByTenant = new Map<string, boolean>();
    let sent = 0;
    for (const { row, recipients } of groups.values()) {
        if (!enabledByTenant.has(row.tenantId)) {
            enabledByTenant.set(row.tenantId, await isModuleEnabledForTenant(row.tenantId, TASKS_MODULE_KEY));
        }
        if (!enabledByTenant.get(row.tenantId)) continue;

        if (row.kind === 'CHECK_REMINDER') {
            const item = itemById.get(row.targetId);
            if (!item) continue;
            const taskTitle = item.task.title;
            sent += await notifyTaskPeople({
                tenantId: row.tenantId,
                type: NOTIFY_BY_KIND[row.kind],
                recipientIds: recipients,
                actorId: null,
                title: 'Checklisten-Erinnerung',
                message: `«${item.text}» — ${taskTitle}`,
                linkUrl: taskLinkUrl(item.taskId),
                params: { item: item.text, title: taskTitle },
                meta: { taskId: item.taskId, itemId: item.id, kind: row.kind },
            });
            continue;
        }

        const task = taskById.get(row.targetId);
        if (!task) continue;
        const text = TEXT_BY_KIND[row.kind](task.title);
        sent += await notifyTaskPeople({
            tenantId: row.tenantId,
            type: NOTIFY_BY_KIND[row.kind],
            recipientIds: recipients,
            actorId: null,
            title: text.title,
            message: text.message,
            linkUrl: taskLinkUrl(task.id),
            params: { title: task.title, dueAt: task.dueAt ? task.dueAt.toISOString() : null },
            meta: { taskId: task.id, kind: row.kind },
        });
    }
    return sent;
};

const cleanupDispatches = async (now: Date): Promise<void> => {
    if (now.getTime() - lastCleanupAt < CLEANUP_EVERY_MS) return;
    lastCleanupAt = now.getTime();
    await prisma.$executeRaw(Prisma.sql`
        DELETE FROM TaskNotifyDispatch
        WHERE firedAt < ${new Date(now.getTime() - DISPATCH_RETENTION_DAYS * 86_400_000)}
    `);
};

/** EIN Lauf — auch für Prüfskripte. Wirft nie; gibt die Zahl der Meldungen zurück. */
export const runTasksReminderTick = async (now: Date = new Date()): Promise<number> => {
    if (running) return 0;
    running = true;
    let sent = 0;
    try {
        for (const kind of ['REMINDER', 'DUE_SOON', 'OVERDUE', 'CHECK_REMINDER'] as const) {
            const batch = nanoid(16);
            try {
                if (kind === 'CHECK_REMINDER') await claimChecklistReminders(batch, now);
                else await claimTaskKind(kind, batch, now);
                sent += await dispatchClaims(await readClaims(batch));
            } catch (error) {
                console.warn(`[tasks.reminders] ${kind} fehlgeschlagen`, error);
            }
        }
        await cleanupDispatches(now).catch((error) => console.warn('[tasks.reminders] Aufräumen fehlgeschlagen', error));
    } finally {
        running = false;
    }
    return sent;
};

export const startTasksReminderEngine = (): void => {
    if (started || process.env.OFFITEC_DISABLE_REMINDERS === 'true') return;
    started = true;
    const tick = () => {
        void runTasksReminderTick();
    };
    setTimeout(tick, FIRST_TICK_MS).unref?.();
    setInterval(tick, TICK_MS).unref?.();
};
