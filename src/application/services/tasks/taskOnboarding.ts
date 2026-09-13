import { createHash } from 'crypto';
import { nanoid } from 'nanoid';

import { Prisma } from '@prisma/client';

import prisma from '../../../infrastructure/database/prisma.client';
import type { TasksActor } from './taskActor';
import { ACTIVITY } from './taskConstants';
import { runTasksTransaction, type TasksDb } from './taskDb';
import { logTaskActivity } from './taskActivity';
import { collectAttachmentRefs, removeStoredFiles } from './taskFiles';
import { taskBadRequest } from './taskErrors';

/**
 * Every person who can open the tasks module receives one real first task.
 * The deterministic id makes creation idempotent across browsers and concurrent
 * bootstrap/list requests.
 *
 * Rules for this guide task only (Samet, 14.09.2026):
 * - no chat room can be created for it or linked to it;
 * - once completed it is DELETED. `TaskUserSetting.onboardingDoneVersion`
 *   remembers that, otherwise the next bootstrap would create it again.
 */
export const TASK_ONBOARDING_VERSION = 'tasks-intro-v1';

const ONBOARDING_TASK_PREFIX = 'tasks-welcome-';

export const isOnboardingTaskId = (taskId: string): boolean => taskId.startsWith(ONBOARDING_TASK_PREFIX);

export const assertNotOnboardingTasks = (taskIds: readonly string[]): void => {
    const blocked = taskIds.filter(isOnboardingTaskId);
    if (blocked.length) {
        throw taskBadRequest('ONBOARDING_TASK_NO_CHAT', 'Für die Einführungsaufgabe gibt es keinen Chat-Raum.', { taskIds: blocked });
    }
};

const onboardingTaskId = (actor: Pick<TasksActor, 'tenantId' | 'employeeId'>): string => {
    const owner = createHash('sha256')
        .update(`${TASK_ONBOARDING_VERSION}\0${actor.tenantId}\0${actor.employeeId}`)
        .digest('hex')
        .slice(0, 24);
    return `${ONBOARDING_TASK_PREFIX}${owner}`;
};

export interface TaskOnboardingDto {
    taskId: string;
    completed: boolean;
    version: string;
    guide: 'admin' | 'member';
}

const toDto = (actor: TasksActor, taskId: string, status: string): TaskOnboardingDto => ({
    taskId,
    completed: status === 'COMPLETED',
    version: TASK_ONBOARDING_VERSION,
    guide: actor.isSystemAdmin ? 'admin' : 'member',
});

const readDoneVersion = async (db: TasksDb, employeeId: string): Promise<string | null> => {
    const rows = await db.$queryRaw<Array<{ v: string | null }>>(Prisma.sql`
        SELECT onboardingDoneVersion AS v FROM TaskUserSetting WHERE employeeId = ${employeeId} LIMIT 1
    `);
    return rows[0]?.v ?? null;
};

/** Marks the guide as done and deletes its task (files leave the storage afterwards). */
const finishAndDelete = async (actor: TasksActor, taskId: string): Promise<void> => {
    const fileRefs = await runTasksTransaction(async (tx) => {
        const now = new Date();
        await tx.$executeRaw(Prisma.sql`
            INSERT INTO TaskUserSetting (id, employeeId, onboardingDoneVersion, createdAt, updatedAt)
            VALUES (${nanoid(12)}, ${actor.employeeId}, ${TASK_ONBOARDING_VERSION}, ${now}, ${now})
            ON DUPLICATE KEY UPDATE onboardingDoneVersion = ${TASK_ONBOARDING_VERSION}, updatedAt = ${now}
        `);
        const refs = await collectAttachmentRefs(tx, { tenantId: actor.tenantId, taskId });
        await tx.task.deleteMany({ where: { id: taskId, tenantId: actor.tenantId, createdById: actor.employeeId } });
        return refs;
    });
    await removeStoredFiles(fileRefs);
};

