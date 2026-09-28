"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WarehouseImportNotifier = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const serviceTenantScope_1 = require("../../presentation/controllers/serviceTenantScope");
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
const linkTo = (importId) => `/warehouse/settings?tab=imports&import=${encodeURIComponent(importId)}`;
const adminRecipients = async (tenantId, excludeId) => {
    const treeIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(tenantId);
    const rows = await prisma_client_1.default.employee.findMany({
        where: {
            ...(0, serviceTenantScope_1.employeeScopeWhere)(treeIds.length ? treeIds : [tenantId]),
            deletedAt: null,
            isActive: true,
            employeeRoles: { some: { role: { isSystemAdmin: true } } },
        },
        select: { id: true },
    });
    return [...new Set(rows.map((row) => row.id))].filter((id) => id !== excludeId);
};
class WarehouseImportNotifier {
    async importRequested(input) {
        try {
            const recipients = await adminRecipients(input.tenantId, input.actorId);
            if (!recipients.length) {
                console.warn('[depo] Aktarım ohne Empfänger: keine Administratorrolle im Firmenbaum.');
                return;
            }
            const actor = input.actorName ?? '';
            const file = input.fileName ?? '';
            await prisma_client_1.default.notification.createMany({
                data: recipients.map((recipientEmployeeId) => ({
                    id: (0, nanoid_1.nanoid)(12),
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
        }
        catch (error) {
            console.warn('[depo] Glocke (Aktarım eingereicht) fehlgeschlagen:', error?.message ?? error);
        }
    }
    async importDecided(input) {
        try {
            if (!input.requesterId || input.requesterId === input.actorId)
                return;
            const actor = input.actorName ?? '';
            const done = input.outcome === 'DONE';
            await prisma_client_1.default.notification.create({
                data: {
                    id: (0, nanoid_1.nanoid)(12),
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
        }
        catch (error) {
            console.warn('[depo] Glocke (Aktarım entschieden) fehlgeschlagen:', error?.message ?? error);
        }
    }
}
exports.WarehouseImportNotifier = WarehouseImportNotifier;
//# sourceMappingURL=warehouseImportNotifications.js.map