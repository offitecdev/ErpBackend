import { createHash } from 'crypto';
import { nanoid } from 'nanoid';

import prisma from '../../../infrastructure/database/prisma.client';
import type { TasksActor } from './taskActor';
import { ACTIVITY } from './taskConstants';
import { runTasksTransaction } from './taskDb';
import { logTaskActivity } from './taskActivity';

/**
 * Every person who can open the tasks module receives one real first task.
 * The deterministic id makes creation idempotent across browsers and concurrent
 * bootstrap/list requests without adding a second onboarding-state table.
 */
export const TASK_ONBOARDING_VERSION = 'tasks-intro-v1';

const onboardingTaskId = (actor: Pick<TasksActor, 'tenantId' | 'employeeId'>): string => {
    const owner = createHash('sha256')
        .update(`${TASK_ONBOARDING_VERSION}\0${actor.tenantId}\0${actor.employeeId}`)
        .digest('hex')
        .slice(0, 24);
    return `tasks-welcome-${owner}`;
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

/** Creates the first task lazily for every module user, exactly once per tenant. */
export const ensureTaskOnboarding = async (actor: TasksActor): Promise<TaskOnboardingDto> => {
    const taskId = onboardingTaskId(actor);
    const existing = await prisma.task.findFirst({
        where: { id: taskId, tenantId: actor.tenantId, createdById: actor.employeeId },
        select: { status: true },
    });
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

/** Finishing the walkthrough completes its real task and all tutorial steps. */
export const completeTaskOnboarding = async (actor: TasksActor): Promise<TaskOnboardingDto> => {
    const taskId = onboardingTaskId(actor);
    await ensureTaskOnboarding(actor);
    const now = new Date();

    await runTasksTransaction(async (tx) => {
        const task = await tx.task.findFirst({
            where: { id: taskId, tenantId: actor.tenantId, createdById: actor.employeeId },
            select: { status: true },
        });
        if (!task || task.status === 'COMPLETED') return;
        await tx.taskChecklistItem.updateMany({
            where: { tenantId: actor.tenantId, taskId, done: false },
            data: { done: true, doneAt: now, doneById: actor.employeeId },
        });
        await tx.task.update({
            where: { id: taskId },
            data: {
                status: 'COMPLETED',
                completedAt: now,
                approvalState: 'APPROVED',
                approvalDecidedById: actor.employeeId,
                approvalDecidedAt: now,
            },
            select: { id: true },
        });
        await logTaskActivity(tx, actor.tenantId, null, {
            taskId,
            type: ACTIVITY.STATUS,
            meta: { from: task.status, to: 'COMPLETED', system: true, version: TASK_ONBOARDING_VERSION },
        });
    });

    return toDto(actor, taskId, 'COMPLETED');
};
