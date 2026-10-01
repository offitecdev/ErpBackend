import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';

import prisma from '../database/prisma.client';
import type {
    Bom,
    BomArea,
    BomCategory,
    BomKind,
    BomIncomingLine,
    BomLine,
    BomLineDraft,
    BomPurchaseKind,
    BomPurchaseLineRecord,
    BomPurchaseLink,
    BomSerialFact,
    BomSettings,
    BomStatus,
    BomStockProduct,
    BomTemplate,
    BomTemplateInput,
    BomTemplateLine,
    BomTemplateSummary,
    BomUnit,
} from '../../domain/entities/ProductionBom';
import { BOM_UNITS } from '../../domain/entities/ProductionBom';
import type {
    BomConsumePlan,
    BomCreateInput,
    BomDeviceFacts,
    BomProjectFacts,
    BomPurchaseOrderRow,
    IBomProductionDirectory,
    IBomPurchaseRepository,
    IBomRepository,
    IBomSettingsRepository,
    IBomStockReader,
    IBomTemplateRepository,
} from '../../domain/repositories/IProductionBomRepository';
import {
    bomError,
    BOM_LIMITS,
    CONFIRMED_ORDER_STATUSES,
    formatBomNumber,
    PRICE_REQUEST_STATUSES,
    round3,
    storedCodes,
    unitFrom,
} from '../../domain/services/productionBom';
import { CARD_TX_OPTIONS, type WarehouseTx } from './WarehouseCodeIssuer';

/**
 * ── BOM · DIE DATENBANKSEITE (27.09.2026) ────────────────────────────────────
 *
 * Eigene Tabellen `uretim_bom_*`; das Depo (`depo_*`) wird gelesen und nur an
 * zwei Stellen geschrieben: Seriennummern bekommen Projekt/Gerät (das IST die
 * Reservierung, die das Depo schon kennt) und «Stoktan düş» nimmt Bestand und
 * Nummern von der Karte. Die entfernte Datenbank kostet je Anfrage einen
 * Rundgang — Lesewege schicken ihre Abfragen gleichzeitig los.
 */

const newId = (): string => nanoid(12);
const num = (value: unknown): number => {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
};
const numOrNull = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};
const dateOrNull = (value: unknown): Date | null => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
};
const toDate = (value: unknown): Date => dateOrNull(value) ?? new Date(0);
const str = (value: unknown): string | null => {
    const clean = String(value ?? '').trim();
    return clean ? clean : null;
};
const categoryOf = (value: string): BomCategory => (value === 'ELECTRICAL' ? 'ELECTRICAL' : 'MACHINE');
const areaOf = (value: string): BomArea => (value === 'ELECTRICAL' ? 'ELECTRICAL' : 'MECHANICAL');
const statusOf = (value: string): BomStatus =>
    (value === 'APPROVED' || value === 'COMPLETED' ? value : 'DRAFT');
