import { nanoid } from 'nanoid';

import prisma from '../database/prisma.client';
import type { ProductionTaskArea } from '../../domain/entities/ProductionTask';
import type { IProductionTaskNotifier } from '../../domain/repositories/IProductionTaskRepository';

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

const areaParam = (area: ProductionTaskArea): string => (area === 'ELECTRICAL' ? 'electrical' : 'mechanical');

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
}
