"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyProjectEvent = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const DEDUPE_WINDOW_MS = 2 * 60 * 60 * 1000;
const SUB_SECTION = {
    FIELD: 'fieldReports',
    DELIVERY: 'delivery',
    GENERAL: 'generalReport',
};
const REPORT_LABEL_DE = {
    FIELD: 'Montage-Rapport',
    DELIVERY: 'Übergabe-Rapport',
    GENERAL: 'Gesamtrapport',
};
const I18N_KEY = {
    FIELD_REPORT_RECEIVED: 'notify.fieldReportReceived',
    DELIVERY_REPORT_RECEIVED: 'notify.deliveryReportReceived',
    SIGNATURE_RECEIVED: 'notify.signatureReceived',
};
const germanText = (event, params) => {
    const who = params.actor || 'Aussendienst';
    switch (event) {
        case 'FIELD_REPORT_RECEIVED':
            return {
                title: 'Montage-Rapport eingegangen',
                message: `${who} hat den Montage-Rapport zu Projekt ${params.project} eingereicht.`,
            };
        case 'DELIVERY_REPORT_RECEIVED':
            return {
                title: 'Übergabe-Rapport eingegangen',
                message: `${who} hat den Übergabe-Rapport zu Projekt ${params.project} eingereicht.`,
            };
        case 'SIGNATURE_RECEIVED':
        default:
            return {
                title: 'Unterschrift eingegangen',
                message: `Der ${REPORT_LABEL_DE[params.report]} zu Projekt ${params.project} wurde unterschrieben.`,
            };
    }
};
/**
 * Feuert die Benachrichtigung; wirft nie (der auslösende Speichervorgang darf
 * an einer Nachricht nicht scheitern). Aufruf: `void notifyProjectEvent(...)`.
 */
const notifyProjectEvent = async (input) => {
    try {
        if (!input.projectId)
            return;
        const [project, actor] = await Promise.all([
            prisma_client_1.default.project.findFirst({
                where: { id: input.projectId, tenantId: input.tenantId },
                select: {
                    id: true,
                    projectNumber: true,
                    managerId: true,
                    tender: { select: { createdByEmployeeId: true } },
                },
            }),
            input.actorEmployeeId
                ? prisma_client_1.default.employee.findUnique({
                    where: { id: input.actorEmployeeId },
                    select: { firstName: true, lastName: true },
                })
                : Promise.resolve(null),
        ]);
        if (!project)
            return;
        const actorName = actor ? `${actor.firstName} ${actor.lastName}`.trim() : '';
        const recipients = [...new Set([project.managerId, project.tender?.createdByEmployeeId]
                .filter((id) => Boolean(id) && id !== input.actorEmployeeId))];
        // Niemand Zuständiges → Rundruf im Mandanten statt Stille.
        const targets = recipients.length ? recipients : [null];
        const query = new URLSearchParams({ section: 'field', sub: SUB_SECTION[input.report] });
        if (input.reportId)
            query.set('report', input.reportId);
        const linkUrl = `/projects/${project.id}?${query.toString()}`;
        // Doppel-Schutz: dieselbe Nachricht zum selben Ziel im Fenster → nichts.
        const recent = await prisma_client_1.default.notification.findFirst({
            where: {
                tenantId: input.tenantId,
                type: input.event,
                linkUrl,
                createdAt: { gt: new Date(Date.now() - DEDUPE_WINDOW_MS) },
            },
            select: { id: true },
        });
        if (recent)
            return;
        const text = germanText(input.event, { project: project.projectNumber, actor: actorName, report: input.report });
        const metadata = {
            i18n: {
                key: I18N_KEY[input.event],
                params: {
                    project: project.projectNumber,
                    actor: actorName,
                    report: { $t: `notify.reportKind.${input.report}` },
                },
            },
            event: input.event,
            projectId: project.id,
            reportType: input.report,
            reportId: input.reportId ?? null,
        };
        await prisma_client_1.default.notification.createMany({
            data: targets.map((recipientEmployeeId) => ({
                id: (0, nanoid_1.nanoid)(12),
                tenantId: input.tenantId,
                recipientEmployeeId,
                type: input.event,
                title: text.title,
                message: text.message,
                linkUrl,
                metadata,
            })),
        });
    }
    catch (error) {
        console.warn('[project-events] notify failed:', error?.message || error);
    }
};
exports.notifyProjectEvent = notifyProjectEvent;
//# sourceMappingURL=projectEventNotifications.js.map