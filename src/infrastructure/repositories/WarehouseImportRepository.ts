import { Prisma } from '@prisma/client';

import prisma from '../database/prisma.client';
import type { IWarehouseImportRepository } from '../../domain/repositories/IWarehouseRepository';
import type {
    WarehouseImport,
    WarehouseImportCreate,
    WarehouseImportResult,
    WarehouseImportRow,
    WarehouseImportStatus,
} from '../../domain/entities/Warehouse';
import { CODE_TX_OPTIONS, reserveBarcodes, reserveErpCodes } from './WarehouseCodeIssuer';
import { newId, productData, supplierRows } from './WarehouseRepository';

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

const sqlNow = (): string => new Date().toISOString().slice(0, 23).replace('T', ' ');

const parseJson = <T>(value: unknown, fallback: T): T => {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') {
        try { return JSON.parse(value) as T; } catch { return fallback; }
    }
    return value as T;
};

type ImportRecord = {
    id: string;
    tenantId: string;
    status: string;
    fileName: string | null;
    rowCount: number;
    rows?: unknown;
    requestedById: string | null;
    requestedByName: string | null;
    decidedById: string | null;
    decidedByName: string | null;
    decidedAt: Date | null;
    note: string | null;
    result: unknown;
    createdAt: Date;
    updatedAt: Date;
};

const STATUSES: readonly WarehouseImportStatus[] = ['PENDING', 'DONE', 'REJECTED', 'CANCELLED'];

const toSummary = (row: ImportRecord): Omit<WarehouseImport, 'rows'> => ({
    id: row.id,
    tenantId: row.tenantId,
    status: (STATUSES as readonly string[]).includes(row.status) ? row.status as WarehouseImportStatus : 'PENDING',
    fileName: row.fileName ?? null,
    rowCount: row.rowCount,
    requestedById: row.requestedById ?? null,
    requestedByName: row.requestedByName ?? null,
    decidedById: row.decidedById ?? null,
    decidedByName: row.decidedByName ?? null,
    decidedAt: row.decidedAt ?? null,
    note: row.note ?? null,
    result: parseJson<WarehouseImportResult | null>(row.result, null),
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
} as const;

export class PrismaWarehouseImportRepository implements IWarehouseImportRepository {
    async list(tenantId: string, limit: number): Promise<Array<Omit<WarehouseImport, 'rows'>>> {
        const rows = await prisma.warehouseImport.findMany({
            where: { tenantId },
            select: SUMMARY_SELECT,
            orderBy: [{ createdAt: 'desc' }],
            take: limit,
        });
        return rows.map(toSummary);
    }

    async get(tenantId: string, id: string): Promise<WarehouseImport | null> {
        const row = await prisma.warehouseImport.findFirst({ where: { id, tenantId } });
        if (!row) return null;
        return { ...toSummary(row), rows: parseJson<WarehouseImportRow[]>(row.rows, []) };
    }

    pendingCount(tenantId: string): Promise<number> {
        return prisma.warehouseImport.count({ where: { tenantId, status: 'PENDING' } });
    }

    async create(
        tenantId: string,
        input: { fileName: string | null; rows: WarehouseImportRow[]; requestedById: string; requestedByName: string | null },
    ): Promise<WarehouseImport> {
        const id = newId();
        await prisma.warehouseImport.create({
            data: {
                id,
                tenantId,
                status: 'PENDING',
                fileName: input.fileName,
                rowCount: input.rows.length,
                rows: input.rows as unknown as Prisma.InputJsonValue,
                requestedById: input.requestedById,
                requestedByName: input.requestedByName,
            },
        });
        const created = await this.get(tenantId, id);
        if (!created) throw new Error('Depo: neuer Aktarım nicht lesbar.');
        return created;
    }

    async close(
        tenantId: string,
        id: string,
        input: { status: 'REJECTED' | 'CANCELLED'; decidedById: string; decidedByName: string | null; note: string | null },
    ): Promise<boolean> {
        const result = await prisma.warehouseImport.updateMany({
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

    async execute(
        tenantId: string,
        id: string,
        input: {
            creates: WarehouseImportCreate[];
            failed: Array<{ row: number; code: string }>;
            decidedById: string;
            decidedByName: string | null;
            createdById: string;
        },
    ): Promise<WarehouseImportResult | null> {
        return prisma.$transaction(async (tx) => {
            const now = sqlNow();
            const claimed = await tx.$executeRaw`
                UPDATE depo_aktarimlar
                   SET status = 'DONE', decidedById = ${input.decidedById}, decidedByName = ${input.decidedByName},
                       decidedAt = ${now}, updatedAt = ${now}
                 WHERE id = ${id} AND tenantId = ${tenantId} AND status = 'PENDING'`;
            if (!claimed) return null;

            // Je Gruppe ein Block Nummern, in der Reihenfolge der Datei.
            const byGroup = new Map<string, WarehouseImportCreate[]>();
            for (const create of input.creates) {
                const groupId = create.fields.materialGroupId;
                if (!groupId) continue;
                const list = byGroup.get(groupId) ?? [];
                list.push(create);
                byGroup.set(groupId, list);
            }
            const codeOf = new Map<WarehouseImportCreate, string>();
            // Gruppen immer in derselben Reihenfolge sperren — zwei gleichzeitige
            // Vorgänge warten dann aufeinander, statt sich zu verklemmen.
            const ordered = [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
            for (const [groupId, list] of ordered) {
                const codes = await reserveErpCodes(tx, tenantId, groupId, list.length);
                list.forEach((create, index) => { const code = codes[index]; if (code) codeOf.set(create, code); });
            }
            const coded = input.creates.filter((create) => codeOf.has(create));
            const barcodes = await reserveBarcodes(tx, tenantId, coded.length);
            const barcodeOf = new Map(coded.map((create, index) => [create, barcodes[index] ?? null]));

            const data = input.creates.map((create) => ({
                id: newId(),
                tenantId,
                ...productData(create.fields),
                erpCode: codeOf.get(create) ?? null,
                barcode: barcodeOf.get(create) ?? null,
                quantity: create.fields.serialRequired ? 0 : create.fields.quantity,
                createdById: input.createdById,
                updatedById: input.decidedById,
            }));
            for (let index = 0; index < data.length; index += 500) {
                await tx.warehouseProduct.createMany({ data: data.slice(index, index + 500) });
            }
            const suppliers = input.creates.flatMap((create, index) => supplierRows(tenantId, data[index]!.id, create.fields.suppliers));
            for (let index = 0; index < suppliers.length; index += 500) {
                await tx.warehouseProductSupplier.createMany({ data: suppliers.slice(index, index + 500) });
            }

            const issued = input.creates.map((create) => codeOf.get(create)).filter((code): code is string => Boolean(code));
            const result: WarehouseImportResult = {
                created: data.length,
                skipped: input.failed.length,
                failed: input.failed.slice(0, 500),
                firstCode: issued[0] ?? null,
                lastCode: issued[issued.length - 1] ?? null,
            };
            await tx.warehouseImport.update({
                where: { id },
                data: { result: result as unknown as Prisma.InputJsonValue },
            });
            return result;
        }, CODE_TX_OPTIONS);
    }
}
