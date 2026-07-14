import prisma from "../database/prisma.client";
import { nanoid } from "nanoid";

export interface CustomerProductDiscountRow {
    id: string;
    customerId: string;
    articleId: string;
    discount: number;
    articleCode: string | null;
    articleName: string | null;
    createdAt: Date;
    updatedAt: Date;
}

// Per-customer default discount (%) for a specific article.
export class CustomerProductDiscountRepository {
    private async withArticles(rows: any[]): Promise<CustomerProductDiscountRow[]> {
        if (rows.length === 0) return [];
        const articles = await prisma.article.findMany({
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

    async findByCustomerId(customerId: string): Promise<CustomerProductDiscountRow[]> {
        const rows = await prisma.customerProductDiscount.findMany({
            where: { customerId },
            orderBy: { createdAt: "asc" },
        });
        return this.withArticles(rows);
    }

    // Map of articleId -> discount %, used to auto-apply discounts on tender lines.
    async discountMapForCustomer(customerId: string): Promise<Record<string, number>> {
        const rows = await prisma.customerProductDiscount.findMany({
            where: { customerId },
            select: { articleId: true, discount: true },
        });
        return Object.fromEntries(rows.map((r) => [r.articleId, r.discount]));
    }

    async upsert(input: { tenantId: string; customerId: string; articleId: string; discount: number }): Promise<CustomerProductDiscountRow> {
        const row = await prisma.customerProductDiscount.upsert({
            where: { customerId_articleId: { customerId: input.customerId, articleId: input.articleId } },
            create: {
                id: nanoid(10),
                tenantId: input.tenantId,
                customerId: input.customerId,
                articleId: input.articleId,
                discount: input.discount,
            },
            update: { discount: input.discount },
        });
        const [mapped] = await this.withArticles([row]);
        return mapped!;
    }

    async updateDiscount(id: string, discount: number): Promise<CustomerProductDiscountRow> {
        const row = await prisma.customerProductDiscount.update({
            where: { id },
            data: { discount },
        });
        const [mapped] = await this.withArticles([row]);
        return mapped!;
    }

    async delete(id: string): Promise<void> {
        await prisma.customerProductDiscount.delete({ where: { id } });
    }
}