const createOnboardingTask = async (actor: TasksActor, taskId: string): Promise<void> => {
    const now = new Date();
    const checklistId = `${taskId}-steps`;
    const items = [
        'Görev kartını aç · Aufgabenkarte öffnen',
        'Başlat / duraklat ile süreyi takip et · Zeit mit Start / Pause erfassen',
        'Kontrol listesi, yorum ve dosyaları kullan · Checkliste, Kommentare und Dateien verwenden',
        'Tamamlama isteği gönder · Abschluss anfragen',
    ];

    await runTasksTransaction(async (tx) => {
        // Finished in a parallel request meanwhile: never bring the task back.
        if (await readDoneVersion(tx, actor.employeeId) === TASK_ONBOARDING_VERSION) return;
        await tx.task.create({
            data: {
                id: taskId,
                tenantId: actor.tenantId,
                title: 'İlk görevin: Görevleri keşfet · Erste Aufgabe: Aufgaben kennenlernen',
                description: 'Bu görev seni adım adım yönlendirir. / Diese Aufgabe führt dich Schritt für Schritt durch das Aufgabenmodul.',
                status: 'NOT_STARTED',
                priority: 'HIGH',
                origin: 'MANAGER',
                flagged: true,
                startAt: now,
                approvalState: 'NONE',
                reviewState: 'APPROVED',
                reviewDecidedAt: now,
                boardPosition: -1_000_000,
                createdById: actor.employeeId,
            },
            select: { id: true },
        });
        await tx.taskAssignee.create({
            data: { id: nanoid(12), tenantId: actor.tenantId, taskId, employeeId: actor.employeeId },
            select: { id: true },
        });
        await tx.taskChecklist.create({
            data: { id: checklistId, tenantId: actor.tenantId, taskId, title: 'Başlangıç · Einstieg', position: 0, createdById: actor.employeeId },
            select: { id: true },
        });
        await tx.taskChecklistItem.createMany({
            data: items.map((text, position) => ({
                id: `${taskId}-step-${position + 1}`,
                tenantId: actor.tenantId,
                taskId,
                checklistId,
                text,
                position,
                assigneeId: actor.employeeId,
                createdById: actor.employeeId,
            })),
        });
        await tx.taskContent.create({
            data: {
                id: `${taskId}-content`,
                tenantId: actor.tenantId,
                taskId,
                blocks: [
                    {
                        id: 'onboarding-intro',
                        type: 'p',
                        text: 'Görevler burada atanır, takip edilir ve tamamlanır. / Hier werden Aufgaben zugewiesen, bearbeitet und abgeschlossen.',
                        meta: {},
                    },
                    { id: 'onboarding-checklist', type: 'checklist', text: '', meta: { groupId: checklistId } },
                ],
                version: 1,
                updatedById: actor.employeeId,
            },
            select: { id: true },
        });
        await logTaskActivity(tx, actor.tenantId, null, {
            taskId,
            type: ACTIVITY.CREATED,
            meta: { title: 'Task module onboarding', system: true, version: TASK_ONBOARDING_VERSION },
        });
    });
};

/** Creates the first task lazily for every module user, until the guide is done. */
export const ensureTaskOnboarding = async (actor: TasksActor): Promise<TaskOnboardingDto> => {
    const taskId = onboardingTaskId(actor);
    const [doneVersion, existing] = await Promise.all([
        readDoneVersion(prisma, actor.employeeId),
        prisma.task.findFirst({
            where: { id: taskId, tenantId: actor.tenantId, createdById: actor.employeeId },
            select: { status: true },
        }),
    ]);
    if (doneVersion === TASK_ONBOARDING_VERSION && !existing) return toDto(actor, taskId, 'COMPLETED');
    // Completed by any other path (or before this rule existed): delete it now.
    if (existing?.status === 'COMPLETED' || (existing && doneVersion === TASK_ONBOARDING_VERSION)) {
        await finishAndDelete(actor, taskId);
        return toDto(actor, taskId, 'COMPLETED');
    }
    if (existing) return toDto(actor, taskId, existing.status);

    try {
        await createOnboardingTask(actor, taskId);
    } catch (error) {
        // Bootstrap and list can arrive together. If the sibling request won
        // the deterministic-id race, its row is the desired result.
        const raced = await prisma.task.findFirst({
            where: { id: taskId, tenantId: actor.tenantId, createdById: actor.employeeId },
            select: { status: true },
        });
        if (raced) return toDto(actor, taskId, raced.status);
        throw error;
    }
    return toDto(actor, taskId, 'NOT_STARTED');
};

/** Finishing the walkthrough ends the guide: its task is deleted, not kept as completed. */
export const completeTaskOnboarding = async (actor: TasksActor): Promise<TaskOnboardingDto> => {
    const taskId = onboardingTaskId(actor);
    await finishAndDelete(actor, taskId);
    return toDto(actor, taskId, 'COMPLETED');
};
