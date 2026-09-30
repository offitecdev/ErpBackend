"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaPriceComparisonStore = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
/**
 * ── GESPEICHERTE FİYAT KARŞILAŞTIRMALARI (29.09.2026) ───────────────────────
 * «Karşılaştırmalar kayıt edilecek.» Sie stehen wie der Verlauf der Talepler
 * im Belegverlauf (`DocumentEvent`, unveränderlich): `entityType =
 * 'PROCUREMENT_CMP'`, `entityId` = Talep, die ganze Tabelle im `snapshot`.
 * Keine eigene Tabelle — also auch keine Migration.
 */
const ENTITY = 'PROCUREMENT_CMP';
const ACTION = 'PRICE_COMPARED';
const SELECT = { id: true, entityId: true, documentNumber: true, actorName: true, snapshot: true, createdAt: true };
const comparisonOf = (row) => {
    const data = row.snapshot && typeof row.snapshot === 'object' && !Array.isArray(row.snapshot)
        ? row.snapshot
        : null;
    const result = data?.result;
    if (!result || !Array.isArray(result.suppliers) || !Array.isArray(result.lines))
        return null;
    return {
        id: row.id,
        requestId: row.entityId,
        requestNumber: row.documentNumber ?? '',
        createdAt: row.createdAt,
        actorName: row.actorName ?? null,
        model: typeof data?.model === 'string' ? data.model : '',
        result,
    };
};
class PrismaPriceComparisonStore {
    async save(tenantId, entry) {
        const row = await prisma_client_1.default.documentEvent.create({
            data: {
                id: (0, nanoid_1.nanoid)(14),
                tenantId,
                entityType: ENTITY,
                entityId: entry.requestId,
                documentNumber: entry.requestNumber.slice(0, 191),
                action: ACTION,
                snapshot: { model: entry.model, result: entry.result },
                actorId: entry.actorId,
                actorName: entry.actorName?.slice(0, 191) ?? null,
            },
            select: SELECT,
        });
        return comparisonOf(row);
    }
    async forRequest(tenantId, requestId) {
        const rows = await prisma_client_1.default.documentEvent.findMany({
            where: { tenantId, entityType: ENTITY, entityId: requestId, action: ACTION },
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: SELECT,
        });
        return rows.flatMap((row) => comparisonOf(row) ?? []);
    }
    async get(tenantId, id) {
        const row = await prisma_client_1.default.documentEvent.findFirst({
            where: { id, tenantId, entityType: ENTITY, action: ACTION },
            select: SELECT,
        });
        return row ? comparisonOf(row) : null;
    }
}
exports.PrismaPriceComparisonStore = PrismaPriceComparisonStore;
//# sourceMappingURL=PriceComparisonRepository.js.map