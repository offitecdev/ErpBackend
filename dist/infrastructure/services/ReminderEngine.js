"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startReminderEngine = void 0;
const client_1 = require("@prisma/client");
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const reminderSchedule_1 = require("../../shared/reminderSchedule");
const crmTaskMaintenance_1 = require("./crmTaskMaintenance");
/**
 * Hintergrunddienst der Erinnerungen (Einstellungen → Module → Verkauf →
 * Erinnerungen). Je Belegart gibt es GENAU EINE Einstellung — Vorlauf und
 * Wiederholung (shared/reminderSchedule.ts rechnet den Fahrplan). Daraus
 * entstehen CrmTask-Zeilen kind=REMINDER; das Einblendfenster rechts holt sie
 * sich selbst (GET /crm/reminders/due), die Aufgabenliste führt sie weiter.
 *
 * Erinnert wird an GENAU ZWEI Dinge (Vorgabe 14./15.08.2026):
 *   QUOTE — Angebote (Bezug: gültig bis; nur Entwürfe ohne Annahme)
 *   ORDER — Aufträge (Bezug: Tender.internalDeliveryDate des zugehörigen
 *           Angebots; nur offene Aufträge)
 * Verantwortlich ist, wem der Beleg gehört (die erfassende Person).
 *
 * Jede Erinnerung trägt ein Sprungziel (`linkUrl`, "Öffnen") und die
 * sprachneutralen Bausteine (`meta`); den Satz setzt die Oberfläche in der
 * Sprache der Person zusammen. `title` ist nur der deutsche Ersatztext.
 *
 * Doppelzündungen verhindert ReminderDispatch (unique Belegart+Beleg+Termin).
 * Je Beleg feuert nur der JÜNGSTE fällige Schritt, und nur, wenn er höchstens
 * CATCH_UP_DAYS zurückliegt — eine neu gesetzte Einstellung flutet nichts
 * rückwirkend, und eine Auszeit des Dienstes holt keine Zwischenschritte nach.
 *
 * Jeder Takt räumt ausserdem auf (crmTaskMaintenance): verstrichene offene
 * Aufgaben werden "Nicht erledigt", und Erinnerungen zu abgelaufenen bzw.
 * angenommenen Angeboten und geschlossenen Aufträgen werden gelöscht — der
 * Anlass ist weg, das Angebot selbst zeigt "Abgelaufen" (Vorgabe 15.08.2026).
 * Damit das Aufräumen den Beleg kennt, trägt jede Erinnerung entityType/
 * entityId (QUOTE → Tender, ORDER → SalesOrder).
 */
