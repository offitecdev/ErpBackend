import { nanoid } from 'nanoid';
import { Prisma } from '@prisma/client';

import prisma from '../database/prisma.client';
import type { ProductionStandardsFile, ProductionStandardsTemplate } from '../../domain/entities/ProductionTask';
import type { IProductionStandardsTemplateRepository } from '../../domain/repositories/IProductionTaskRepository';
import { storedStandardsFile } from '../../domain/services/productionTasks';

type Row = { id: string; name: string; text: string | null; file: Prisma.JsonValue | null; updatedAt: Date };

const templateOf = (row: Row): ProductionStandardsTemplate => ({
    id: row.id,
    name: row.name,
    text: row.text,
    file: storedStandardsFile(row.file),
    updatedAt: row.updatedAt.toISOString(),
});

/** Ohne die Migration vom 02.10.2026 gibt es die Tabelle noch nicht — dann keine Vorlagen. */
const isMissingTable = (error: unknown): boolean =>
    (error as { code?: string })?.code === 'P2021'
    || /doesn't exist|\b1146\b/i.test(String((error as { message?: unknown })?.message ?? error));

const isUnique = (error: unknown): boolean => (error as { code?: string })?.code === 'P2002';

/** Die Vorlagen der Dokument-Standards (`uretim_gorev_standart_sablonlari`, 02.10.2026). */
export class PrismaProductionStandardsTemplateRepository implements IProductionStandardsTemplateRepository {
    async list(tenantId: string): Promise<ProductionStandardsTemplate[]> {
        try {
            const rows = await prisma.productionTaskStandardsTemplate.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
            return rows.map(templateOf);
        } catch (error) {
            if (isMissingTable(error)) return [];
            throw error;
        }
    }

    async create(
        tenantId: string,
        input: { name: string; text: string | null; file: ProductionStandardsFile | null },
        userId: string,
    ): Promise<ProductionStandardsTemplate | 'NAME_TAKEN'> {
        try {
            const row = await prisma.productionTaskStandardsTemplate.create({
                data: {
                    id: nanoid(),
                    tenantId,
                    name: input.name,
                    text: input.text,
                    ...(input.file ? { file: input.file as unknown as Prisma.InputJsonValue } : {}),
                    createdById: userId,
                    updatedById: userId,
                },
            });
            return templateOf(row);
        } catch (error) {
            if (isUnique(error)) return 'NAME_TAKEN';
            throw error;
        }
    }

    async update(
        tenantId: string,
        id: string,
        input: { name: string; text: string | null; file: ProductionStandardsFile | null },
        userId: string,
    ): Promise<ProductionStandardsTemplate | null | 'NAME_TAKEN'> {
        try {
            const result = await prisma.productionTaskStandardsTemplate.updateMany({
                where: { tenantId, id },
                data: {
                    name: input.name,
                    text: input.text,
                    // Ohne PDF: JSON-NULL, damit ein entferntes PDF wirklich wegfällt.
                    file: input.file ? input.file as unknown as Prisma.InputJsonValue : Prisma.JsonNull,
                    updatedById: userId,
                },
            });
            if (!result.count) return null;
            const row = await prisma.productionTaskStandardsTemplate.findFirst({ where: { tenantId, id } });
            return row ? templateOf(row) : null;
        } catch (error) {
            if (isUnique(error)) return 'NAME_TAKEN';
            throw error;
        }
    }

    async remove(tenantId: string, id: string): Promise<boolean> {
        const result = await prisma.productionTaskStandardsTemplate.deleteMany({ where: { tenantId, id } });
        return result.count > 0;
    }
}