const likeOf = (value: string): string => `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

type Tx = WarehouseTx;

/* ═══════════════════════════ VORLAGEN ═════════════════════════════════════ */

type TemplateLineRow = {
    id: string;
    productId: string;
    erpCode: string | null;
    name: string;
    brand: string | null;
    modelNumber: string | null;
    quantity: Prisma.Decimal | number;
    unit: string | null;
    note: string | null;
    sortOrder: number;
};

const toTemplateLine = (row: TemplateLineRow): BomTemplateLine => ({
    id: row.id,
    productId: row.productId,
    erpCode: row.erpCode,
    name: row.name,
    brand: row.brand,
    modelNumber: row.modelNumber,
    quantity: round3(num(row.quantity)),
    unit: unitFrom(row.unit),
    note: row.note,
    sortOrder: row.sortOrder,
});

const templateLineData = (tenantId: string, templateId: string, lines: BomLineDraft[]) =>
    lines.map((line, index) => ({
        id: newId(),
        tenantId,
        templateId,
        productId: line.productId,
        erpCode: line.erpCode,
        name: line.name.slice(0, 255),
        brand: line.brand,
        modelNumber: line.modelNumber,
        quantity: new Prisma.Decimal(round3(line.quantity)),
        unit: line.unit,
        note: line.note,
        sortOrder: index,
    }));

export class PrismaBomTemplateRepository implements IBomTemplateRepository {
    async list(tenantId: string): Promise<BomTemplateSummary[]> {
        const [rows, usage] = await Promise.all([
            prisma.productionBomTemplate.findMany({
                where: { tenantId, deletedAt: null },
                select: {
                    id: true,
                    name: true,
                    category: true,
                    mainCard: true,
                    codePrefix: true,
                    exampleKey: true,
                    sortOrder: true,
                    updatedAt: true,
                    _count: { select: { lines: true } },
                },
                orderBy: [{ mainCard: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
            }),
            prisma.productionBom.groupBy({
                by: ['templateId'],
                where: { tenantId, templateId: { not: null } },
                _count: { _all: true },
            }),
        ]);
        const used = new Map(usage.map((row) => [row.templateId ?? '', row._count._all]));
        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            category: categoryOf(row.category),
            mainCard: row.mainCard,
            codePrefix: row.codePrefix,
            lineCount: row._count.lines,
            usedBy: used.get(row.id) ?? 0,
            exampleKey: row.exampleKey,
            sortOrder: row.sortOrder,
            updatedAt: row.updatedAt,
        }));
    }

    async get(tenantId: string, id: string): Promise<BomTemplate | null> {
        const row = await prisma.productionBomTemplate.findFirst({
            where: { id, tenantId, deletedAt: null },
            include: { lines: { orderBy: { sortOrder: 'asc' } } },
        });
        if (!row) return null;
        return {
            id: row.id,
            tenantId: row.tenantId,
            name: row.name,
            category: categoryOf(row.category),
            mainCard: row.mainCard,
            codePrefix: row.codePrefix,
            description: row.description,
            exampleKey: row.exampleKey,
            sortOrder: row.sortOrder,
            createdById: row.createdById,
            updatedById: row.updatedById,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            lines: row.lines.map(toTemplateLine),
        };
    }

    async create(tenantId: string, input: BomTemplateInput, userId: string | null, exampleKey: string | null = null): Promise<BomTemplate> {
        const id = newId();
        const last = await prisma.productionBomTemplate.findFirst({
            where: { tenantId, mainCard: input.mainCard },
            orderBy: { sortOrder: 'desc' },
            select: { sortOrder: true },
        });
        await prisma.$transaction(async (tx) => {
            await tx.productionBomTemplate.create({
                data: {
                    id,
                    tenantId,
                    name: input.name,
                    category: input.category,
                    mainCard: input.mainCard,
                    codePrefix: input.codePrefix,
                    description: input.description,
                    exampleKey,
                    sortOrder: (last?.sortOrder ?? -1) + 1,
                    createdById: userId,
                    updatedById: userId,
                },
            });
            if (input.lines.length) {
                await tx.productionBomTemplateLine.createMany({ data: templateLineData(tenantId, id, input.lines) });
            }
        }, CARD_TX_OPTIONS);
        const created = await this.get(tenantId, id);
        if (!created) throw new Error('BOM-Vorlage nach dem Anlegen nicht lesbar.');
        return created;
    }

    async update(tenantId: string, id: string, input: BomTemplateInput, userId: string): Promise<BomTemplate | null> {
        const changed = await prisma.$transaction(async (tx) => {
            const result = await tx.productionBomTemplate.updateMany({
                where: { id, tenantId, deletedAt: null },
                data: {
                    name: input.name,
                    category: input.category,
                    mainCard: input.mainCard,
                    codePrefix: input.codePrefix,
                    description: input.description,
                    updatedById: userId,
                },
            });
            if (!result.count) return false;
            await tx.productionBomTemplateLine.deleteMany({ where: { templateId: id, tenantId } });
            if (input.lines.length) {
                await tx.productionBomTemplateLine.createMany({ data: templateLineData(tenantId, id, input.lines) });
            }
            return true;
        }, CARD_TX_OPTIONS);
        return changed ? this.get(tenantId, id) : null;
    }

    async remove(tenantId: string, id: string, userId: string): Promise<boolean> {
        const result = await prisma.productionBomTemplate.updateMany({
            where: { id, tenantId, deletedAt: null },
            data: { deletedAt: new Date(), updatedById: userId },
        });
        return result.count > 0;
    }

    async exampleKeys(tenantId: string): Promise<Set<string>> {
        const rows = await prisma.productionBomTemplate.findMany({
            where: { tenantId, exampleKey: { not: null } },
            select: { exampleKey: true },
        });
        return new Set(rows.map((row) => row.exampleKey ?? '').filter(Boolean));
    }
}

/* ═══════════════════════════ BOMs ═════════════════════════════════════════ */

type BomRow = Prisma.ProductionBomGetPayload<{ include: { lines: true } }>;

const toLine = (row: BomRow['lines'][number]): BomLine => ({
    id: row.id,
    bomId: row.bomId,
    productId: row.productId,
    erpCode: row.erpCode,
    name: row.name,
    brand: row.brand,
    modelNumber: row.modelNumber,
    unit: unitFrom(row.unit),
    quantity: round3(num(row.quantity)),
    consumedQuantity: round3(num(row.consumedQuantity)),
    note: row.note,
    sortOrder: row.sortOrder,
});

const toBom = (row: BomRow): Bom => ({
    id: row.id,
    tenantId: row.tenantId,
    productionProjectId: row.productionProjectId,
    productionItemId: row.productionItemId,
    area: areaOf(row.area),
    kind: (row.kind === 'MAIN' ? 'MAIN' : 'SUB') as BomKind,
    parentBomId: row.parentBomId ?? null,
    templateId: row.templateId,
    templateName: row.templateName,
    mainCard: row.mainCard,
    bomNumber: row.bomNumber,
    status: statusOf(row.status),
    revision: Number(row.revision) || 0,
    approvedAt: row.approvedAt,
    approvedById: row.approvedById,
    completedAt: row.completedAt,
    completedById: row.completedById,
    consumedAt: row.consumedAt,
    consumedById: row.consumedById,
    sortOrder: row.sortOrder,
    createdById: row.createdById,
    updatedById: row.updatedById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lines: [...row.lines].sort((a, b) => a.sortOrder - b.sortOrder).map(toLine),
});

const bomLineData = (tenantId: string, bomId: string, lines: BomLineDraft[], keepIds: Array<string | null> = []) =>
    lines.map((line, index) => ({
        id: keepIds[index] ?? newId(),
        tenantId,
        bomId,
        productId: line.productId,
        erpCode: line.erpCode,
        name: line.name.slice(0, 255),
        brand: line.brand,
        modelNumber: line.modelNumber,
        unit: line.unit,
        quantity: new Prisma.Decimal(round3(line.quantity)),
        consumedQuantity: new Prisma.Decimal(0),
        note: line.note,
        sortOrder: index,
    }));

/**
 * Der nächste Wert des Zählers «BOM:<Vorsatz>» (DocumentCounter). Dasselbe
 * Muster wie `shared/documentNumber.ts`: `LAST_INSERT_ID(expr)` in DERSELBEN
 * Verbindung der Transaktion — zwei gleichzeitige BOMs bekommen nie dieselbe
 * Nummer, und eine zurückgerollte BOM verbrennt keine.
 */
const bumpBomCounter = async (tx: Tx, tenantId: string, prefix: string): Promise<number> => {
    const docType = `BOM:${prefix}`.slice(0, 32);
    await tx.$executeRaw`
        INSERT INTO \`DocumentCounter\` (\`tenantId\`, \`docType\`, \`lastValue\`, \`updatedAt\`)
        VALUES (${tenantId}, ${docType}, LAST_INSERT_ID(1), NOW(3))
        ON DUPLICATE KEY UPDATE \`lastValue\` = LAST_INSERT_ID(\`lastValue\` + 1), \`updatedAt\` = NOW(3)`;
    const rows = await tx.$queryRaw<Array<{ seq: unknown }>>`SELECT LAST_INSERT_ID() AS \`seq\``;
    const seq = num(rows[0]?.seq);
    if (seq < 1) throw new Error('BOM-Nummer konnte nicht vergeben werden.');
    return seq;
};

/** Der Schlüssel der Haupt-BOM eines Geräts im Bereich (`uretim_bomlari.mainKey`). */
const mainKeyOf = (productionItemId: string, area: BomArea): string => `${productionItemId}:${area}`.slice(0, 80);