const TICK_MS = 10 * 60 * 1000;
const CATCH_UP_DAYS = 7;
const BATCH_LIMIT = 500;
const toCandidate = (entityType, row) => ({
    tenantId: row.tenantId,
    entityType,
    entityId: row.entityId,
    reference: new Date(row.reference),
    leadDays: Number(row.leadDays),
    intervalDays: Number(row.intervalDays),
    number: String(row.number || ''),
    customerId: row.customerId ?? null,
    customerName: row.customerName ?? null,
    ownerEmployeeId: row.createdByEmployeeId,
});
/** Offene Angebote, deren Fahrplan begonnen hat und die noch nicht abgelaufen sind. */
const collectQuoteCandidates = async () => {
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT s.tenantId, s.leadDays, s.intervalDays,
               t.id AS entityId, t.tenderNumber AS number, t.customerId, t.createdByEmployeeId,
               t.validUntil AS reference, cu.companyName AS customerName
        FROM ReminderSetting s
        JOIN Tender t ON t.tenantId = s.tenantId
            AND t.validUntil IS NOT NULL
            AND t.status = 'Draft'
            AND t.offerAcceptedAt IS NULL
            AND DATE_SUB(t.validUntil, INTERVAL s.leadDays DAY) <= NOW(3)
            -- Der letzte Gültigkeitstag zählt noch; danach ist das Angebot
            -- abgelaufen und seine Erinnerung würde im selben Takt wieder
            -- weggeräumt (purgeStaleReminders) — also gar nicht erst zünden.
            AND DATE(t.validUntil) >= CURDATE()
        LEFT JOIN Customer cu ON cu.id = t.customerId
        WHERE s.entityType = 'QUOTE' AND s.enabled = true
        LIMIT ${BATCH_LIMIT}
    `);
    return rows.map((row) => toCandidate('QUOTE', row));
};
/**
 * Offene Aufträge mit begonnenem Fahrplan. Der Liefertermin eines Auftrags ist
 * der seines Angebots (Tender.internalDeliveryDate — der Auftrag spiegelt sein
 * Angebot 1:1). Abgeschlossene und stornierte Aufträge erinnern nicht mehr.
 */
const collectOrderCandidates = async () => {
    const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT s.tenantId, s.leadDays, s.intervalDays,
               o.id AS entityId, o.orderNumber AS number, o.customerId, o.createdByEmployeeId,
               t.internalDeliveryDate AS reference, cu.companyName AS customerName
        FROM ReminderSetting s
        JOIN SalesOrder o ON o.tenantId = s.tenantId
            AND o.status NOT IN ('CANCELLED', 'COMPLETED')
        JOIN Tender t ON t.id = o.tenderId
            AND t.internalDeliveryDate IS NOT NULL
            AND DATE_SUB(t.internalDeliveryDate, INTERVAL s.leadDays DAY) <= NOW(3)
            AND t.internalDeliveryDate > DATE_SUB(NOW(3), INTERVAL ${CATCH_UP_DAYS} DAY)
        LEFT JOIN Customer cu ON cu.id = o.customerId
        WHERE s.entityType = 'ORDER' AND s.enabled = true
        LIMIT ${BATCH_LIMIT}
    `);
    return rows.map((row) => toCandidate('ORDER', row));
};
const linkFor = (hit) => hit.entityType === 'QUOTE' ? `/sales/quotes/${hit.entityId}` : `/sales/orders/${hit.entityId}`;
/** Deutscher Ersatztext — die Oberfläche baut aus `meta` den Satz in der Sprache der Person. */
const fallbackTitle = (hit, daysLeft) => {
    const when = daysLeft === 0 ? 'heute' : daysLeft === 1 ? 'morgen' : `in ${daysLeft} Tagen`;
    const suffix = hit.customerName ? ` — ${hit.customerName}` : '';
    return hit.entityType === 'QUOTE'
        ? `Angebot ${hit.number} läuft ${when} ab${suffix}`
        : `Auftrag ${hit.number}: Liefertermin ${when}${suffix}`;
};
/** Jüngster fälliger Schritt je Beleg, noch nicht gezündet, im Nachholfenster. */
const dueHits = async (candidates) => {
    const now = new Date();
    const floor = now.getTime() - CATCH_UP_DAYS * 24 * 60 * 60 * 1000;
    const hits = [];
    for (const candidate of candidates) {
        const dueAt = (0, reminderSchedule_1.latestDueStep)(candidate.reference, candidate.leadDays, candidate.intervalDays, now);
        if (!dueAt || dueAt.getTime() <= floor)
            continue;
        hits.push({ ...candidate, dueAt });
    }
    if (hits.length === 0)
        return [];
    // Was im Nachholfenster schon gezündet hat, fällt weg — eine Abfrage.
    const fired = await prisma_client_1.default.reminderDispatch.findMany({
        where: {
            entityId: { in: [...new Set(hits.map((hit) => hit.entityId))] },
            dueAt: { gt: new Date(floor) },
        },
        select: { entityType: true, entityId: true, dueAt: true },
    });
    const key = (row) => `${row.entityType}|${row.entityId}|${row.dueAt.getTime()}`;
    const firedKeys = new Set(fired.map(key));
    return hits.filter((hit) => !firedKeys.has(key(hit)));
};
const fireHits = async (hits) => {
    if (hits.length === 0)
        return;
    // Ids vorab, damit die Verantwortlichen-Zeile (CrmTaskAssignee, seit
    // 18.08.2026 die eigentliche Zuweisung) im selben Zug entsteht.
    const taskRows = hits.map((hit) => ({ hit, id: (0, nanoid_1.nanoid)(12) }));
    await prisma_client_1.default.$transaction([
        prisma_client_1.default.crmTask.createMany({
            data: taskRows.map(({ hit, id }) => {
                const daysLeft = (0, reminderSchedule_1.daysBetween)(hit.dueAt, hit.reference);
                return {
                    id,
                    tenantId: hit.tenantId,
                    kind: 'REMINDER',
                    title: fallbackTitle(hit, daysLeft),
                    customerId: hit.customerId,
                    assigneeEmployeeId: hit.ownerEmployeeId,
                    dueDate: hit.dueAt,
                    createdByEmployeeId: hit.ownerEmployeeId,
                    linkUrl: linkFor(hit),
                    entityType: hit.entityType,
                    entityId: hit.entityId,
                    meta: {
                        template: hit.entityType === 'QUOTE' ? 'QUOTE_EXPIRY' : 'ORDER_DELIVERY',
                        number: hit.number,
                        customerName: hit.customerName,
                        referenceDate: hit.reference.toISOString(),
                        daysLeft,
                    },
                };
            }),
        }),
        prisma_client_1.default.crmTaskAssignee.createMany({
            data: taskRows.map(({ hit, id }) => ({ id: (0, nanoid_1.nanoid)(12), taskId: id, employeeId: hit.ownerEmployeeId })),
        }),
        prisma_client_1.default.reminderDispatch.createMany({
            data: hits.map((hit) => ({
                id: (0, nanoid_1.nanoid)(12),
                tenantId: hit.tenantId,
                entityType: hit.entityType,
                entityId: hit.entityId,
                dueAt: hit.dueAt,
            })),
            // Zwei Takte könnten sich überlappen; der unique-Schlüssel fängt das ab.
            skipDuplicates: true,
        }),
    ]);
};
const runPass = async () => {
    const [quotes, orders] = await Promise.all([collectQuoteCandidates(), collectOrderCandidates()]);
    const hits = await dueHits([...quotes, ...orders]);
    await fireHits(hits);
    // Aufräumen NACH dem Zünden: ein "läuft heute ab" bleibt den Tag über
    // stehen (der letzte Gültigkeitstag zählt), erst danach fällt es weg.
    await Promise.all([(0, crmTaskMaintenance_1.flipOverdueTasks)(), (0, crmTaskMaintenance_1.purgeStaleReminders)()]);
};
let started = false;
const startReminderEngine = () => {
    if (started || process.env.OFFITEC_DISABLE_REMINDERS === 'true')
        return;
    started = true;
    const tick = () => {
        void runPass().catch((error) => {
            console.error('[reminders] pass failed:', error?.message || error);
        });
    };
    tick();
    setInterval(tick, TICK_MS);
};
exports.startReminderEngine = startReminderEngine;
//# sourceMappingURL=ReminderEngine.js.map