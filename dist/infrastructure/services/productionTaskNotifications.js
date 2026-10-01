"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductionTaskNotifier = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const productionTasks_1 = require("../../domain/services/productionTasks");
const RoleRepository_1 = require("../repositories/RoleRepository");
const serviceTenantScope_1 = require("../../presentation/controllers/serviceTenantScope");
/** Die Verwaltung der Firma (Administratorrolle im Firmenbaum), ohne die auslösende Person. */
const adminRecipients = async (tenantId, excludeId) => {
    const treeIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(tenantId);
    const rows = await prisma_client_1.default.employee.findMany({
        where: {
            ...(0, serviceTenantScope_1.employeeScopeWhere)(treeIds.length ? treeIds : [tenantId]),
            deletedAt: null,
            bannedAt: null,
            isActive: true,
            employeeRoles: { some: { role: { isSystemAdmin: true } } },
        },
        select: { id: true },
    });
    return [...new Set(rows.map((row) => row.id))].filter((id) => id !== excludeId);
};
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
const areaParam = (area) => ((0, productionTasks_1.isBuiltInArea)(area) ? area.toLowerCase() : area);
const roles = new RoleRepository_1.RoleRepository();
/**
 * Wer die Geräteseite öffnen darf (30.09.2026): die Verwaltung und wer die Produktion sieht.
 * Alle anderen arbeiten auf der Startseite («Görevlerim») — ihr Verweis führt dorthin.
 */
