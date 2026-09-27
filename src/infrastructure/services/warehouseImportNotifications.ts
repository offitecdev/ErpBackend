import { nanoid } from 'nanoid';

import prisma from '../database/prisma.client';
import type { IWarehouseNotifier } from '../../domain/repositories/IWarehouseRepository';
import { employeeScopeWhere, getCompanyTreeTenantIds } from '../../presentation/controllers/serviceTenantScope';

/**
 * ── DIE GLOCKE DES EXCEL-AKTARIMS (26.09.2026, Vorgabe Samet) ───────────────
 *
 * «Her aktarımdan önce toplu aktarım administratöre izin gitmesi lazım.»
 *
 *   · Eingereicht → an jede Person mit der Administratorrolle
 *     (`Role.isSystemAdmin`) im Firmenbaum — die Administratorrolle darf jede
 *     Firma des Baums wählen und sieht die Nachricht, sobald sie die
 *     Produktionsfirma gewählt hat (die Glocke zeigt je Firma).
 *   · Entschieden → an die einreichende Person.
 * Nie an die auslösende Person selbst.
 *
 * Text wie bei den Projektereignissen: deutscher Ersatztext in
 * `title`/`message`, Schlüssel + Werte in `metadata.i18n` — die Oberfläche
 * baut den Satz in der Sprache der lesenden Person.
 *
 * Wirft nie: ein Aktarım darf an einer Nachricht nicht scheitern.
 */

const linkTo = (importId: string) => `/warehouse/settings?tab=imports&import=${encodeURIComponent(importId)}`;

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

export class WarehouseImportNotifier implements IWarehouseNotifier {
    async importRequested(input: {
        tenantId: string;
        importId: string;
        rowCount: number;
        fileName: string | null;
        actorId: string;
        actorName: string | null;
    }): Promise<void> {
        try {
            const recipients = await adminRecipients(input.tenantId, input.actorId);
            if (!recipients.length) {
                console.warn('[depo] Aktarım ohne Empfänger: keine Administratorrolle im Firmenbaum.');
                return;
            }
            const actor = input.actorName ?? '';
            const file = input.fileName ?? '';
            await prisma.notification.createMany({
                data: recipients.map((recipientEmployeeId) => ({
                    id: nanoid(12),
                    tenantId: input.tenantId,
                    recipientEmployeeId,
                    type: 'WAREHOUSE_IMPORT_REQUESTED',
                    title: 'Depo: Excel-Aktarım wartet auf Freigabe',
                    message: `${actor || 'Jemand'} möchte ${input.rowCount} Produktkarten aus Excel übernehmen${file ? ` (${file})` : ''}.`,
                    linkUrl: linkTo(input.importId),
                    metadata: {
                        i18n: { key: 'notify.warehouseImportRequested', params: { actor, rows: input.rowCount, file } },
                        importId: input.importId,
                    },
                })),
            });
        } catch (error) {
            console.warn('[depo] Glocke (Aktarım eingereicht) fehlgeschlagen:', (error as Error)?.message ?? error);
        }
    }

    async importDecided(input: {
        tenantId: string;
        importId: string;
        requesterId: string | null;
        outcome: 'DONE' | 'REJECTED';
        actorId: string;
        actorName: string | null;
        created: number;
        note: string | null;
    }): Promise<void> {
        try {
            if (!input.requesterId || input.requesterId === input.actorId) return;
            const actor = input.actorName ?? '';
            const done = input.outcome === 'DONE';
            await prisma.notification.create({
                data: {
                    id: nanoid(12),
                    tenantId: input.tenantId,
                    recipientEmployeeId: input.requesterId,
                    type: done ? 'WAREHOUSE_IMPORT_DONE' : 'WAREHOUSE_IMPORT_REJECTED',
                    title: done ? 'Depo: Excel-Aktarım übernommen' : 'Depo: Excel-Aktarım abgelehnt',
                    message: done
                        ? `${actor || 'Die Verwaltung'} hat den Aktarım freigegeben: ${input.created} Produktkarten angelegt.`
                        : `${actor || 'Die Verwaltung'} hat den Aktarım abgelehnt.${input.note ? ` ${input.note}` : ''}`,
                    linkUrl: linkTo(input.importId),
                    metadata: {
                        i18n: {
                            key: done ? 'notify.warehouseImportDone' : 'notify.warehouseImportRejected',
                            params: { actor, created: input.created, note: input.note ?? '' },
                        },
                        importId: input.importId,
                    },
                },
            });
        } catch (error) {
            console.warn('[depo] Glocke (Aktarım entschieden) fehlgeschlagen:', (error as Error)?.message ?? error);
        }
    }
}
