import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';

import prisma from '../database/prisma.client';
import type {
    BomArea,
    BomGoodsIn,
    BomProcurementKind,
    BomProcurementLine,
    BomProcurementRequest,
    BomProcurementStatus,
    BomPurchaseKind,
} from '../../domain/entities/ProductionBom';
import type {
    BomProcurementCreateInput,
    IBomGoodsInRepository,
    IBomProcurementRepository,
} from '../../domain/repositories/IProductionBomRepository';
import { round3, unitFrom } from '../../domain/services/productionBom';
import type { WarehouseTx } from './WarehouseCodeIssuer';

/**
 * ── SATIN ALMA TALEBİ & GELEN MALLAR · DIE DATENBANKSEITE (27.09.2026) ───────
 *
 * `uretim_bom_talepleri` — was die BOM beim Einkauf bestellt oder anfragt,
 * ohne Lieferant und Preis; `uretim_bom_gelen_mallar` — wohin eingegangene
 * Ware bei der Buchung ging. Keine Fremdschlüssel (wie alle `uretim_*`).
 */

const newId = (): string => nanoid(12);
const num = (value: unknown): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};
const str = (value: unknown): string | null => {
    const clean = String(value ?? '').trim();
    return clean ? clean : null;
};

const KINDS = new Set<BomProcurementKind>(['PRICE', 'ORDER']);
const STATUSES = new Set<BomProcurementStatus>(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']);

const linesOf = (value: Prisma.JsonValue | null): BomProcurementLine[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): BomProcurementLine[] => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const record = entry as Record<string, unknown>;
        const bomLineId = str(record.bomLineId);
        const productId = str(record.productId);
        if (!bomLineId || !productId) return [];
        return [{
            bomLineId,
            productId,
            erpCode: str(record.erpCode),
            name: String(record.name ?? ''),
            brand: str(record.brand),
            modelNumber: str(record.modelNumber),
            unit: unitFrom(record.unit),
            quantity: round3(num(record.quantity)),
            note: str(record.note),
        }];
    });
};

const idsOf = (value: Prisma.JsonValue | null): string[] =>
    (Array.isArray(value) ? value : []).map((entry) => String(entry ?? '').trim()).filter(Boolean);

type RequestRow = Prisma.ProductionBomProcurementRequestGetPayload<Record<string, never>>;

const toRequest = (row: RequestRow): BomProcurementRequest => ({
    id: row.id,
    tenantId: row.tenantId,
    requestNumber: row.requestNumber,
    bomId: row.bomId,
    productionProjectId: row.productionProjectId,
    productionItemId: row.productionItemId,
    area: (row.area === 'ELECTRICAL' ? 'ELECTRICAL' : 'MECHANICAL') as BomArea,
    kind: KINDS.has(row.kind as BomProcurementKind) ? row.kind as BomProcurementKind : 'ORDER',
    status: STATUSES.has(row.status as BomProcurementStatus) ? row.status as BomProcurementStatus : 'OPEN',
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

type Tx = WarehouseTx;

/** Wie die BOM-Nummern: `LAST_INSERT_ID(expr)` in derselben Verbindung der Transaktion. */
const bumpCounter = async (tx: Tx, tenantId: string, docType: string): Promise<number> => {
    await tx.$executeRaw`
        INSERT INTO \`DocumentCounter\` (\`tenantId\`, \`docType\`, \`lastValue\`, \`updatedAt\`)
        VALUES (${tenantId}, ${docType}, LAST_INSERT_ID(1), NOW(3))
        ON DUPLICATE KEY UPDATE \`lastValue\` = LAST_INSERT_ID(\`lastValue\` + 1), \`updatedAt\` = NOW(3)`;
    const rows = await tx.$queryRaw<Array<{ seq: unknown }>>`SELECT LAST_INSERT_ID() AS \`seq\``;
    const seq = num(rows[0]?.seq);
    if (seq < 1) throw new Error('Talep-Nummer konnte nicht vergeben werden.');
    return seq;
};

export class PrismaBomProcurementRepository implements IBomProcurementRepository {
    async create(tenantId: string, input: BomProcurementCreateInput, userId: string): Promise<BomProcurementRequest> {
        const year = new Date().getFullYear();
        const row = await prisma.$transaction(async (tx) => {
            for (let attempt = 0; attempt < 20; attempt += 1) {
                const seq = await bumpCounter(tx, tenantId, `BOM_TALEP:${year}`);
                const requestNumber = `${REQUEST_PREFIX}-${year}-${String(seq).padStart(5, '0')}`;
                const taken = await tx.productionBomProcurementRequest.findFirst({ where: { tenantId, requestNumber }, select: { id: true } });
                if (taken) continue;
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
                        lines: input.lines as unknown as Prisma.InputJsonValue,
                        note: input.note,
                        purchaseOrderIds: [] as unknown as Prisma.InputJsonValue,
                        createdById: userId,
                    },
                });
            }
            throw new Error('Talep-Nummer konnte nicht vergeben werden.');
        });
        return toRequest(row);
    }

    async get(tenantId: string, id: string): Promise<BomProcurementRequest | null> {
        const row = await prisma.productionBomProcurementRequest.findFirst({ where: { tenantId, id } });
        return row ? toRequest(row) : null;
    }

    async list(tenantId: string, filter: { statuses?: string[]; bomIds?: string[] } = {}): Promise<BomProcurementRequest[]> {
        const where: Prisma.ProductionBomProcurementRequestWhereInput = { tenantId };
        if (filter.statuses?.length) where.status = { in: filter.statuses };
        if (filter.bomIds) {
            const ids = [...new Set(filter.bomIds.filter(Boolean))];
            if (!ids.length) return [];
            where.bomId = { in: ids };
        }
        const rows = await prisma.productionBomProcurementRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 });
        return rows.map(toRequest);
    }

    async update(
        tenantId: string,
        id: string,
        patch: { status?: BomProcurementStatus; purchaseOrderIds?: string[]; closedById?: string | null; closedAt?: Date | null },
    ): Promise<BomProcurementRequest | null> {
        const data: Prisma.ProductionBomProcurementRequestUpdateManyMutationInput = {};
        if (patch.status) data.status = patch.status;
        if (patch.purchaseOrderIds) data.purchaseOrderIds = [...new Set(patch.purchaseOrderIds)] as unknown as Prisma.InputJsonValue;
        if (patch.closedById !== undefined) data.closedById = patch.closedById;
        if (patch.closedAt !== undefined) data.closedAt = patch.closedAt;
        const result = await prisma.productionBomProcurementRequest.updateMany({ where: { tenantId, id }, data });
        return result.count ? this.get(tenantId, id) : null;
    }

    async purchaseLinks(tenantId: string) {
        const rows = await prisma.productionBomPurchase.findMany({
            where: { tenantId },
            select: { purchaseOrderId: true, bomId: true, kind: true, productionProjectId: true, productionItemId: true },
            orderBy: { createdAt: 'desc' },
            take: 2000,
        });
        return rows.map((row) => ({ ...row, kind: (row.kind === 'REQUEST' ? 'REQUEST' : 'ORDER') as BomPurchaseKind }));
    }
}

