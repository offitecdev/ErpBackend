"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.purgeStaleReminders = exports.flipOverdueTasks = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
/**
 * Pflege der Aufgaben & Erinnerungen — zwei Aufräumregeln, die der
 * Hintergrunddienst (ReminderEngine, alle 10 Minuten) UND der Listenaufruf
 * (GET /crm/tasks, damit die Seite nie hinterherhinkt) gleich anwenden:
 *
 *  1. Verstrichene Aufgaben: eine OFFENE Aufgabe, deren Termin vor heute
 *     liegt, wird "Nicht erledigt" (INCOMPLETE). Zurückholen macht sie wieder
 *     offen (die Oberfläche legt den Termin dabei auf heute, sonst kippte sie
 *     beim nächsten Takt sofort zurück). Erinnerungen sind davon ausgenommen —
 *     sie läuten zur Minute und werden nicht "verpasst", sondern geschlossen.
 *
 *  2. Erledigte Erinnerungen des Hintergrunddienstes: hängt eine Erinnerung an
 *     einem Angebot, das abgelaufen ist (gültig bis liegt vor heute — der
 *     letzte Gültigkeitstag zählt noch), angenommen oder bestellt wurde, oder
 *     an einem Auftrag, der abgeschlossen/storniert ist, wird sie gelöscht:
 *     der Anlass ist weg, das Angebot selbst zeigt "Abgelaufen" (Vorgabe
 *     15.08.2026). Belege, die es nicht mehr gibt, räumen ihre Erinnerungen
 *     ebenfalls ab.
 *
 * Alle Anweisungen sind EINE Runde zur Datenbank und laufen über Indizes
 * (tenantId/status/dueDate bzw. entityType/entityId).
 */
/** Verstrichene offene Aufgaben → INCOMPLETE. Ohne tenantId: alle Mandanten. */
const flipOverdueTasks = async (tenantId) => {
    const tenantSql = tenantId ? client_1.Prisma.sql `AND tenantId = ${tenantId}` : client_1.Prisma.empty;
    return prisma_client_1.default.$executeRaw(client_1.Prisma.sql `
        UPDATE CrmTask
           SET status = 'INCOMPLETE', updatedAt = NOW(3)
         WHERE kind = 'TASK'
           AND status = 'OPEN'
           AND dueDate IS NOT NULL
           AND DATE(dueDate) < CURDATE()
           ${tenantSql}
    `);
};
exports.flipOverdueTasks = flipOverdueTasks;
/** Erinnerungen zu abgelaufenen/angenommenen Angeboten und zu geschlossenen Aufträgen löschen. */
const purgeStaleReminders = async () => {
    const [quotes, orders] = await Promise.all([
        prisma_client_1.default.$executeRaw(client_1.Prisma.sql `
            DELETE tk FROM CrmTask tk
              LEFT JOIN Tender t ON t.id = tk.entityId
             WHERE tk.kind = 'REMINDER'
               AND tk.entityType = 'QUOTE'
               AND (t.id IS NULL
                    OR t.validUntil IS NULL
                    OR DATE(t.validUntil) < CURDATE()
                    OR t.status <> 'Draft'
                    OR t.offerAcceptedAt IS NOT NULL)
        `),
        prisma_client_1.default.$executeRaw(client_1.Prisma.sql `
            DELETE tk FROM CrmTask tk
              LEFT JOIN SalesOrder o ON o.id = tk.entityId
             WHERE tk.kind = 'REMINDER'
               AND tk.entityType = 'ORDER'
               AND (o.id IS NULL OR o.status IN ('CANCELLED', 'COMPLETED'))
        `),
    ]);
    return Number(quotes) + Number(orders);
};
exports.purgeStaleReminders = purgeStaleReminders;
//# sourceMappingURL=crmTaskMaintenance.js.map