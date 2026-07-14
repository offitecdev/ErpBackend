"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerProductDiscountRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const nanoid_1 = require("nanoid");
// Per-customer default discount (%) for a specific article.
class CustomerProductDiscountRepository {
    async withArticles(rows) {
        if (rows.length === 0)
            return [];
        const articles = await prisma_client_1.default.article.findMany({
            where: { id: { in: rows.map((r) => r.articleId) } },
            select: { id: true, articleCode: true, name: true },
        });
        const byId = new Map(articles.map((a) => [a.id, a]));
        return rows.map((r) => ({
            id: r.id,
            customerId: r.customerId,
            articleId: r.articleId,
            discount: r.discount,
            articleCode: byId.get(r.articleId)?.articleCode ?? null,
            articleName: byId.get(r.articleId)?.name ?? null,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
        }));
    }
    async findByCustomerId(customerId) {
        const rows = await prisma_client_1.default.customerProductDiscount.findMany({
            where: { customerId },
            orderBy: { createdAt: "asc" },
        });
        return this.withArticles(rows);
    }
    // Map of articleId -> discount %, used to auto-apply discounts on tender lines.
    async discountMapForCustomer(customerId) {
        const rows = await prisma_client_1.default.customerProductDiscount.findMany({
            where: { customerId },
            select: { articleId: true, discount: true },
        });
        return Object.fromEntries(rows.map((r) => [r.articleId, r.discount]));
    }
    async upsert(input) {
        const row = await prisma_client_1.default.customerProductDiscount.upsert({
            where: { customerId_articleId: { customerId: input.customerId, articleId: input.articleId } },
            create: {
                id: (0, nanoid_1.nanoid)(10),
                tenantId: input.tenantId,
                customerId: input.customerId,
                articleId: input.articleId,
                discount: input.discount,
            },
            update: { discount: input.discount },
        });
        const [mapped] = await this.withArticles([row]);
        return mapped;
    }
    async updateDiscount(id, discount) {
        const row = await prisma_client_1.default.customerProductDiscount.update({
            where: { id },
            data: { discount },
        });
        const [mapped] = await this.withArticles([row]);
        return mapped;
    }
    async delete(id) {
        await prisma_client_1.default.customerProductDiscount.delete({ where: { id } });
    }
}
exports.CustomerProductDiscountRepository = CustomerProductDiscountRepository;
//# sourceMappingURL=CustomerProductDiscountRepository.js.map