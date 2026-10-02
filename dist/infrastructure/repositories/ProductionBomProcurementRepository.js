"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaBomGoodsInRepository = exports.PrismaBomProcurementRepository = void 0;
const nanoid_1 = require("nanoid");
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const ProductionBom_1 = require("../../domain/entities/ProductionBom");
const productionBom_1 = require("../../domain/services/productionBom");
/**
 * ── SATIN ALMA TALEBİ & GELEN MALLAR · DIE DATENBANKSEITE (27.09.2026) ───────
 *
 * `uretim_bom_talepleri` — was die BOM beim Einkauf bestellt oder anfragt,
 * ohne Lieferant und Preis; `uretim_bom_gelen_mallar` — wohin eingegangene
 * Ware bei der Buchung ging. Keine Fremdschlüssel (wie alle `uretim_*`).
 */
const newId = () => (0, nanoid_1.nanoid)(12);
const num = (value) => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};
const str = (value) => {
    const clean = String(value ?? '').trim();
    return clean ? clean : null;
};
const KINDS = new Set(['PRICE', 'ORDER']);
const STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']);
const linesOf = (value) => {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            return [];
        const record = entry;
        const bomLineId = str(record.bomLineId);
        const productId = str(record.productId);
        if (!bomLineId || !productId)
            return [];
        return [{
                bomLineId,
                productId,
                erpCode: str(record.erpCode),
                name: String(record.name ?? ''),
                brand: str(record.brand),
                modelNumber: str(record.modelNumber),
                unit: (0, productionBom_1.unitFrom)(record.unit),
                quantity: (0, productionBom_1.round3)(num(record.quantity)),
                note: str(record.note),
            }];
    });
};
const idsOf = (value) => (Array.isArray(value) ? value : []).map((entry) => String(entry ?? '').trim()).filter(Boolean);
/* Bis zum 29.09.2026 schloss sich ein Fiyat talebi von selbst, sobald jede Zeile
   angefragt war (DONE ohne closedAt). Es bleibt seither offen, bis der Einkauf es
   schliesst — die so geschlossenen gelten wieder als in Arbeit. Von Hand
   geschlossene (closedAt gesetzt) bleiben erledigt. */
