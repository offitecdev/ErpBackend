import { nanoid } from 'nanoid';
import prisma from '../database/prisma.client';

/**
 * Ereignis-Benachrichtigungen des Büros (Vorgabe 15.08.2026): wenn draussen
 * etwas ankommt — ein Montage-Rapport, ein Übergabe-Rapport, eine
 * Unterschrift — erfährt es die verantwortliche Seite sofort als Notification
 * (Glocke + Einblendung rechts, mit "Öffnen" zum Projekt).
 *
 * Empfänger: die Projektleitung (Project.managerId) und die erfassende Person
 * des zugehörigen Angebots (Verkauf) — ohne die auslösende Person selbst.
 * Gibt es niemanden davon, geht die Nachricht an alle im Mandanten
 * (recipient null = Rundruf), damit sie nicht ins Leere fällt.
 *
 * Text: `title`/`message` sind der deutsche Ersatztext; `metadata.i18n`
 * trägt Schlüssel + Bausteine, aus denen die Oberfläche den Satz in der
 * Sprache der lesenden Person baut (drei Sprachen).
 *
 * Wiederholte Speicherungen desselben Rapports innerhalb kurzer Zeit erzeugen
 * KEINE zweite Nachricht (gleiches Sprungziel + gleiche Art im Fenster).
 */

export type ProjectEvent = 'FIELD_REPORT_RECEIVED' | 'DELIVERY_REPORT_RECEIVED' | 'SIGNATURE_RECEIVED';
export type ReportKind = 'FIELD' | 'DELIVERY' | 'GENERAL';

const DEDUPE_WINDOW_MS = 2 * 60 * 60 * 1000;

const SUB_SECTION: Record<ReportKind, string> = {
    FIELD: 'fieldReports',
    DELIVERY: 'delivery',
    GENERAL: 'generalReport',
};

const REPORT_LABEL_DE: Record<ReportKind, string> = {
    FIELD: 'Montage-Rapport',
    DELIVERY: 'Übergabe-Rapport',
    GENERAL: 'Gesamtrapport',
};

const I18N_KEY: Record<ProjectEvent, string> = {
    FIELD_REPORT_RECEIVED: 'notify.fieldReportReceived',
    DELIVERY_REPORT_RECEIVED: 'notify.deliveryReportReceived',
    SIGNATURE_RECEIVED: 'notify.signatureReceived',
};

const germanText = (event: ProjectEvent, params: { project: string; actor: string; report: ReportKind }) => {
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

export interface ProjectEventInput {
    tenantId: string;
    projectId: string | null | undefined;
    event: ProjectEvent;
    report: ReportKind;
    /** Kennung des Rapports/Antrags — landet im Sprungziel und im Doppel-Schutz. */
    reportId?: string | null;
    /** Wer ausgelöst hat (bekommt selbst keine Nachricht); null = Kundin über den öffentlichen Link. */
    actorEmployeeId?: string | null;
}

/**
 * Feuert die Benachrichtigung; wirft nie (der auslösende Speichervorgang darf
 * an einer Nachricht nicht scheitern). Aufruf: `void notifyProjectEvent(...)`.
 */
export const notifyProjectEvent = async (input: ProjectEventInput): Promise<void> => {
    try {
        if (!input.projectId) return;
        const [project, actor] = await Promise.all([
            prisma.project.findFirst({
                where: { id: input.projectId, tenantId: input.tenantId },
                select: {
                    id: true,
                    projectNumber: true,
                    managerId: true,
                    tender: { select: { createdByEmployeeId: true } },
                },
            }),
            input.actorEmployeeId
                ? prisma.employee.findUnique({
                    where: { id: input.actorEmployeeId },
                    select: { firstName: true, lastName: true },
                })
                : Promise.resolve(null),
        ]);
        if (!project) return;

        const actorName = actor ? `${actor.firstName} ${actor.lastName}`.trim() : '';
        const recipients = [...new Set([project.managerId, project.tender?.createdByEmployeeId]
            .filter((id): id is string => Boolean(id) && id !== input.actorEmployeeId))];
        // Niemand Zuständiges → Rundruf im Mandanten statt Stille.
        const targets: Array<string | null> = recipients.length ? recipients : [null];

        const query = new URLSearchParams({ section: 'field', sub: SUB_SECTION[input.report] });
        if (input.reportId) query.set('report', input.reportId);
        const linkUrl = `/projects/${project.id}?${query.toString()}`;

        // Doppel-Schutz: dieselbe Nachricht zum selben Ziel im Fenster → nichts.
        const recent = await prisma.notification.findFirst({
            where: {
                tenantId: input.tenantId,
                type: input.event,
                linkUrl,
                createdAt: { gt: new Date(Date.now() - DEDUPE_WINDOW_MS) },
            },
            select: { id: true },
        });
        if (recent) return;

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

        await prisma.notification.createMany({
            data: targets.map((recipientEmployeeId) => ({
                id: nanoid(12),
                tenantId: input.tenantId,
                recipientEmployeeId,
                type: input.event,
                title: text.title,
                message: text.message,
                linkUrl,
                metadata,
            })),
        });
    } catch (error: any) {
        console.warn('[project-events] notify failed:', error?.message || error);
    }
};
