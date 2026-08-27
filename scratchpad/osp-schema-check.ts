import dotenv from 'dotenv';
dotenv.config();
import prisma from '../src/infrastructure/database/prisma.client';

/**
 * Jede Spalte, die das Modell kennt, muss es auch in der Datenbank geben —
 * genau daran ist die OSP-Seite zuletzt gescheitert (Prisma P2022, und zwar
 * bei JEDEM Lesen). Der Selbsttest liest eine volle Zeile und meldet, wenn
 * eine Spalte fehlt.
 */
(async () => {
    const rows = await (prisma as any).ospDocument.findMany({ take: 3 });
    console.log('ospDocument.findMany (all columns) OK — rows:', rows.length);
    const setting = await (prisma as any).ospSetting.findFirst();
    console.log('ospSetting.findFirst OK — base URL:', setting?.ospBaseUrl);
    const first = rows[0];
    if (first) {
        const datasheetColumns = ['datasheetUrl', 'datasheetFile', 'datasheetFetchedAt',
            'datasheetError', 'datasheetSpecs', 'rawPayload'];
        for (const column of datasheetColumns) {
            console.log(`  ${column.padEnd(20)} present:`, column in first);
        }
    }
    await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e?.message || e); process.exit(1); });