type GoodsRow = Prisma.ProductionBomGoodsInGetPayload<Record<string, never>>;

const toGoods = (row: GoodsRow): BomGoodsIn => ({
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
    quantity: round3(num(row.quantity)),
    serials: idsOf(row.serials),
    receivedById: row.receivedById,
    receivedAt: row.receivedAt,
});

export class PrismaBomGoodsInRepository implements IBomGoodsInRepository {
    async add(tenantId: string, rows: Array<Omit<BomGoodsIn, 'id' | 'tenantId'>>): Promise<void> {
        if (!rows.length) return;
        await prisma.productionBomGoodsIn.createMany({
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
                quantity: new Prisma.Decimal(round3(row.quantity)),
                serials: row.serials.length ? row.serials as unknown as Prisma.InputJsonValue : Prisma.JsonNull,
                receivedById: row.receivedById,
                receivedAt: row.receivedAt,
            })),
        });
    }

    async forBoms(tenantId: string, bomIds: string[]): Promise<BomGoodsIn[]> {
        const ids = [...new Set(bomIds.filter(Boolean))];
        if (!ids.length) return [];
        const rows = await prisma.productionBomGoodsIn.findMany({
            where: { tenantId, bomId: { in: ids } },
            orderBy: { receivedAt: 'desc' },
            take: 1000,
        });
        return rows.map(toGoods);
    }

    async recent(tenantId: string, limit: number): Promise<BomGoodsIn[]> {
        const rows = await prisma.productionBomGoodsIn.findMany({
            where: { tenantId },
            orderBy: { receivedAt: 'desc' },
            take: Math.max(1, Math.min(500, limit)),
        });
        return rows.map(toGoods);
    }

    /* «Geri al» einer Depo-Buchung (28.09.2026, BomStockReceiptUseCase). */

    async forReceipt(tenantId: string, receiptId: string): Promise<BomGoodsIn[]> {
        const id = receiptId.trim().slice(0, 32);
        if (!id) return [];
        const rows = await prisma.productionBomGoodsIn.findMany({ where: { tenantId, receiptId: id } });
        return rows.map(toGoods);
    }

    async shrink(tenantId: string, changes: Array<{ id: string; quantity: number; serials: string[] }>): Promise<void> {
        const gone = changes.filter((change) => round3(change.quantity) <= 0).map((change) => change.id);
        const kept = changes.filter((change) => round3(change.quantity) > 0);
        if (!gone.length && !kept.length) return;
        await prisma.$transaction([
            ...(gone.length ? [prisma.productionBomGoodsIn.deleteMany({ where: { tenantId, id: { in: gone } } })] : []),
            ...kept.map((change) => prisma.productionBomGoodsIn.updateMany({
                where: { tenantId, id: change.id },
                data: {
                    quantity: new Prisma.Decimal(round3(change.quantity)),
                    serials: change.serials.length ? change.serials as unknown as Prisma.InputJsonValue : Prisma.JsonNull,
                },
            })),
        ]);
    }
}
