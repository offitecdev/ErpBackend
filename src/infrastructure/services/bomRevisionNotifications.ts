import { nanoid } from 'nanoid';

import prisma from '../database/prisma.client';
import type { IBomRevisionNotifier } from '../../domain/repositories/IBomRevisionApprovals';
import { employeeScopeWhere, getCompanyTreeTenantIds } from '../../presentation/controllers/serviceTenantScope';

/**
 * ── DIE GLOCKE DER BOM-REVISIONEN (30.09.2026, Vorgabe Samet) ───────────────
 *
 * «Admin'e onay düşsün, admin onaylayabilsin.»
 *   · Eingereicht → an jede Person mit der Administratorrolle im Firmenbaum.
 *   · Freigegeben / zurückgewiesen → an die Person, die eingereicht hat.
 * Nie an die auslösende Person selbst. Deutscher Ersatztext in `title`/
 * `message`, Schlüssel + Werte in `metadata.i18n` (die Glocke übersetzt).
 * Wirft nie: eine Revision scheitert nicht an einer Nachricht.
 */
const adminRecipients = async (tenantId: string, excludeId: string): Promise<string[]> => {
    const treeIds = await getCompanyTreeTenantIds(tenantId);
    const rows = await prisma.employee.findMany({
        where: {
            ...employeeScopeWhere(treeIds.length ? treeIds : [tenantId]),
            deletedAt: null,
            isActive: true,
            employeeRoles: { some: { role: { isSystemAdmin: true } } },
        },
        select: { id: true },
    });
    return [...new Set(rows.map((row) => row.id))].filter((id) => id !== excludeId);
};

export class BomRevisionNotifier implements IBomRevisionNotifier {
    async submitted(input: Parameters<IBomRevisionNotifier['submitted']>[0]): Promise<void> {
        try {
            const recipients = await adminRecipients(input.tenantId, input.actorId);
            if (!recipients.length) return;
            const actor = input.actorName ?? '';
            const reason = input.reason ?? '';
            await prisma.notification.createMany({
                data: recipients.map((recipientEmployeeId) => ({
                    id: nanoid(12),
                    tenantId: input.tenantId,
                    recipientEmployeeId,
                    type: 'BOM_REVISION_SUBMITTED',
                    title: `BOM ${input.bomNumber}: Revision ${input.revision} wartet auf Freigabe`,
                    message: `${actor || 'Jemand'} bittet um Freigabe der Revision ${input.revision}${reason ? `: ${reason}` : '.'}`,
                    linkUrl: input.link,
                    metadata: {
                        i18n: { key: 'notify.bomRevisionSubmitted', params: { actor, bom: input.bomNumber, revision: input.revision, reason } },
                        bomId: input.bomId,
                    },
                })),
            });
        } catch (error) {
            console.warn('[production-bom] Glocke (Revision eingereicht) fehlgeschlagen:', (error as Error)?.message ?? error);
        }
    }

    async decided(input: Parameters<IBomRevisionNotifier['decided']>[0]): Promise<void> {
        try {
            if (!input.recipientId || input.recipientId === input.actorId) return;
            const actor = input.actorName ?? '';
            const note = input.note ?? '';
            await prisma.notification.create({
                data: {
                    id: nanoid(12),
                    tenantId: input.tenantId,
                    recipientEmployeeId: input.recipientId,
                    type: input.approved ? 'BOM_REVISION_APPROVED' : 'BOM_REVISION_REJECTED',
                    title: input.approved
                        ? `BOM ${input.bomNumber}: Revision ${input.revision} freigegeben`
                        : `BOM ${input.bomNumber}: Revision ${input.revision} zurückgewiesen`,
                    message: input.approved
                        ? `${actor || 'Die Verwaltung'} hat die Revision freigegeben — geänderte Bestellungen gehen an die Lieferanten.`
                        : `${actor || 'Die Verwaltung'} hat die Revision zurückgewiesen.${note ? ` ${note}` : ''}`,
                    linkUrl: input.link,
                    metadata: {
                        i18n: {
                            key: input.approved ? 'notify.bomRevisionApproved' : 'notify.bomRevisionRejected',
                            params: { actor, bom: input.bomNumber, revision: input.revision, note },
                        },
                    },
                },
            });
        } catch (error) {
            console.warn('[production-bom] Glocke (Revision entschieden) fehlgeschlagen:', (error as Error)?.message ?? error);
        }
    }
}
