import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
import { getArticleThumbnails } from '../src/infrastructure/services/PdfImageThumbnailService';

/* Nach dem Umzug: kommt das PDF-Vorschaubild fuer JEDES migrierte Produkt
   noch zustande — auch fuer die, die keines zwischengespeichert haben und es
   jetzt aus R2 lesen muessen? */
(async () => {
    const articles: any[] = await (prisma as any).article.findMany({
        where: { imageUrl: { startsWith: 'r2:' } },
        select: { id: true, tenantId: true, updatedAt: true },
    });
    const tenantId = articles[0].tenantId;
    const cached = await (prisma as any).pdfImageThumbnail.findMany({
        where: { tenantId, sourceType: 'ARTICLE', sourceId: { in: articles.map((a) => a.id) } },
        select: { sourceId: true },
    });
    const cachedIds = new Set(cached.map((r: any) => r.sourceId));
    const cold = articles.filter((a) => !cachedIds.has(a.id));
    console.log(`${articles.length} migrierte Produkte | ${cachedIds.size} mit gespeichertem Vorschaubild | ${cold.length} ohne`);

    const probe = cold.length ? cold.slice(0, 5) : articles.slice(0, 5);
    console.log(`\nProbe (${cold.length ? 'ohne Zwischenspeicher — liest aus R2' : 'aus dem Zwischenspeicher'}):`);
    const thumbs = await getArticleThumbnails(tenantId, probe.map((a) => ({ id: a.id, updatedAt: a.updatedAt })));
    for (const a of probe) {
        const t = thumbs.find((x) => x.id === a.id);
        console.log(`  ${a.id}: ${t ? `${t.imageUrl.slice(0, 24)}… ${t.imageUrl.length} Zeichen` : '!!! KEIN BILD'}`);
    }
    console.log(`\n${thumbs.length}/${probe.length} Vorschaubilder erzeugt.`);
    process.exit(thumbs.length === probe.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
