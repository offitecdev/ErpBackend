/**
 * Pre-builds offer-PDF product thumbnails so an export never pays for the
 * full-size originals.
 *
 * The runtime endpoint creates missing derivatives lazily. This script performs
 * that first pass up front and writes only the small derivative cache; source
 * article images are never modified.
 *
 * Run:  npx ts-node scripts/warm-pdf-thumbs.ts
 *       npx ts-node scripts/warm-pdf-thumbs.ts --tenant main-tenant
 */
import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
import { getArticleThumbnails } from '../src/infrastructure/services/PdfImageThumbnailService';

// Originals are megabytes each; a small batch keeps peak memory bounded.
const BATCH_SIZE = 10;

async function main() {
    const tenantArg = process.argv.indexOf('--tenant');
    const onlyTenant = tenantArg >= 0 ? process.argv[tenantArg + 1] : null;

    // Article metadata contains no image blob. Existing derivative ids are
    // removed before the service processes the remaining records.
    const allArticles: Array<{ id: string; tenantId: string; updatedAt: Date }> =
        await prisma.article.findMany({
            where: {
                ...(onlyTenant ? { tenantId: onlyTenant } : {}),
                imageUrl: { not: null, notIn: [''] },
            },
            select: { id: true, tenantId: true, updatedAt: true },
        });
    const existing = await prisma.pdfImageThumbnail.findMany({
        where: {
            sourceType: 'ARTICLE',
            ...(onlyTenant ? { tenantId: onlyTenant } : {}),
        },
        select: { sourceId: true },
    });
    const existingIds = new Set(existing.map((row) => row.sourceId));
    const articles = allArticles.filter((article) => !existingIds.has(article.id));

    const byTenant = new Map<string, Array<{ id: string; updatedAt: Date }>>();
    articles.forEach((article) => {
        const list = byTenant.get(article.tenantId) || [];
        list.push({ id: article.id, updatedAt: article.updatedAt });
        byTenant.set(article.tenantId, list);
    });

    console.log(
        `[warm-pdf-thumbs] ${articles.length} article image(s) across ${byTenant.size} tenant(s)`,
    );

    let done = 0;
    let built = 0;
    for (const [tenantId, list] of byTenant) {
        for (let i = 0; i < list.length; i += BATCH_SIZE) {
            const batch = list.slice(i, i + BATCH_SIZE);
            const startedAt = Date.now();
            const thumbs = await getArticleThumbnails(tenantId, batch);
            built += thumbs.length;
            done += batch.length;
            console.log(
                `[warm-pdf-thumbs] ${tenantId}: ${done}/${articles.length} `
                + `(${Date.now() - startedAt}ms for ${batch.length})`,
            );
        }
    }

    console.log(`[warm-pdf-thumbs] done - ${built} thumbnail(s) cached`);
    await prisma.$disconnect();
}

main().catch(async (error) => {
    console.error('[warm-pdf-thumbs] failed:', error);
    await prisma.$disconnect();
    process.exit(1);
});
