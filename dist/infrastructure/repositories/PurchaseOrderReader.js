"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaPurchaseOrderReader = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const production_1 = require("../../domain/services/production");
/**
 * Die Lieferantenbestellungen, gelesen für die Produktion. `items` ist dort
 * eine JSON-Spalte (Momentaufnahme, keine Fremdschlüssel) — `parsePurchaseLines`
 * übersetzt sie in die wenigen Felder, die das Modul braucht.
 */
class PrismaPurchaseOrderReader {
    async findByIds(tenantId, ids) {
        if (!ids.length)
            return [];
        const rows = await prisma_client_1.default.purchaseOrder.findMany({
            where: { tenantId, id: { in: ids } },
            select: { id: true, referenceNumber: true, status: true, supplierName: true, currency: true, createdAt: true, items: true },
        });
        return rows.map((row) => ({
            id: row.id,
            referenceNumber: row.referenceNumber,
            status: row.status,
            supplierName: row.supplierName ?? null,
            currency: row.currency || 'CHF',
            createdAt: row.createdAt,
            items: (0, production_1.parsePurchaseLines)(row.items),
        }));
    }
}
exports.PrismaPurchaseOrderReader = PrismaPurchaseOrderReader;
//# sourceMappingURL=PurchaseOrderReader.js.map