import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';

import type { TasksDb } from './taskDb';
import type { ActivityType } from './taskConstants';

/**
 * ── VERLAUF («Geçmiş») ──────────────────────────────────────────────────────
 *
 * Eine Zeile je Ereignis an einer Aufgabe; nur die Leitung liest sie. `meta`
 * trägt, was die Oberfläche für ihren Satz braucht (Görevly-Form):
 *   CREATED {title} · UPDATED {fields, before} · STATUS {from, to, reason?}
 *   ASSIGNED/UNASSIGNED {employeeId} · ATTACHMENT {count}
 *   TIMER_PAUSE {ms, employeeId?, note?, auto?} · CHECK_DONE/CHECK_UNDONE {text}
 *   CHECKLIST_ADD {title} · COMPLETION_… und REVIEW_… {note?} · BLOCKED {reason}
 *   DUPLICATED {fromTaskId}
 * Freitext in `meta` wird gekürzt — der Verlauf ist kein zweiter Speicher.
 */

export interface ActivityEntry {
    taskId: string;
    type: ActivityType;
    meta?: Record<string, unknown> | null;
    /** Abweichende handelnde Person (sonst die des Aufrufs). */
    actorId?: string | null;
}

const trimMeta = (meta: Record<string, unknown>): Prisma.InputJsonValue => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(meta)) {
        if (value === undefined) continue;
        out[key] = typeof value === 'string' ? value.slice(0, 500) : value;
    }
    return out as Prisma.InputJsonValue;
};

export const logTaskActivities = async (
    db: TasksDb,
    tenantId: string,
    actorId: string | null,
    entries: ActivityEntry[],
): Promise<void> => {
    if (!entries.length) return;
    await db.taskActivity.createMany({
        data: entries.map((entry) => ({
            id: nanoid(12),
            tenantId,
            taskId: entry.taskId,
            actorId: entry.actorId === undefined ? actorId : entry.actorId,
            type: entry.type,
            ...(entry.meta ? { meta: trimMeta(entry.meta) } : {}),
        })),
    });
};

export const logTaskActivity = (
    db: TasksDb,
    tenantId: string,
    actorId: string | null,
    entry: ActivityEntry,
): Promise<void> => logTaskActivities(db, tenantId, actorId, [entry]);