/** Eine Nummer, die weder eine BOM noch eine Depo-Karte schon trägt. */
const issueBomNumber = async (tx: Tx, tenantId: string, prefix: string): Promise<string> => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const candidate = formatBomNumber(prefix, await bumpBomCounter(tx, tenantId, prefix));
        const [bom, card] = await Promise.all([
            tx.productionBom.findFirst({ where: { tenantId, bomNumber: candidate }, select: { id: true } }),
            tx.$queryRaw<Array<{ id: string }>>`
                SELECT id FROM depo_urun_kartlari WHERE tenantId = ${tenantId} AND erpCode = ${candidate} LIMIT 1`,
        ]);
        if (!bom && !card.length) return candidate;
    }
    throw new Error('BOM-Nummer konnte nicht vergeben werden.');
};

export class PrismaBomRepository implements IBomRepository {
    async listForDevice(tenantId: string, productionItemId: string, lineArea?: BomArea): Promise<Bom[]> {
        const rows = await prisma.productionBom.findMany({
            where: { tenantId, productionItemId },
            include: { lines: lineArea ? { where: { bom: { area: lineArea } } } : true },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });
        return rows.map(toBom);
    }

    async getHeader(tenantId: string, id: string): Promise<Omit<Bom, 'lines'> | null> {
        const row = await prisma.productionBom.findFirst({ where: { tenantId, id } });
        if (!row) return null;
        const { lines, ...header } = toBom({ ...row, lines: [] });
        return header;
    }

    async listForProjects(tenantId: string, productionProjectIds: string[] | null): Promise<Bom[]> {
        const ids = productionProjectIds ? [...new Set(productionProjectIds.filter(Boolean))] : null;
        if (ids && !ids.length) return [];
        const rows = await prisma.productionBom.findMany({
            where: { tenantId, ...(ids ? { productionProjectId: { in: ids } } : {}) },
            include: { lines: true },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            take: 3000,
        });
        return rows.map(toBom);
    }

    async get(tenantId: string, id: string): Promise<Bom | null> {
        const row = await prisma.productionBom.findFirst({ where: { id, tenantId }, include: { lines: true } });
        return row ? toBom(row) : null;
    }

    async getMany(tenantId: string, ids: string[]): Promise<Bom[]> {
        const unique = [...new Set(ids.filter(Boolean))];
        if (!unique.length) return [];
        const rows = await prisma.productionBom.findMany({ where: { tenantId, id: { in: unique } }, include: { lines: true } });
        return rows.map(toBom);
    }

    async create(tenantId: string, input: BomCreateInput, userId: string): Promise<Bom> {
        const id = newId();
        await prisma.$transaction(async (tx) => {
            const [bomNumber, last] = await Promise.all([
                issueBomNumber(tx, tenantId, input.codePrefix),
                tx.productionBom.findFirst({
                    where: { tenantId, productionItemId: input.productionItemId },
                    orderBy: { sortOrder: 'desc' },
                    select: { sortOrder: true },
                }),
            ]);
            await tx.productionBom.create({
                data: {
                    id,
                    tenantId,
                    productionProjectId: input.productionProjectId,
                    productionItemId: input.productionItemId,
                    area: input.area,
                    kind: input.kind,
                    parentBomId: input.parentBomId,
                    // Die Haupt-BOM trägt ihren Schlüssel — der eindeutige Index hält sie einmalig.
                    mainKey: input.kind === 'MAIN' ? mainKeyOf(input.productionItemId, input.area) : null,
                    templateId: input.templateId,
                    templateName: input.templateName,
                    mainCard: input.mainCard,
                    bomNumber,
                    status: 'DRAFT',
                    sortOrder: (last?.sortOrder ?? -1) + 1,
                    createdById: userId,
                    updatedById: userId,
                },
            });
            if (input.lines.length) await tx.productionBomLine.createMany({ data: bomLineData(tenantId, id, input.lines) });
        }, CARD_TX_OPTIONS);
        const created = await this.get(tenantId, id);
        if (!created) throw new Error('BOM nach dem Anlegen nicht lesbar.');
        return created;
    }

    async replaceLines(tenantId: string, id: string, lines: BomLineDraft[], userId: string): Promise<Bom | null> {
        const changed = await prisma.$transaction(async (tx) => {
            // Nur der Entwurf nimmt neue Zeilen — die Bedingung sitzt IM Schreiben.
            const claimed = await tx.productionBom.updateMany({
                where: { id, tenantId, status: 'DRAFT' },
                data: { updatedById: userId },
            });
            if (!claimed.count) return false;
            /* Eine Zeile, deren Karte bleibt, behält ihre Kennung — die
               Preisanfragen des Entwurfs (27.09.2026) zeigen über sie auf die
               Zeile; neue Kennungen bei jedem «Kaydet» hätten sie verwaist. */
            const previous = await tx.productionBomLine.findMany({
                where: { bomId: id, tenantId },
                select: { id: true, productId: true },
                orderBy: { sortOrder: 'asc' },
            });
            const free = new Map<string, string[]>();
            for (const row of previous) free.set(row.productId, [...(free.get(row.productId) ?? []), row.id]);
            const keepIds = lines.map((line) => free.get(line.productId)?.shift() ?? null);
            await tx.productionBomLine.deleteMany({ where: { bomId: id, tenantId } });
            if (lines.length) await tx.productionBomLine.createMany({ data: bomLineData(tenantId, id, lines, keepIds) });
            return true;
        }, CARD_TX_OPTIONS);
        return changed ? this.get(tenantId, id) : null;
    }

    async setStatus(
        tenantId: string,
        id: string,
        from: BomStatus[],
        patch: { status: BomStatus; approvedAt?: Date | null; approvedById?: string | null; completedAt?: Date | null; completedById?: string | null },
        userId: string,
    ): Promise<Bom | null> {
        const result = await prisma.productionBom.updateMany({
            where: { id, tenantId, status: { in: from }, consumedAt: null },
            data: { ...patch, updatedById: userId },
        });
        return result.count ? this.get(tenantId, id) : null;
    }

    async remove(tenantId: string, id: string): Promise<boolean> {
        const result = await prisma.productionBom.deleteMany({ where: { id, tenantId, consumedAt: null } });
        return result.count > 0;
    }

    async findMain(tenantId: string, productionItemId: string, area: BomArea): Promise<Bom | null> {
        const row = await prisma.productionBom.findFirst({
            where: { tenantId, mainKey: mainKeyOf(productionItemId, area) },
            include: { lines: true },
        });
        return row ? toBom(row) : null;
    }

    async countChildren(tenantId: string, parentBomId: string): Promise<number> {
        return prisma.productionBom.count({ where: { tenantId, parentBomId } });
    }

