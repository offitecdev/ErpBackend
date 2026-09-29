import { nanoid } from 'nanoid';

import prisma from '../database/prisma.client';
import type { ProductionTaskArea } from '../../domain/entities/ProductionTask';
import type { IProductionTaskNotifier } from '../../domain/repositories/IProductionTaskRepository';
import { isBuiltInArea } from '../../domain/services/productionTasks';

/**
 * ── DIE GLOCKE DER GÖREVLENDİRME (26.09.2026, Vorgabe Samet) ────────────────
 *
 * «Bu görevlere yüklendiğinde ve kişilere özel atandığında gelmesi lazım.»
 *
 * Wer NEU in einer Aufgabe eines Geräts steht — durch das Laden einer Vorlage
 * oder durch eine Zuweisung —, bekommt EINE Nachricht je Vorgang, mit seinen
 * Aufgaben darin. Nie die auslösende Person selbst, nie inaktive Konten.
 * Der Verweis öffnet das Gerät im richtigen Bereich und — wenn alle
 * Aufgaben dort liegen — auf der richtigen Stufe.
 *
 * Text wie bei den übrigen Ereignissen: deutscher Ersatztext in
 * `title`/`message`, Schlüssel + Werte in `metadata.i18n` — die Oberfläche
 * baut den Satz in der Sprache der lesenden Person.
 *
 * Wirft nie: eine Zuweisung darf an einer Nachricht nicht scheitern.
 */

/** Die Adresse schreibt die festen Bereiche klein (`?area=electrical`), eigene mit ihrer Kennung. */
const areaParam = (area: ProductionTaskArea): string => (isBuiltInArea(area) ? area.toLowerCase() : area);

export class ProductionTaskNotifier implements IProductionTaskNotifier {
    async assigned(input: Parameters<IProductionTaskNotifier['assigned']>[0]): Promise<void> {
        try {
            const entries = [...input.news.entries()].filter(([id, tasks]) => id !== input.actorId && tasks.length > 0);
            if (!entries.length) return;
            const active = await prisma.employee.findMany({
                where: { id: { in: entries.map(([id]) => id) }, isActive: true, deletedAt: null, bannedAt: null },
                select: { id: true },
            });
            const activeIds = new Set(active.map((row) => row.id));
            const actor = input.actorName ?? '';
            const { device } = input;

            const data = entries
                .filter(([id]) => activeIds.has(id))
                .flatMap(([recipientEmployeeId, tasks]) => {
                    const [first] = tasks;
                    if (!first) return [];
                    const oneArea = tasks.every((task) => task.area === first.area);
                    const oneStage = oneArea && tasks.every((task) => task.stage === first.stage);
                    const query = new URLSearchParams();
                    if (oneArea) query.set('area', areaParam(first.area));
                    if (oneStage) query.set('stage', first.stage);
                    const search = query.toString();
                    const list = tasks.length === 1
                        ? `${first.code} ${first.name}`
                        : `${tasks.slice(0, 4).map((task) => task.code).join(', ')}${tasks.length > 4 ? ` +${tasks.length - 4}` : ''}`;
                    const where = `${device.name} (${device.projectNumber})`;
                    return [{
                        id: nanoid(12),
                        tenantId: input.tenantId,
                        recipientEmployeeId,
                        type: 'PRODUCTION_TASK_ASSIGNED',
                        title: 'Produktion: Aufgabe zugewiesen',
                        message: `${actor || 'Die Verwaltung'} hat Ihnen zugewiesen: ${list} — ${where}.`,
                        linkUrl: `/production/orders/${encodeURIComponent(device.productionProjectId)}/devices/${encodeURIComponent(device.id)}${search ? `?${search}` : ''}`,
                        metadata: {
                            i18n: {
                                key: 'notify.productionTaskAssigned',
                                params: { actor, tasks: list, count: tasks.length, device: device.name, project: device.projectNumber },
                            },
                            productionItemId: device.id,
                            productionProjectId: device.productionProjectId,
                        },
                    }];
                });
            if (data.length) await prisma.notification.createMany({ data });
        } catch (error) {
            console.warn('[üretim] Glocke (Görevlendirme) fehlgeschlagen:', (error as Error)?.message ?? error);
        }
    }

    /**
     * Neue Pflichten (28.09.2026): begonnene Unteraufgaben sind wieder offen —
     * EINE Nachricht je Person der Aufgabe mit ihren Unteraufgaben darin; sie
     * prüft neu (▶) und schliesst wieder ab. Nie die auslösende Person selbst.
     */
    async reopened(input: Parameters<IProductionTaskNotifier['reopened']>[0]): Promise<void> {
        try {
            const byRecipient = new Map<string, typeof input.subtasks[number][]>();
            for (const subtask of input.subtasks) {
                for (const id of subtask.recipients) {
                    if (id === input.actorId) continue;
                    byRecipient.set(id, [...(byRecipient.get(id) ?? []), subtask]);
                }
            }
            if (!byRecipient.size) return;
            const active = await prisma.employee.findMany({
                where: { id: { in: [...byRecipient.keys()] }, isActive: true, deletedAt: null, bannedAt: null },
                select: { id: true },
            });
            const activeIds = new Set(active.map((row) => row.id));
            const actor = input.actorName ?? '';
            const { device } = input;
            const where = `${device.name} (${device.projectNumber})`;

            const data = [...byRecipient.entries()]
                .filter(([id]) => activeIds.has(id))
                .flatMap(([recipientEmployeeId, subtasks]) => {
                    const [first] = subtasks;
                    if (!first) return [];
                    const oneArea = subtasks.every((entry) => entry.area === first.area);
                    const oneStage = oneArea && subtasks.every((entry) => entry.stage === first.stage);
                    const query = new URLSearchParams();
                    if (oneArea) query.set('area', areaParam(first.area));
                    if (oneStage) query.set('stage', first.stage);
                    const search = query.toString();
                    const list = subtasks.length === 1
                        ? `${first.code} ${first.name}`
                        : `${subtasks.slice(0, 4).map((entry) => entry.code).join(', ')}${subtasks.length > 4 ? ` +${subtasks.length - 4}` : ''}`;
                    return [{
                        id: nanoid(12),
                        tenantId: input.tenantId,
                        recipientEmployeeId,
                        type: 'PRODUCTION_SUBTASK_REOPENED',
                        title: 'Produktion: Unteraufgabe neu zu prüfen',
                        message: `${actor || 'Die Verwaltung'} hat neue Pflichten ergänzt — bitte neu prüfen und abschliessen: ${list} — ${where}.`,
                        linkUrl: `/production/orders/${encodeURIComponent(device.productionProjectId)}/devices/${encodeURIComponent(device.id)}${search ? `?${search}` : ''}`,
                        metadata: {
                            i18n: {
                                key: 'notify.productionSubtaskReopened',
                                params: { actor, tasks: list, count: subtasks.length, device: device.name, project: device.projectNumber },
                            },
                            productionItemId: device.id,
                            productionProjectId: device.productionProjectId,
                        },
                    }];
                });
            if (data.length) await prisma.notification.createMany({ data });
        } catch (error) {
            console.warn('[üretim] Glocke (wieder geöffnet) fehlgeschlagen:', (error as Error)?.message ?? error);
        }
    }
}