const deviceReaders = async (ids) => {
    const results = await Promise.all(ids.map(async (id) => {
        try {
            const [permissions, info] = await Promise.all([roles.getEmployeePermissions(id), roles.getEmployeeRoleInfo(id)]);
            return info.isSystemAdmin || permissions.includes('production.view') ? id : null;
        }
        catch {
            return null;
        }
    }));
    return new Set(results.filter((id) => id !== null));
};
/** Der Verweis einer Nachricht: das Gerät (mit Bereich/Stufe) — oder die Startseite. */
const linkFor = (readers, recipient, device, entries) => {
    if (!readers.has(recipient))
        return '/';
    const [first] = entries;
    const query = new URLSearchParams();
    if (first && entries.every((entry) => entry.area === first.area)) {
        query.set('area', areaParam(first.area));
        if (entries.every((entry) => entry.stage === first.stage))
            query.set('stage', first.stage);
    }
    const search = query.toString();
    return `/production/orders/${encodeURIComponent(device.productionProjectId)}/devices/${encodeURIComponent(device.id)}${search ? `?${search}` : ''}`;
};
/** Die Arten der Nachricht «geändert» (30.09.2026): Art → Typ, Schlüssel und deutscher Ersatztext. */
const NOTICE = {
    REMOVED: { type: 'PRODUCTION_TASK_REMOVED', key: 'notify.productionTaskRemoved', title: 'Produktion: nicht mehr zugewiesen', text: 'hat Sie entfernt von' },
    DELETED: { type: 'PRODUCTION_TASK_DELETED', key: 'notify.productionTaskDeleted', title: 'Produktion: Aufgabe gelöscht', text: 'hat gelöscht' },
    UPDATED: { type: 'PRODUCTION_TASK_UPDATED', key: 'notify.productionTaskUpdated', title: 'Produktion: Aufgabe geändert', text: 'hat geändert' },
    APPROVED: { type: 'PRODUCTION_TASK_APPROVED', key: 'notify.productionTaskApproved', title: 'Produktion: freigegeben', text: 'hat freigegeben' },
    REVISION: { type: 'PRODUCTION_TASK_REVISION', key: 'notify.productionTaskRevision', title: 'Produktion: Überarbeitung verlangt', text: 'verlangt eine Überarbeitung' },
    UNLOCKED: { type: 'PRODUCTION_TASK_UNLOCKED', key: 'notify.productionTaskUnlocked', title: 'Produktion: Sperre aufgehoben', text: 'hat die Sperre aufgehoben' },
};
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
            const readers = await deviceReaders([...activeIds]);
            const data = entries
                .filter(([id]) => activeIds.has(id))
                .flatMap(([recipientEmployeeId, tasks]) => {
                const [first] = tasks;
                if (!first)
                    return [];
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
                        // Ohne Produktionsrecht zur Startseite («Görevlerim», 30.09.2026).
                        linkUrl: linkFor(readers, recipientEmployeeId, device, tasks),
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
    /**
     * Neue Pflichten (28.09.2026): begonnene Unteraufgaben sind wieder offen —
     * EINE Nachricht je Person der Aufgabe mit ihren Unteraufgaben darin; sie
     * prüft neu (▶) und schliesst wieder ab. Nie die auslösende Person selbst.
     */
    async reopened(input) {
        try {
            const byRecipient = new Map();
            for (const subtask of input.subtasks) {
                for (const id of subtask.recipients) {
                    if (id === input.actorId)
                        continue;
                    byRecipient.set(id, [...(byRecipient.get(id) ?? []), subtask]);
                }
            }
            if (!byRecipient.size)
                return;
            const active = await prisma_client_1.default.employee.findMany({
                where: { id: { in: [...byRecipient.keys()] }, isActive: true, deletedAt: null, bannedAt: null },
                select: { id: true },
            });
            const activeIds = new Set(active.map((row) => row.id));
            const actor = input.actorName ?? '';
            const { device } = input;
            const where = `${device.name} (${device.projectNumber})`;
            const readers = await deviceReaders([...activeIds]);
            const data = [...byRecipient.entries()]
                .filter(([id]) => activeIds.has(id))
                .flatMap(([recipientEmployeeId, subtasks]) => {
                const [first] = subtasks;
                if (!first)
                    return [];
                const list = subtasks.length === 1
                    ? `${first.code} ${first.name}`
                    : `${subtasks.slice(0, 4).map((entry) => entry.code).join(', ')}${subtasks.length > 4 ? ` +${subtasks.length - 4}` : ''}`;
                return [{
                        id: (0, nanoid_1.nanoid)(12),
                        tenantId: input.tenantId,
                        recipientEmployeeId,
                        type: 'PRODUCTION_SUBTASK_REOPENED',
                        title: 'Produktion: Unteraufgabe neu zu prüfen',
                        message: `${actor || 'Die Verwaltung'} hat neue Pflichten ergänzt — bitte neu prüfen und abschliessen: ${list} — ${where}.`,
                        linkUrl: linkFor(readers, recipientEmployeeId, device, subtasks),
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
            if (data.length)
                await prisma_client_1.default.notification.createMany({ data });
        }
        catch (error) {
            console.warn('[üretim] Glocke (wieder geöffnet) fehlgeschlagen:', error?.message ?? error);
        }
    }
    /**
     * Bitte um das Aufheben einer Sperre (30.09.2026) — an die Verwaltung der Firma. Der Verweis
     * öffnet die Stufe am Gerät; dort stehen die Anfragen hinter «Requests».
     */
    async unlockRequested(input) {
        try {
            const recipients = await adminRecipients(input.tenantId, input.actorId);
            if (!recipients.length)
                return;
            const actor = input.actorName ?? '';
            const { device } = input;
            const task = `${input.code} ${input.name}`;
            const where = `${device.name} (${device.projectNumber})`;
            const note = input.note ? input.note.slice(0, 300) : '';
            const link = linkFor(new Set(recipients), recipients[0] ?? '', device, [{ area: input.area, stage: input.stage }]);
            await prisma_client_1.default.notification.createMany({
                data: recipients.map((recipientEmployeeId) => ({
                    id: (0, nanoid_1.nanoid)(12),
                    tenantId: input.tenantId,
                    recipientEmployeeId,
                    type: 'PRODUCTION_UNLOCK_REQUESTED',
                    title: 'Produktion: Bitte um Entsperren',
                    message: `${actor || 'Jemand'} bittet, die Sperre aufzuheben: ${task} — ${where}.${note ? ` «${note}»` : ''}`,
                    linkUrl: link,
                    metadata: {
                        i18n: {
                            key: note ? 'notify.productionUnlockRequestedNote' : 'notify.productionUnlockRequested',
                            params: { actor, tasks: task, device: device.name, project: device.projectNumber, note },
                        },
                        productionItemId: device.id,
                        productionProjectId: device.productionProjectId,
                    },
                })),
            });
        }
        catch (error) {
            console.warn('[üretim] Glocke (Bitte um Entsperren) fehlgeschlagen:', error?.message ?? error);
        }
    }
    /**
     * Was die Verwaltung an Unteraufgaben getan hat (30.09.2026): entfernt, gelöscht, geändert,
     * freigegeben, zurückgegeben, entsperrt. Je Person und Art EINE Nachricht mit den
     * Unteraufgaben darin (eine Rückgabe mit ihrer Notiz). Nie die auslösende Person selbst,
     * nie inaktive Konten; der Verweis wie bei «zugewiesen».
     */
    async changed(input) {
        try {
            const groups = new Map();
            for (const notice of input.notices) {
                for (const recipient of new Set(notice.recipients)) {
                    if (recipient === input.actorId)
                        continue;
                    const key = `${recipient}|${notice.kind}`;
                    const group = groups.get(key) ?? { recipient, kind: notice.kind, entries: [] };
                    // Dieselbe Unteraufgabe nur einmal je Nachricht.
                    if (!group.entries.some((entry) => entry.code === notice.code))
                        group.entries.push(notice);
                    groups.set(key, group);
                }
            }
            if (!groups.size)
                return;
            const recipients = [...new Set([...groups.values()].map((group) => group.recipient))];
            const active = await prisma_client_1.default.employee.findMany({
                where: { id: { in: recipients }, isActive: true, deletedAt: null, bannedAt: null },
                select: { id: true },
            });
            const activeIds = new Set(active.map((row) => row.id));
            const readers = await deviceReaders([...activeIds]);
            const actor = input.actorName ?? '';
            const { device } = input;
            const where = `${device.name} (${device.projectNumber})`;
            const data = [...groups.values()]
                .filter((group) => activeIds.has(group.recipient))
                .flatMap(({ recipient, kind, entries }) => {
                const [first] = entries;
                if (!first)
                    return [];
                const spec = NOTICE[kind];
                const list = entries.length === 1
                    ? `${first.code} ${first.name}`
                    : `${entries.slice(0, 4).map((entry) => entry.code).join(', ')}${entries.length > 4 ? ` +${entries.length - 4}` : ''}`;
                // Die Notiz einer Rückgabe — nur bei EINER Unteraufgabe eindeutig.
                const note = kind === 'REVISION' && entries.length === 1 && first.note ? first.note.slice(0, 300) : '';
                return [{
                        id: (0, nanoid_1.nanoid)(12),
                        tenantId: input.tenantId,
                        recipientEmployeeId: recipient,
                        type: spec.type,
                        title: spec.title,
                        message: `${actor || 'Die Verwaltung'} ${spec.text}: ${list} — ${where}.${note ? ` «${note}»` : ''}`,
                        linkUrl: linkFor(readers, recipient, device, entries),
                        metadata: {
                            i18n: {
                                key: note ? `${spec.key}Note` : spec.key,
                                params: { actor, tasks: list, count: entries.length, device: device.name, project: device.projectNumber, note },
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
            console.warn('[üretim] Glocke (geändert) fehlgeschlagen:', error?.message ?? error);
        }
    }
}
exports.ProductionTaskNotifier = ProductionTaskNotifier;
//# sourceMappingURL=productionTaskNotifications.js.map