    async usageByTemplate(tenantId: string): Promise<Map<string, number>> {
        const rows = await prisma.productionBom.groupBy({
            by: ['templateId'],
            where: { tenantId, templateId: { not: null } },
            _count: { _all: true },
        });
        return new Map(rows.map((row) => [row.templateId ?? '', row._count._all]));
    }

    async openDemandRows(tenantId: string, productIds: string[]) {
        const unique = [...new Set(productIds.filter(Boolean))];
        if (!unique.length) return [];
        const rows = await prisma.$queryRaw<Array<{
            lineId: string;
            bomId: string;
            productId: string;
            productionProjectId: string;
            productionItemId: string;
            quantity: unknown;
            consumedQuantity: unknown;
            approvedAt: unknown;
            bomSortOrder: unknown;
            lineSortOrder: unknown;
        }>>`
            SELECT l.id AS lineId, l.bomId, l.productId, b.productionProjectId, b.productionItemId,
                   l.quantity, l.consumedQuantity, b.approvedAt, b.sortOrder AS bomSortOrder, l.sortOrder AS lineSortOrder
              FROM uretim_bom_satirlari l
              JOIN uretim_bomlari b ON b.id = l.bomId
             WHERE l.tenantId = ${tenantId}
               AND b.tenantId = ${tenantId}
               AND b.status IN ('APPROVED', 'COMPLETED')
               AND b.consumedAt IS NULL
               AND l.productId IN (${Prisma.join(unique)})
               AND l.quantity > l.consumedQuantity`;
        return rows.map((row) => ({
            lineId: row.lineId,
            bomId: row.bomId,
            productId: row.productId,
            productionProjectId: row.productionProjectId,
            productionItemId: row.productionItemId,
            quantity: round3(num(row.quantity)),
            consumedQuantity: round3(num(row.consumedQuantity)),
            approvedAt: dateOrNull(row.approvedAt),
            bomSortOrder: num(row.bomSortOrder),
            lineSortOrder: num(row.lineSortOrder),
        }));
    }

    async consume(tenantId: string, id: string, plan: BomConsumePlan, userId: string): Promise<Bom | null> {
        const done = await prisma.$transaction(async (tx) => {
            // Zuerst die BOM beanspruchen: ein zweiter Klick findet sie schon verbraucht.
            const claimed = await tx.productionBom.updateMany({
                where: { id, tenantId, consumedAt: null, status: { in: ['APPROVED', 'COMPLETED'] } },
                data: { consumedAt: new Date(), consumedById: userId, updatedById: userId },
            });
            if (!claimed.count) return false;

            const consumptions: Prisma.ProductionBomConsumptionCreateManyInput[] = [];
            const recountProducts = new Set<string>();
            for (const line of plan.lines) {
                if (line.serialIds.length) {
                    const removed = await tx.warehouseSerialNumber.deleteMany({
                        where: { tenantId, productId: line.productId, id: { in: line.serialIds } },
                    });
                    if (removed.count !== line.serialIds.length) {
                        throw bomError('STATUS_INVALID', 'Eine reservierte Seriennummer ist nicht mehr an der Karte.', { status: 409 });
                    }
                    recountProducts.add(line.productId);
                    line.serialNumbers.forEach((serialNumber) => consumptions.push({
                        id: newId(),
                        tenantId,
                        bomId: id,
                        lineId: line.lineId,
                        productId: line.productId,
                        quantity: new Prisma.Decimal(1),
                        serialNumber,
                        consumedById: userId,
                    }));
                } else if (line.quantity > 0) {
                    const changed = await tx.$executeRaw`
                        UPDATE depo_urun_kartlari
                           SET quantity = quantity - ${line.quantity}, updatedById = ${userId}, updatedAt = NOW(3)
                         WHERE id = ${line.productId} AND tenantId = ${tenantId}
                           AND serialRequired = 0 AND quantity >= ${line.quantity}`;
                    if (!changed) {
                        throw bomError('STATUS_INVALID', 'Der Bestand einer Karte reicht nicht mehr.', { status: 409 });
                    }
                    consumptions.push({
                        id: newId(),
                        tenantId,
                        bomId: id,
                        lineId: line.lineId,
                        productId: line.productId,
                        quantity: new Prisma.Decimal(round3(line.quantity)),
                        serialNumber: null,
                        consumedById: userId,
                    });
                }
                const amount = line.serialIds.length || line.quantity;
                if (amount > 0) {
                    await tx.productionBomLine.updateMany({
                        where: { id: line.lineId, tenantId, bomId: id },
                        data: { consumedQuantity: { increment: new Prisma.Decimal(round3(amount)) } },
                    });
                }
            }
            for (const productId of recountProducts) {
                await tx.$executeRaw`
                    UPDATE depo_urun_kartlari p
                       SET p.quantity = (SELECT COUNT(*) FROM depo_seri_numaralari s WHERE s.productId = p.id),
                           p.updatedAt = NOW(3)
                     WHERE p.id = ${productId} AND p.tenantId = ${tenantId} AND p.serialRequired = 1`;
            }
            if (consumptions.length) await tx.productionBomConsumption.createMany({ data: consumptions });
            return true;
        }, CARD_TX_OPTIONS);
        return done ? this.get(tenantId, id) : null;
    }
}

/* ═══════════════════════════ DEPO (lesen) ═════════════════════════════════ */

type StockRow = {
    id: string;
    erpCode: string | null;
    name: string;
    brand: string | null;
    modelNumber: string | null;
    productCode: string | null;
    unit: string | null;
    isDraft: unknown;
    materialGroupName: string | null;
    description: string | null;
    serialRequired: unknown;
    quantity: unknown;
    minimumOrderQuantity: unknown;
    materialGroupId: string | null;
    purchasePrice: unknown;
    currency: string | null;
};

const STOCK_SELECT = Prisma.sql`
    SELECT p.id, p.erpCode, p.name, p.brand, p.modelNumber, p.productCode, p.unit, p.isDraft, g.name AS materialGroupName,
           p.description, p.serialRequired,
           p.quantity, p.minimumOrderQuantity, p.materialGroupId, p.purchasePrice, p.currency
      FROM depo_urun_kartlari p
      LEFT JOIN depo_malzeme_gruplari g ON g.id = p.materialGroupId`;

/** Die Einheit der Karte, wie die BOM sie kennt (ältere Karten: keine). */
const cardUnitOf = (value: unknown): BomUnit | null => {
    const text = String(value ?? '').trim().toUpperCase();
    return (BOM_UNITS as readonly string[]).includes(text) ? text as BomUnit : null;
};

