import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
import { articleImageAddress, resolveArticleImage } from '../src/infrastructure/services/ImageStore';

(async () => {
    const [state]: any = await (prisma as any).$queryRawUnsafe(`
        SELECT SUM(CASE WHEN imageUrl LIKE 'data:%' THEN 1 ELSE 0 END) AS dataUris,
               SUM(CASE WHEN imageUrl LIKE 'r2:%' THEN 1 ELSE 0 END) AS r2Refs,
               COALESCE(SUM(LENGTH(imageUrl)),0) AS bytes
        FROM Article
    `);
    console.log('Article.imageUrl ->', JSON.stringify(state, (_k, v) => typeof v === 'bigint' ? Number(v) : v));

    const rows: any[] = await (prisma as any).$queryRawUnsafe(
        "SELECT id, imageUrl FROM Article WHERE imageUrl LIKE 'r2:%' LIMIT 5");

    for (const row of rows) {
        const url = await articleImageAddress(row.imageUrl);
        const viaResolve = await resolveArticleImage(row.imageUrl);
        const head = await fetch(String(url), { method: 'GET' });
        console.log(`${row.id}  ${head.status}  ${head.headers.get('content-type')}  ${head.headers.get('content-length')}B  cf=${head.headers.get('cf-cache-status')}`);
        console.log(`   ${url}`);
        if (viaResolve !== url) console.log('   !! resolveArticleImage weicht ab:', viaResolve);
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
