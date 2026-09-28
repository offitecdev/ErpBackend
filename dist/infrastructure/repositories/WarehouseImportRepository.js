"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaWarehouseImportRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const WarehouseCodeIssuer_1 = require("./WarehouseCodeIssuer");
const WarehouseRepository_1 = require("./WarehouseRepository");
/**
 * ── DEPO: EXCEL-AKTARIM MIT FREIGABE (26.09.2026, 2. Durchgang) ─────────────
 *
 * «Excel seçim aktarılacak ama izin bekleniyor; izin verildiğinde olması
 *  lazım — aktarılsın mı diye?»
 *
 * Ein Aktarım liegt mit seinen Zeilen hier, bis die Verwaltung entscheidet.
 * Die Freigabe nimmt ihn IM SELBEN VORGANG, in dem die Karten entstehen:
 * `UPDATE … WHERE status = 'PENDING'` trifft genau einmal — eine zweite,
 * gleichzeitige Freigabe findet nichts mehr und legt nichts doppelt an.
 * Scheitert das Anlegen, rollt alles zurück und der Aktarım wartet weiter.
 */
const sqlNow = () => new Date().toISOString().slice(0, 23).replace('T', ' ');
const parseJson = (value, fallback) => {
    if (value === null || value === undefined)
        return fallback;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value);
        }
        catch {
            return fallback;
        }
    }
    return value;
};
const STATUSES = ['PENDING', 'DONE', 'REJECTED', 'CANCELLED'];
const toSummary = (row) => ({
    id: row.id,
    tenantId: row.tenantId,
    status: STATUSES.includes(row.status) ? row.status : 'PENDING',
    fileName: row.fileName ?? null,
    rowCount: row.rowCount,
    requestedById: row.requestedById ?? null,
    requestedByName: row.requestedByName ?? null,
    decidedById: row.decidedById ?? null,
    decidedByName: row.decidedByName ?? null,
    decidedAt: row.decidedAt ?? null,
    note: row.note ?? null,
    result: parseJson(row.result, null),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});
const SUMMARY_SELECT = {
    id: true,
    tenantId: true,
    status: true,
    fileName: true,
    rowCount: true,
    requestedById: true,
    requestedByName: true,
    decidedById: true,
    decidedByName: true,
    decidedAt: true,
    note: true,
    result: true,
    createdAt: true,
    updatedAt: true,
};
class PrismaWarehouseImportRepository {
    async list(tenantId, limit) {
        const rows = await prisma_client_1.default.warehouseImport.findMany({
            where: { tenantId },
            select: SUMMARY_SELECT,
            orderBy: [{ createdAt: 'desc' }],
            take: limit,
        });
        return rows.map(toSummary);
    }
    async get(tenantId, id) {
        const row = await prisma_client_1.default.warehouseImport.findFirst({ where: { id, tenantId } });
        if (!row)
            return null;
        return { ...toSummary(row), rows: parseJson(row.rows, []) };
    }
    pendingCount(tenantId) {
        return prisma_client_1.default.warehouseImport.count({ where: { tenantId, status: 'PENDING' } });
    }
    async create(tenantId, input) {
        const id = (0, WarehouseRepository_1.newId)();
        await prisma_client_1.default.warehouseImport.create({
            data: {
                id,
                tenantId,
                status: 'PENDING',
                fileName: input.fileName,
                rowCount: input.rows.length,
                rows: input.rows,
                requestedById: input.requestedById,
                requestedByName: input.requestedByName,
            },
        });
        const created = await this.get(tenantId, id);
        if (!created)
            throw new Error('Depo: neuer Aktarım nicht lesbar.');
        return created;
    }
    async close(tenantId, id, input) {
        const result = await prisma_client_1.default.warehouseImport.updateMany({
            where: { id, tenantId, status: 'PENDING' },
            data: {
                status: input.status,
                decidedById: input.decidedById,
                decidedByName: input.decidedByName,
                decidedAt: new Date(),
                note: input.note,
            },
        });
        return result.count > 0;
    }
    async execute(tenantId, id, input) {
        return prisma_client_1.default.$transaction(async (tx) => {
            const now = sqlNow();
            const claimed = await tx.$executeRaw `
                UPDATE depo_aktarimlar
                   SET status = 'DONE', decidedById = ${input.decidedById}, decidedByName = ${input.decidedByName},
                       decidedAt = ${now}, updatedAt = ${now}
                 WHERE id = ${id} AND tenantId = ${tenantId} AND status = 'PENDING'`;
            if (!claimed)
                return null;
            // Je Gruppe ein Block Nummern, in der Reihenfolge der Datei.
            const byGroup = new Map();
            for (const create of input.creates) {
                const groupId = create.fields.materialGroupId;
                if (!groupId)
                    continue;
                const list = byGroup.get(groupId) ?? [];
                list.push(create);
                byGroup.set(groupId, list);
            }
            const codeOf = new Map();
            // Gruppen immer in derselben Reihenfolge sperren — zwei gleichzeitige
            // Vorgänge warten dann aufeinander, statt sich zu verklemmen.
            const ordered = [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
            for (const [groupId, list] of ordered) {
                const codes = await (0, WarehouseCodeIssuer_1.reserveErpCodes)(tx, tenantId, groupId, list.length);
                list.forEach((create, index) => { const code = codes[index]; if (code)
                    codeOf.set(create, code); });
            }
            const coded = input.creates.filter((create) => codeOf.has(create));
            const barcodes = await (0, WarehouseCodeIssuer_1.reserveBarcodes)(tx, tenantId, coded.length);
            const barcodeOf = new Map(coded.map((create, index) => [create, barcodes[index] ?? null]));
            const data = input.creates.map((create) => ({
                id: (0, WarehouseRepository_1.newId)(),
                tenantId,
                ...(0, WarehouseRepository_1.productData)(create.fields),
                erpCode: codeOf.get(create) ?? null,
                barcode: barcodeOf.get(create) ?? null,
                quantity: create.fields.serialRequired ? 0 : create.fields.quantity,
                createdById: input.createdById,
                updatedById: input.decidedById,
            }));
            for (let index = 0; index < data.length; index += 500) {
                await tx.warehouseProduct.createMany({ data: data.slice(index, index + 500) });
            }
            const suppliers = input.creates.flatMap((create, index) => (0, WarehouseRepository_1.supplierRows)(tenantId, data[index].id, create.fields.suppliers));
            for (let index = 0; index < suppliers.length; index += 500) {
                await tx.warehouseProductSupplier.createMany({ data: suppliers.slice(index, index + 500) });
            }
            const issued = input.creates.map((create) => codeOf.get(create)).filter((code) => Boolean(code));
            const result = {
                created: data.length,
                skipped: input.failed.length,
                failed: input.failed.slice(0, 500),
                firstCode: issued[0] ?? null,
                lastCode: issued[issued.length - 1] ?? null,
            };
            await tx.warehouseImport.update({
                where: { id },
                data: { result: result },
            });
            return result;
        }, WarehouseCodeIssuer_1.CODE_TX_OPTIONS);
    }
}
exports.PrismaWarehouseImportRepository = PrismaWarehouseImportRepository;
//# sourceMappingURL=WarehouseImportRepository.js.map