const withSuppliers = async (tenantId: string, rows: StockRow[]): Promise<BomStockProduct[]> => {
    if (!rows.length) return [];
    // Roh gelesen: Artikel-/Bestellnummer (01.10.2026) kennt ein älterer Prisma-Client nicht.
    const suppliers = await prisma.$queryRaw<Array<{
        productId: string;
        supplierId: string | null;
        supplierName: string;
        email: string | null;
        articleNumber: string | null;
        orderNumber: string | null;
    }>>`
        SELECT s.productId, s.supplierId, s.supplierName, s.email, s.articleNumber, s.orderNumber
          FROM depo_urun_tedarikcileri s
         WHERE s.tenantId = ${tenantId} AND s.productId IN (${Prisma.join(rows.map((row) => row.id))})
         ORDER BY s.sortOrder`;
    const byProduct = new Map<string, BomStockProduct['suppliers']>();
    for (const supplier of suppliers) {
        const list = byProduct.get(supplier.productId) ?? [];
        list.push({
            supplierId: supplier.supplierId,
            name: supplier.supplierName,
            email: supplier.email ?? null,
            articleNumber: supplier.articleNumber ?? null,
            orderNumber: supplier.orderNumber ?? null,
        });
        byProduct.set(supplier.productId, list);
    }
    return rows.map((row) => ({
        productId: row.id,
        erpCode: row.erpCode,
        name: row.name,
        brand: row.brand,
        modelNumber: row.modelNumber,
        productCode: row.productCode ?? null,
        unit: cardUnitOf(row.unit),
        isDraft: row.isDraft === true || num(row.isDraft) === 1,
        materialGroupName: row.materialGroupName ?? null,
        description: row.description,
        serialRequired: row.serialRequired === true || num(row.serialRequired) === 1,
        quantity: round3(num(row.quantity)),
        minimumOrderQuantity: (() => {
            const value = numOrNull(row.minimumOrderQuantity);
            return value !== null && value > 0 ? round3(value) : null;
        })(),
        materialGroupId: row.materialGroupId,
        suppliers: byProduct.get(row.id) ?? [],
        purchasePrice: numOrNull(row.purchasePrice),
        currency: row.currency,
    }));
};

export class PrismaBomStockReader implements IBomStockReader {
    async products(tenantId: string, productIds: string[]): Promise<Map<string, BomStockProduct>> {
        const unique = [...new Set(productIds.filter(Boolean))];
        if (!unique.length) return new Map();
        const rows = await prisma.$queryRaw<StockRow[]>`${STOCK_SELECT}
            WHERE p.tenantId = ${tenantId} AND p.id IN (${Prisma.join(unique)})`;
        const products = await withSuppliers(tenantId, rows);
        return new Map(products.map((product) => [product.productId, product]));
    }

    async serials(tenantId: string, productIds: string[]): Promise<BomSerialFact[]> {
        const unique = [...new Set(productIds.filter(Boolean))];
        if (!unique.length) return [];
        const rows = await prisma.warehouseSerialNumber.findMany({
            where: { tenantId, productId: { in: unique } },
            select: { id: true, productId: true, serialNumber: true, productionProjectId: true, productionItemId: true, createdAt: true },
        });
        return rows.map((row) => ({ ...row, createdAt: toDate(row.createdAt) }));
    }

    async search(tenantId: string, query: string, limit: number): Promise<BomStockProduct[]> {
        const needle = query.trim().slice(0, 120);
        if (!needle) return [];
        const like = likeOf(needle);
        const rows = await prisma.$queryRaw<StockRow[]>`${STOCK_SELECT}
            WHERE p.tenantId = ${tenantId}
              AND (p.erpCode LIKE ${like} OR p.modelNumber LIKE ${like} OR p.name LIKE ${like} OR p.brand LIKE ${like}
                   OR p.barcode = ${needle} OR p.manufacturerBarcode = ${needle}
                   OR p.id IN (SELECT s.productId FROM depo_urun_tedarikcileri s WHERE s.tenantId = ${tenantId} AND s.barcode = ${needle}))
            ORDER BY (p.erpCode = ${needle}) DESC, (p.modelNumber = ${needle}) DESC,
                     (p.erpCode LIKE ${`${needle.replace(/[\\%_]/g, (char) => `\\${char}`)}%`}) DESC,
                     p.name ASC
            LIMIT ${Math.max(1, Math.min(50, limit))}`;
        return withSuppliers(tenantId, rows);
    }

    async assignSerials(
        tenantId: string,
        assignments: Array<{
            serialId: string;
            productionProjectId: string;
            productionItemId: string;
            projectNumber: string | null;
            projectName: string | null;
            deviceName: string | null;
        }>,
    ): Promise<number> {
        let changed = 0;
        // Nur FREIE Nummern — eine inzwischen von Hand zugeordnete bleibt, wie sie ist.
        for (const entry of assignments) {
            const result = await prisma.warehouseSerialNumber.updateMany({
                where: { id: entry.serialId, tenantId, productionProjectId: null, productionItemId: null },
                data: {
                    productionProjectId: entry.productionProjectId,
                    productionItemId: entry.productionItemId,
                    projectNumber: entry.projectNumber?.slice(0, 64) ?? null,
                    projectName: entry.projectName?.slice(0, 255) ?? null,
                    deviceName: entry.deviceName?.slice(0, 500) ?? null,
                },
            });
            changed += result.count;
        }
        return changed;
    }

    async releaseSerials(tenantId: string, serialIds: string[]): Promise<number> {
        const unique = [...new Set(serialIds.filter(Boolean))];
        if (!unique.length) return 0;
        const result = await prisma.warehouseSerialNumber.updateMany({
            where: { tenantId, id: { in: unique } },
            data: { productionProjectId: null, productionItemId: null, projectNumber: null, projectName: null, deviceName: null },
        });
        return result.count;
    }

