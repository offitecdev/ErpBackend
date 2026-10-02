"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaProductionStandardsTemplateRepository = void 0;
const nanoid_1 = require("nanoid");
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const productionTasks_1 = require("../../domain/services/productionTasks");
const templateOf = (row) => ({
    id: row.id,
    name: row.name,
    text: row.text,
    file: (0, productionTasks_1.storedStandardsFile)(row.file),
    updatedAt: row.updatedAt.toISOString(),
});
/** Ohne die Migration vom 02.10.2026 gibt es die Tabelle noch nicht — dann keine Vorlagen. */
const isMissingTable = (error) => error?.code === 'P2021'
    || /doesn't exist|\b1146\b/i.test(String(error?.message ?? error));
const isUnique = (error) => error?.code === 'P2002';
/** Die Vorlagen der Dokument-Standards (`uretim_gorev_standart_sablonlari`, 02.10.2026). */
class PrismaProductionStandardsTemplateRepository {
    async list(tenantId) {
        try {
            const rows = await prisma_client_1.default.productionTaskStandardsTemplate.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
            return rows.map(templateOf);
        }
        catch (error) {
            if (isMissingTable(error))
                return [];
            throw error;
        }
    }
    async create(tenantId, input, userId) {
        try {
            const row = await prisma_client_1.default.productionTaskStandardsTemplate.create({
                data: {
                    id: (0, nanoid_1.nanoid)(),
                    tenantId,
                    name: input.name,
                    text: input.text,
                    ...(input.file ? { file: input.file } : {}),
                    createdById: userId,
                    updatedById: userId,
                },
            });
            return templateOf(row);
        }
        catch (error) {
            if (isUnique(error))
                return 'NAME_TAKEN';
            throw error;
        }
    }
    async update(tenantId, id, input, userId) {
        try {
            const result = await prisma_client_1.default.productionTaskStandardsTemplate.updateMany({
                where: { tenantId, id },
                data: {
                    name: input.name,
                    text: input.text,
                    // Ohne PDF: JSON-NULL, damit ein entferntes PDF wirklich wegfällt.
                    file: input.file ? input.file : client_1.Prisma.JsonNull,
                    updatedById: userId,
                },
            });
            if (!result.count)
                return null;
            const row = await prisma_client_1.default.productionTaskStandardsTemplate.findFirst({ where: { tenantId, id } });
            return row ? templateOf(row) : null;
        }
        catch (error) {
            if (isUnique(error))
                return 'NAME_TAKEN';
            throw error;
        }
    }
    async remove(tenantId, id) {
        const result = await prisma_client_1.default.productionTaskStandardsTemplate.deleteMany({ where: { tenantId, id } });
        return result.count > 0;
    }
}
exports.PrismaProductionStandardsTemplateRepository = PrismaProductionStandardsTemplateRepository;
//# sourceMappingURL=ProductionStandardsTemplateRepository.js.map