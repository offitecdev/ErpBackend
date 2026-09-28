"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductionTaskNotifier = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
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
const areaParam = (area) => (area === 'ELECTRICAL' ? 'electrical' : 'mechanical');
class ProductionTaskNotifier {
    async assigned(input) {
        try {
            const entries = [...input.news.entries()].filter(([id, tasks]) => id !== input.actorId && tasks.length > 0);
            if (!entries.length)
                return;
            const active = await prisma_client_1.default.employee.findMany({
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
                if (!first)
                    return [];
                const oneArea = tasks.every((task) => task.area === first.area);
                const oneStage = oneArea && tasks.every((task) => task.stage === first.stage);
                const query = new URLSearchParams();
                if (oneArea)
                    query.set('area', areaParam(first.area));
                if (oneStage)
                    query.set('stage', first.stage);
                const search = query.toString();
                const list = tasks.length === 1
                    ? `${first.code} ${first.name}`
                    : `${tasks.slice(0, 4).map((task) => task.code).join(', ')}${tasks.length > 4 ? ` +${tasks.length - 4}` : ''}`;
                const where = `${device.name} (${device.projectNumber})`;
                return [{
                        id: (0, nanoid_1.nanoid)(12),
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
            if (data.length)
                await prisma_client_1.default.notification.createMany({ data });
        }
        catch (error) {
            console.warn('[üretim] Glocke (Görevlendirme) fehlgeschlagen:', error?.message ?? error);
        }
    }
}
exports.ProductionTaskNotifier = ProductionTaskNotifier;
//# sourceMappingURL=productionTaskNotifications.js.map