    async addSupplierToProduct(tenantId: string, productId: string, supplier: { supplierId: string | null; name: string }): Promise<void> {
        const name = supplier.name.trim().slice(0, 191);
        if (!name) return;
        const existing = await prisma.warehouseProductSupplier.findMany({
            where: { tenantId, productId },
            select: { supplierId: true, supplierName: true, sortOrder: true },
        });
        const fold = (value: string) => value.trim().toLocaleLowerCase('tr-TR');
        if (existing.some((row) => (supplier.supplierId && row.supplierId === supplier.supplierId) || fold(row.supplierName) === fold(name))) return;
        const product = await prisma.warehouseProduct.findFirst({ where: { id: productId, tenantId }, select: { id: true } });
        if (!product) return;
        await prisma.warehouseProductSupplier.create({
            data: {
                id: newId(),
                tenantId,
                productId,
                supplierId: supplier.supplierId,
                supplierName: name,
                barcode: null,
                sortOrder: existing.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1,
            },
        });
        // Die Karte trägt den ERSTEN Lieferanten als Abzug — nur, wenn sie noch keinen hatte.
        if (!existing.length) {
            await prisma.warehouseProduct.updateMany({
                where: { id: productId, tenantId },
                data: { supplierId: supplier.supplierId, supplierName: name },
            });
        }
    }

    /**
     * «Seçimi kaydet» (28.09.2026): der gewählte Lieferant wird der ERSTE der
     * Karte — so schlägt ihn die nächste Bestellung vor — und sein Preis der
     * Alışpreis der Karte.
     */
    async preferSupplier(
        tenantId: string,
        productId: string,
        supplier: { supplierId: string | null; name: string },
        price: number | null,
        currency: string | null,
    ): Promise<void> {
        const name = supplier.name.trim().slice(0, 191);
        const product = await prisma.warehouseProduct.findFirst({ where: { id: productId, tenantId }, select: { id: true } });
        if (!name || !product) return;
        const rows = await prisma.warehouseProductSupplier.findMany({
            where: { tenantId, productId },
            select: { id: true, supplierId: true, supplierName: true },
            orderBy: { sortOrder: 'asc' },
        });
        const fold = (value: string) => value.trim().toLocaleLowerCase('tr-TR');
        const mine = rows.find((row) => (supplier.supplierId && row.supplierId === supplier.supplierId) || fold(row.supplierName) === fold(name));
        const others = rows.filter((row) => row !== mine);
        await prisma.$transaction([
            mine
                ? prisma.warehouseProductSupplier.update({ where: { id: mine.id }, data: { sortOrder: 0, supplierId: supplier.supplierId ?? mine.supplierId } })
                : prisma.warehouseProductSupplier.create({
                    data: { id: newId(), tenantId, productId, supplierId: supplier.supplierId, supplierName: name, barcode: null, sortOrder: 0 },
                }),
            ...others.map((row, index) => prisma.warehouseProductSupplier.update({ where: { id: row.id }, data: { sortOrder: index + 1 } })),
            prisma.warehouseProduct.updateMany({
                where: { id: productId, tenantId },
                data: {
                    supplierId: supplier.supplierId ?? mine?.supplierId ?? null,
                    supplierName: mine?.supplierName ?? name,
                    ...(price !== null && price > 0 ? { purchasePrice: price, ...(currency ? { currency: currency.slice(0, 3) } : {}) } : {}),
                },
            }),
        ]);
    }
}

/* ═══════════════════════════ BESTELLUNGEN ═════════════════════════════════ */

type LinkRow = Prisma.ProductionBomPurchaseGetPayload<Record<string, never>>;

const purchaseLinesOf = (value: Prisma.JsonValue | null): BomPurchaseLineRecord[] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): BomPurchaseLineRecord[] => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const record = entry as Record<string, unknown>;
        const bomLineId = str(record.bomLineId);
        if (!bomLineId) return [];
        return [{
            bomLineId,
            missing: round3(num(record.missing)),
            minimum: numOrNull(record.minimum),
            ordered: round3(num(record.ordered)),
            note: str(record.note),
        }];
    });
};