const statusOf = (row) => {
    const status = STATUSES.has(row.status) ? row.status : 'OPEN';
    return row.kind === 'PRICE' && status === 'DONE' && !row.closedAt ? 'IN_PROGRESS' : status;
};
const toRequest = (row) => ({
    id: row.id,
    tenantId: row.tenantId,
    requestNumber: row.requestNumber,
    bomId: row.bomId,
    productionProjectId: row.productionProjectId,
    productionItemId: row.productionItemId,
    area: ((0, ProductionBom_1.isCustomBomCategory)(row.area) ? row.area : row.area === 'ELECTRICAL' ? 'ELECTRICAL' : 'MECHANICAL'),
    kind: KINDS.has(row.kind) ? row.kind : 'ORDER',
    status: statusOf(row),
    bomRevision: Number(row.bomRevision) || 0,
    lines: linesOf(row.lines),
    note: row.note,
    purchaseOrderIds: idsOf(row.purchaseOrderIds),
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedById: row.closedById,
    closedAt: row.closedAt,
});
/** «TLP-2026-00001» — Jahr und fünfstelliger Zähler je Firma und Jahr. */
const REQUEST_PREFIX = 'TLP';
/** Wie die BOM-Nummern: `LAST_INSERT_ID(expr)` in derselben Verbindung der Transaktion. */
const bumpCounter = async (tx, tenantId, docType) => {
    await tx.$executeRaw `
        INSERT INTO \`DocumentCounter\` (\`tenantId\`, \`docType\`, \`lastValue\`, \`updatedAt\`)
        VALUES (${tenantId}, ${docType}, LAST_INSERT_ID(1), NOW(3))
        ON DUPLICATE KEY UPDATE \`lastValue\` = LAST_INSERT_ID(\`lastValue\` + 1), \`updatedAt\` = NOW(3)`;
    const rows = await tx.$queryRaw `SELECT LAST_INSERT_ID() AS \`seq\``;
    const seq = num(rows[0]?.seq);
    if (seq < 1)
        throw new Error('Talep-Nummer konnte nicht vergeben werden.');
    return seq;
};
class PrismaBomProcurementRepository {
    async activityForBoms(tenantId, bomIds) {
        if (!bomIds.length)
            return [];
        const rows = await prisma_client_1.default.productionBomProcurementRequest.findMany({
            where: { tenantId, bomId: { in: [...new Set(bomIds)] } },
            select: { bomId: true, requestNumber: true, kind: true, status: true, lines: true },
            orderBy: { createdAt: 'desc' },
        });
        return rows.map((row) => ({ bomId: row.bomId, requestNumber: row.requestNumber, kind: row.kind, status: row.status, lineIds: linesOf(row.lines).map((line) => line.bomLineId) }));
    }
    async create(tenantId, input, userId) {
        const year = new Date().getFullYear();
        const row = await prisma_client_1.default.$transaction(async (tx) => {
            for (let attempt = 0; attempt < 20; attempt += 1) {
                const seq = await bumpCounter(tx, tenantId, `BOM_TALEP:${year}`);
                const requestNumber = `${REQUEST_PREFIX}-${year}-${String(seq).padStart(5, '0')}`;
                const taken = await tx.productionBomProcurementRequest.findFirst({ where: { tenantId, requestNumber }, select: { id: true } });
                if (taken)
                    continue;
                return tx.productionBomProcurementRequest.create({
                    data: {
                        id: newId(),
                        tenantId,
                        requestNumber,
                        bomId: input.bomId,
                        productionProjectId: input.productionProjectId,
                        productionItemId: input.productionItemId,
                        area: input.area,
                        kind: input.kind,
                        status: 'OPEN',
                        bomRevision: input.bomRevision,
                        lines: input.lines,
                        note: input.note,
                        purchaseOrderIds: [],
                        createdById: userId,
                    },
                });
            }
            throw new Error('Talep-Nummer konnte nicht vergeben werden.');
        });
        return toRequest(row);
    }
    async get(tenantId, id) {
        const row = await prisma_client_1.default.productionBomProcurementRequest.findFirst({ where: { tenantId, id } });
        return row ? toRequest(row) : null;
    }
    async list(tenantId, filter = {}) {
        const where = { tenantId };
        if (filter.statuses?.length)
            where.status = { in: filter.statuses };
        if (filter.bomIds) {
            const ids = [...new Set(filter.bomIds.filter(Boolean))];
            if (!ids.length)
                return [];
            where.bomId = { in: ids };
        }
        const rows = await prisma_client_1.default.productionBomProcurementRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 });
        return rows.map(toRequest);
    }
    async update(tenantId, id, patch) {
        const data = {};
        if (patch.status)
            data.status = patch.status;
        if (patch.purchaseOrderIds)
            data.purchaseOrderIds = [...new Set(patch.purchaseOrderIds)];
        if (patch.closedById !== undefined)
            data.closedById = patch.closedById;
        if (patch.closedAt !== undefined)
            data.closedAt = patch.closedAt;
        const result = await prisma_client_1.default.productionBomProcurementRequest.updateMany({ where: { tenantId, id }, data });
        return result.count ? this.get(tenantId, id) : null;
    }
}
exports.PrismaBomProcurementRepository = PrismaBomProcurementRepository;
const toGoods = (row) => ({
    id: row.id,
    tenantId: row.tenantId,
    receiptId: row.receiptId,
    source: row.source === 'STOCK' ? 'STOCK' : 'ORDER',
    purchaseOrderId: row.purchaseOrderId,
    referenceNumber: row.referenceNumber,
    productId: row.productId,
    erpCode: row.erpCode,
    name: row.name,
    bomId: row.bomId,
    lineId: row.lineId,
    productionProjectId: row.productionProjectId,
    productionItemId: row.productionItemId,
    quantity: (0, productionBom_1.round3)(num(row.quantity)),
    serials: idsOf(row.serials),
    receivedById: row.receivedById,
    receivedAt: row.receivedAt,
});
class PrismaBomGoodsInRepository {
    async totalsForBoms(tenantId, bomIds) {
        if (!bomIds.length)
            return [];
        const rows = await prisma_client_1.default.productionBomGoodsIn.groupBy({
            by: ['bomId', 'lineId'],
            where: { tenantId, bomId: { in: [...new Set(bomIds)] } },
            _sum: { quantity: true }, _count: { _all: true },
        });
        return rows.map((row) => ({ bomId: row.bomId, lineId: row.lineId, quantity: (0, productionBom_1.round3)(num(row._sum.quantity)), count: row._count._all }));
    }
    async add(tenantId, rows) {
        if (!rows.length)
            return;
        await prisma_client_1.default.productionBomGoodsIn.createMany({
            data: rows.map((row) => ({
                id: newId(),
                tenantId,
                receiptId: row.receiptId.slice(0, 32),
                source: row.source,
                purchaseOrderId: row.purchaseOrderId,
                referenceNumber: row.referenceNumber?.slice(0, 40) ?? null,
                productId: row.productId,
                erpCode: row.erpCode?.slice(0, 64) ?? null,
                name: (row.name || '—').slice(0, 255),
                bomId: row.bomId,
                lineId: row.lineId,
                productionProjectId: row.productionProjectId,
                productionItemId: row.productionItemId,
                quantity: new client_1.Prisma.Decimal((0, productionBom_1.round3)(row.quantity)),
                serials: row.serials.length ? row.serials : client_1.Prisma.JsonNull,
                receivedById: row.receivedById,
                receivedAt: row.receivedAt,
            })),
        });
    }
    async forBoms(tenantId, bomIds) {
        const ids = [...new Set(bomIds.filter(Boolean))];
        if (!ids.length)
            return [];
        const rows = await prisma_client_1.default.productionBomGoodsIn.findMany({
            where: { tenantId, bomId: { in: ids } },
            orderBy: { receivedAt: 'desc' },
            take: 1000,
        });
        return rows.map(toGoods);
    }
    async recent(tenantId, limit) {
        const rows = await prisma_client_1.default.productionBomGoodsIn.findMany({
            where: { tenantId },
            orderBy: { receivedAt: 'desc' },
            take: Math.max(1, Math.min(500, limit)),
        });
        return rows.map(toGoods);
    }
    /* «Geri al» einer Depo-Buchung (28.09.2026, BomStockReceiptUseCase). */
    async forReceipt(tenantId, receiptId) {
        const id = receiptId.trim().slice(0, 32);
        if (!id)
            return [];
        const rows = await prisma_client_1.default.productionBomGoodsIn.findMany({ where: { tenantId, receiptId: id } });
        return rows.map(toGoods);
    }
    async shrink(tenantId, changes) {
        const gone = changes.filter((change) => (0, productionBom_1.round3)(change.quantity) <= 0).map((change) => change.id);
        const kept = changes.filter((change) => (0, productionBom_1.round3)(change.quantity) > 0);
        if (!gone.length && !kept.length)
            return;
        await prisma_client_1.default.$transaction([
            ...(gone.length ? [prisma_client_1.default.productionBomGoodsIn.deleteMany({ where: { tenantId, id: { in: gone } } })] : []),
            ...kept.map((change) => prisma_client_1.default.productionBomGoodsIn.updateMany({
                where: { tenantId, id: change.id },
                data: {
                    quantity: new client_1.Prisma.Decimal((0, productionBom_1.round3)(change.quantity)),
                    serials: change.serials.length ? change.serials : client_1.Prisma.JsonNull,
                },
            })),
        ]);
    }
}
exports.PrismaBomGoodsInRepository = PrismaBomGoodsInRepository;
//# sourceMappingURL=ProductionBomProcurementRepository.js.map