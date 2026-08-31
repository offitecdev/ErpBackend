"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.labelExistingMessages = exports.autoCategoryId = exports.invalidateCategoryIndex = exports.getCategoryIndex = void 0;
const prisma_client_1 = __importDefault(require("../../database/prisma.client"));
const serviceTenantScope_1 = require("../../../presentation/controllers/serviceTenantScope");
const INDEX_TTL_MS = 5 * 60_000;
const indexes = new Map();
const inflight = new Map();
const loadIndex = async (tenantId) => {
    const rows = await prisma_client_1.default.mailCategory.findMany({
        where: { tenantId, kind: { in: ["CUSTOMER", "STAFF"] }, NOT: { entityId: null } },
        select: { id: true, kind: true, entityId: true },
    });
    const byCustomer = new Map();
    const byStaff = new Map();
    for (const row of rows) {
        if (!row.entityId)
            continue;
        if (row.kind === "CUSTOMER")
            byCustomer.set(row.entityId, row.id);
        else
            byStaff.set(row.entityId, row.id);
    }
    return { byCustomer, byStaff, loadedAt: Date.now() };
};
const getCategoryIndex = async (selectedTenantId, { fresh = false } = {}) => {
    /* Die Leiste gehört dem Postfach, das Postfach dem Stamm des Firmenbaums:
       ein Index je Baum, nicht je Firma. */
    const tenantId = await (0, serviceTenantScope_1.getMailTenantId)(selectedTenantId);
    const cached = indexes.get(tenantId);
    if (cached && !fresh && Date.now() - cached.loadedAt < INDEX_TTL_MS)
        return cached;
    const running = inflight.get(tenantId);
    if (running)
        return running;
    const job = loadIndex(tenantId)
        .then((index) => { indexes.set(tenantId, index); return index; })
        .finally(() => inflight.delete(tenantId));
    inflight.set(tenantId, job);
    return job;
};
exports.getCategoryIndex = getCategoryIndex;
const invalidateCategoryIndex = (selectedTenantId) => {
    // Sofort für den übergebenen Schlüssel (die Aufrufer halten den
    // Mail-Mandanten), der aufgelöste Stamm einen Zug später hinterher.
    indexes.delete(selectedTenantId);
    void (0, serviceTenantScope_1.getMailTenantId)(selectedTenantId)
        .then((tenantId) => { indexes.delete(tenantId); })
        .catch(() => undefined);
};
exports.invalidateCategoryIndex = invalidateCategoryIndex;
/**
 * Das Etikett zur erkannten Gegenstelle — oder null, wenn sie keine Kategorie
 * in der Leiste hat. Der KUNDE hat Vorrang vor der Person (dieselbe Reihenfolge
 * wie beim Adresstreffer: wer Kunde UND Mitarbeiter ist, zählt als Kunde).
 */
const autoCategoryId = (index, party) => {
    if (party.customerId) {
        const hit = index.byCustomer.get(party.customerId);
        if (hit)
            return hit;
    }
    if (party.employeeId) {
        const hit = index.byStaff.get(party.employeeId);
        if (hit)
            return hit;
    }
    return null;
};
exports.autoCategoryId = autoCategoryId;
/**
 * RÜCKWIRKEND: die schon gespeicherte Post der eben angelegten Kategorie
 * einsammeln — sonst steht ein frisch angelegter Kunde mit «0» in der Leiste,
 * obwohl seine Korrespondenz seit Monaten im Postfach liegt.
 *
 * Nur Nachrichten OHNE Etikett; eine von Hand gesetzte Zuordnung bleibt, wo
 * sie ist. Beim Personal zählt nur der ADRESSTREFFER (AUTO_EMPLOYEE, die
 * Person hat selbst geschrieben) — bei einer ERP-Sendung steht in
 * `employeeId` die Absenderin aus dem Haus, und deren Kundenpost gehört nicht
 * in ihr eigenes Fach.
 *
 * Der Papierkorb wird mitgenommen: die Zeile bekommt ihr Etikett, gezeigt
 * wird sie deswegen nicht (Gelöschtes liegt in keiner Kategorie).
 */
const labelExistingMessages = async (tenantId, kind, entityId, categoryId) => {
    let where;
    if (kind === "CUSTOMER")
        where = { tenantId, categoryId: null, customerId: entityId };
    else if (kind === "STAFF")
        where = { tenantId, categoryId: null, employeeId: entityId, matchSource: "AUTO_EMPLOYEE" };
    else
        return 0;
    const result = await prisma_client_1.default.mailMessage.updateMany({ where, data: { categoryId } });
    return result.count;
};
exports.labelExistingMessages = labelExistingMessages;
//# sourceMappingURL=mailAutoCategory.js.map