const toLink = (row: LinkRow): BomPurchaseLink => ({
    id: row.id,
    tenantId: row.tenantId,
    purchaseOrderId: row.purchaseOrderId,
    bomId: row.bomId,
    productionProjectId: row.productionProjectId,
    productionItemId: row.productionItemId,
    kind: (row.kind === 'REQUEST' ? 'REQUEST' : 'ORDER') as BomPurchaseKind,
    sourcePurchaseOrderId: row.sourcePurchaseOrderId,
    lines: purchaseLinesOf(row.lines),
    quoteFileRef: row.quoteFileRef,
    quoteFileName: row.quoteFileName,
    quoteFileType: row.quoteFileType,
    quoteFileSize: row.quoteFileSize,
    quoteUploadedAt: row.quoteUploadedAt,
    quoteUploadedById: row.quoteUploadedById,
    bomRevision: Number(row.bomRevision) || 0,
    orderRevision: Number(row.orderRevision) || 0,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

const parseItems = (raw: unknown): Array<Record<string, unknown>> => {
    try {
        const parsed = JSON.parse(String(raw ?? '[]'));
        return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
    } catch {
        return [];
    }
};

export class PrismaBomPurchaseRepository implements IBomPurchaseRepository {
    async linksForBom(tenantId: string, bomId: string): Promise<BomPurchaseLink[]> {
        return this.linksForBoms(tenantId, [bomId]);
    }

    async linksForBoms(tenantId: string, bomIds: string[]): Promise<BomPurchaseLink[]> {
        const unique = [...new Set(bomIds.filter(Boolean))];
        if (!unique.length) return [];
        const rows = await prisma.productionBomPurchase.findMany({
            where: { tenantId, bomId: { in: unique } },
            orderBy: { createdAt: 'asc' },
        });
        return rows.map(toLink);
    }

    async linkForOrder(tenantId: string, purchaseOrderId: string): Promise<BomPurchaseLink | null> {
        const row = await prisma.productionBomPurchase.findFirst({ where: { tenantId, purchaseOrderId } });
        return row ? toLink(row) : null;
    }

    async orders(tenantId: string, purchaseOrderIds: string[]): Promise<BomPurchaseOrderRow[]> {
        const unique = [...new Set(purchaseOrderIds.filter(Boolean))];
        if (!unique.length) return [];
        const rows = await prisma.purchaseOrder.findMany({
            where: { tenantId, id: { in: unique } },
            select: {
                id: true,
                referenceNumber: true,
                status: true,
                supplierId: true,
                supplierName: true,
                supplierEmail: true,
                quoteNumber: true,
                currency: true,
                totalNet: true,
                emailSentAt: true,
                createdAt: true,
                updatedAt: true,
                items: true,
            },
        });
        return rows.map((row) => ({
            id: row.id,
            referenceNumber: row.referenceNumber,
            status: row.status,
            supplierId: row.supplierId,
            supplierName: row.supplierName,
            supplierEmail: row.supplierEmail ?? null,
            quoteNumber: row.quoteNumber,
            currency: row.currency,
            totalNet: num(row.totalNet),
            emailSentAt: row.emailSentAt,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            items: parseItems(row.items),
        }));
    }

    async incoming(tenantId: string, productIds: string[]): Promise<BomIncomingLine[]> {
        const unique = [...new Set(productIds.filter(Boolean))];
        if (!unique.length) return [];
        const lines = await prisma.productionBomLine.findMany({
            where: { tenantId, productId: { in: unique } },
            select: { id: true, productId: true },
        });
        if (!lines.length) return [];
        const productOfLine = new Map(lines.map((line) => [line.id, line.productId]));
        const bomIds = await prisma.productionBomLine.findMany({
            where: { tenantId, productId: { in: unique } },
            select: { bomId: true },
            distinct: ['bomId'],
        });
        const links = await prisma.productionBomPurchase.findMany({
            where: { tenantId, kind: 'ORDER', bomId: { in: bomIds.map((row) => row.bomId) } },
            select: { purchaseOrderId: true },
        });
        if (!links.length) return [];
        const orders = await prisma.purchaseOrder.findMany({
            where: {
                tenantId,
                id: { in: links.map((link) => link.purchaseOrderId) },
                status: { notIn: [...PRICE_REQUEST_STATUSES, 'COMPLETED'] },
            },
            select: { id: true, referenceNumber: true, status: true, items: true },
        });
        const result: BomIncomingLine[] = [];
        for (const order of orders) {
            for (const item of parseItems(order.items)) {
                const bomLineId = str(item.bomLineId);
                const productId = bomLineId ? productOfLine.get(bomLineId) : undefined;
                if (!bomLineId || !productId) continue;
                result.push({
                    purchaseOrderId: order.id,
                    referenceNumber: order.referenceNumber,
                    status: order.status,
                    confirmed: CONFIRMED_ORDER_STATUSES.has(String(order.status).toUpperCase()),
                    bomLineId,
                    productId,
                    quantity: round3(num(item.quantity)),
                    received: round3(num(item.receivedQuantity)),
                });
            }
        }
        return result;
    }

    async createLink(
        tenantId: string,
        input: {
            purchaseOrderId: string;
            bomId: string;
            productionProjectId: string;
            productionItemId: string;
            kind: BomPurchaseKind;
            sourcePurchaseOrderId: string | null;
            lines: BomPurchaseLineRecord[];
            bomRevision?: number;
        },
        userId: string,
    ): Promise<BomPurchaseLink> {
        const row = await prisma.productionBomPurchase.create({
            data: {
                id: newId(),
                tenantId,
                purchaseOrderId: input.purchaseOrderId,
                bomId: input.bomId,
                productionProjectId: input.productionProjectId,
                productionItemId: input.productionItemId,
                kind: input.kind,
                sourcePurchaseOrderId: input.sourcePurchaseOrderId,
                lines: input.lines as unknown as Prisma.InputJsonValue,
                bomRevision: input.bomRevision ?? 0,
                createdById: userId,
            },
        });
        return toLink(row);
    }

    async setQuoteFile(
        tenantId: string,
        purchaseOrderId: string,
        file: { ref: string; name: string; type: string; size: number } | null,
        userId: string,
    ): Promise<BomPurchaseLink | null> {
        const result = await prisma.productionBomPurchase.updateMany({
            where: { tenantId, purchaseOrderId },
            data: file
                ? {
                    quoteFileRef: file.ref,
                    quoteFileName: file.name.slice(0, 255),
                    quoteFileType: file.type.slice(0, 100),
                    quoteFileSize: file.size,
                    quoteUploadedAt: new Date(),
                    quoteUploadedById: userId,
                }
                : {
                    quoteFileRef: null,
                    quoteFileName: null,
                    quoteFileType: null,
                    quoteFileSize: null,
                    quoteUploadedAt: null,
                    quoteUploadedById: null,
                },
        });
        return result.count ? this.linkForOrder(tenantId, purchaseOrderId) : null;
    }

    async removeLink(tenantId: string, purchaseOrderId: string): Promise<BomPurchaseLink | null> {
        const link = await this.linkForOrder(tenantId, purchaseOrderId);
        if (!link) return null;
        await prisma.productionBomPurchase.deleteMany({ where: { tenantId, purchaseOrderId } });
        return link;
    }

    async pruneOrphans(tenantId: string, links: BomPurchaseLink[]): Promise<BomPurchaseLink[]> {
        if (!links.length) return links;
        const alive = await prisma.purchaseOrder.findMany({
            where: { tenantId, id: { in: links.map((link) => link.purchaseOrderId) } },
            select: { id: true },
        });
        const aliveIds = new Set(alive.map((row) => row.id));
        const dead = links.filter((link) => !aliveIds.has(link.purchaseOrderId));
        if (dead.length) {
            await prisma.productionBomPurchase.deleteMany({ where: { tenantId, id: { in: dead.map((link) => link.id) } } });
        }
        return links.filter((link) => aliveIds.has(link.purchaseOrderId));
    }
}

/* ═══════════════════════════ PRODUKTION (lesen) ═══════════════════════════ */

const toDevice = (row: {
    id: string;
    productionProjectId: string;
    name: string;
    kind: string;
    quantity: number;
    positionNumber: string | null;
    isActive: boolean;
}): BomDeviceFacts => ({
    id: row.id,
    productionProjectId: row.productionProjectId,
    name: row.name,
    kind: row.kind,
    quantity: num(row.quantity) || 1,
    positionNumber: row.positionNumber,
    isActive: row.isActive,
});

const DEVICE_SELECT = {
    id: true,
    productionProjectId: true,
    name: true,
    kind: true,
    quantity: true,
    positionNumber: true,
    isActive: true,
} as const;

const PROJECT_SELECT = {
    id: true,
    projectNumber: true,
    projectName: true,
    customerName: true,
    sourceStatus: true,
    isActive: true,
} as const;

export class PrismaBomProductionDirectory implements IBomProductionDirectory {
    async device(tenantId: string, itemId: string): Promise<BomDeviceFacts | null> {
        const row = await prisma.productionProjectItem.findFirst({ where: { id: itemId, tenantId }, select: DEVICE_SELECT });
        return row ? toDevice(row) : null;
    }

    async devices(tenantId: string, itemIds: string[]): Promise<Map<string, BomDeviceFacts>> {
        const unique = [...new Set(itemIds.filter(Boolean))];
        if (!unique.length) return new Map();
        const rows = await prisma.productionProjectItem.findMany({ where: { tenantId, id: { in: unique } }, select: DEVICE_SELECT });
        return new Map(rows.map((row) => [row.id, toDevice(row)]));
    }

    async project(tenantId: string, projectId: string): Promise<BomProjectFacts | null> {
        return prisma.productionProject.findFirst({ where: { id: projectId, tenantId }, select: PROJECT_SELECT });
    }

    async projects(tenantId: string, projectIds: string[]): Promise<Map<string, BomProjectFacts>> {
        const unique = [...new Set(projectIds.filter(Boolean))];
        if (!unique.length) return new Map();
        const rows = await prisma.productionProject.findMany({ where: { tenantId, id: { in: unique } }, select: PROJECT_SELECT });
        return new Map(rows.map((row) => [row.id, row]));
    }

    /**
     * Der Liefertermin, wie die Projektseite ihn zeigt («Liefertermin» =
     * `Tender.internalDeliveryDate` der Offerte des Projekts bzw. des
     * Lieferauftrags), sonst das Projektende. Zwei Abfragen für alle Projekte.
     */
    async deliveryDates(tenantId: string, projectIds: string[]): Promise<Map<string, Date | null>> {
        const unique = [...new Set(projectIds.filter(Boolean))];
        const result = new Map<string, Date | null>(unique.map((id) => [id, null]));
        if (!unique.length) return result;
        const projects = await prisma.productionProject.findMany({
            where: { tenantId, id: { in: unique } },
            select: { id: true, sourceKind: true, sourceProjectId: true, sourceSalesOrderId: true, sourceTenantId: true },
        });
        const projectRows = projects.filter((row) => row.sourceKind === 'PROJECT' && row.sourceProjectId);
        const deliveryRows = projects.filter((row) => row.sourceKind !== 'PROJECT' && row.sourceSalesOrderId);
        const [fromProjects, fromDeliveries] = await Promise.all([
            projectRows.length
                ? prisma.$queryRaw<Array<{ id: string; deliveryDate: unknown; endDate: unknown }>>`
                    SELECT p.id, t.internalDeliveryDate AS deliveryDate, p.endDate
                      FROM Project p
                      LEFT JOIN Tender t ON t.id = COALESCE(p.tenderId, (
                          SELECT so.tenderId FROM SalesOrder so
                           WHERE so.projectId = p.id AND so.parentSalesOrderId IS NULL AND so.tenderId IS NOT NULL
                           ORDER BY COALESCE(so.orderDate, so.createdAt) ASC
                           LIMIT 1))
                     WHERE p.id IN (${Prisma.join(projectRows.map((row) => row.sourceProjectId as string))})`
                : Promise.resolve([]),
            deliveryRows.length
                ? prisma.$queryRaw<Array<{ id: string; deliveryDate: unknown }>>`
                    SELECT so.id, t.internalDeliveryDate AS deliveryDate
                      FROM SalesOrder so
                      LEFT JOIN Tender t ON t.id = so.tenderId
                     WHERE so.id IN (${Prisma.join(deliveryRows.map((row) => row.sourceSalesOrderId as string))})`
                : Promise.resolve([]),
        ]);
        const byProject = new Map(fromProjects.map((row) => [row.id, dateOrNull(row.deliveryDate) ?? dateOrNull(row.endDate)]));
        const byOrder = new Map(fromDeliveries.map((row) => [row.id, dateOrNull(row.deliveryDate)]));
        for (const project of projects) {
            const date = project.sourceKind === 'PROJECT'
                ? byProject.get(project.sourceProjectId ?? '') ?? null
                : byOrder.get(project.sourceSalesOrderId ?? '') ?? null;
            result.set(project.id, date);
        }
        return result;
    }

    async bomStageAssignees(tenantId: string, itemId: string, area: BomArea): Promise<string[]> {
        const rows = await prisma.productionDeviceTask.findMany({
            where: { tenantId, productionItemId: itemId, area, stage: 'bom' },
            select: { assigneeIds: true },
        });
        const ids = new Set<string>();
        for (const row of rows) {
            if (Array.isArray(row.assigneeIds)) {
                for (const id of row.assigneeIds) if (typeof id === 'string' && id) ids.add(id);
            }
        }
        return [...ids];
    }

    async personName(id: string): Promise<string | null> {
        const row = await prisma.employee.findUnique({ where: { id }, select: { firstName: true, lastName: true } }).catch(() => null);
        const name = `${row?.firstName ?? ''} ${row?.lastName ?? ''}`.trim();
        return name || null;
    }

    async personNames(ids: string[]): Promise<Map<string, string>> {
        const unique = [...new Set(ids.filter(Boolean))];
        if (!unique.length) return new Map();
        const rows = await prisma.employee.findMany({
            where: { id: { in: unique } },
            select: { id: true, firstName: true, lastName: true },
        }).catch(() => []);
        return new Map(rows.flatMap((row) => {
            const name = `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim();
            return name ? [[row.id, name] as [string, string]] : [];
        }));
    }
}

/* ═══════════════════════════ EINSTELLUNGEN ════════════════════════════════ */

export const DEFAULT_BOM_SETTINGS: BomSettings = { maxPerArea: 2, codes: { MECHANICAL: [], ELECTRICAL: [] } };

const settingsOf = (row: { maxPerArea: number; codes: Prisma.JsonValue | null }): BomSettings => ({
    maxPerArea: row.maxPerArea,
    codes: storedCodes(row.codes),
});

export class PrismaBomSettingsRepository implements IBomSettingsRepository {
    async get(tenantId: string): Promise<BomSettings> {
        const row = await prisma.productionBomSettings.findUnique({ where: { tenantId } });
        return row ? settingsOf(row) : { maxPerArea: DEFAULT_BOM_SETTINGS.maxPerArea, codes: { MECHANICAL: [], ELECTRICAL: [] } };
    }

    async save(tenantId: string, settings: BomSettings, userId: string): Promise<BomSettings> {
        const maxPerArea = Math.max(1, Math.min(BOM_LIMITS.maxPerAreaCeiling, Math.trunc(settings.maxPerArea)));
        const codes = settings.codes as unknown as Prisma.InputJsonValue;
        const row = await prisma.productionBomSettings.upsert({
            where: { tenantId },
            create: { tenantId, maxPerArea, codes, updatedById: userId },
            update: { maxPerArea, codes, updatedById: userId },
        });
        return settingsOf(row);
    }
}
