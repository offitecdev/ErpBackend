import dotenv from 'dotenv';
dotenv.config();
import prisma from '../src/infrastructure/database/prisma.client';

/** Nur lesen: die VOLLE Antwort von GET /integration/offer-status/<ref> — was
 *  schickt die OSP wirklich alles mit (womöglich eine Datenblatt-Adresse)? */
(async () => {
    const setting = await (prisma as any).ospSetting.findFirst({
        where: { NOT: { ospBaseUrl: null } },
        select: { ospBaseUrl: true, ospApiKey: true },
    });
    const base = String(setting.ospBaseUrl).trim().replace(/\/+$/, '');
    const docs = await (prisma as any).ospDocument.findMany({
        where: { datasheetFile: null },
        orderBy: { createdAt: 'desc' },
        take: 2,
        select: { reference: true },
    });
    for (const doc of docs) {
        const url = `${base}/integration/offer-status/${doc.reference}`;
        try {
            const res = await fetch(url, {
                headers: { 'X-OSP-Integration-Key': String(setting.ospApiKey || '').trim() },
                signal: AbortSignal.timeout(15000),
            });
            const text = await res.text();
            console.log(`${doc.reference} -> ${res.status}`);
            console.log(text.slice(0, 3000));
        } catch (e: any) {
            console.log(`${doc.reference} -> FAIL ${e?.message || e}`);
        }
    }
    await (prisma as any).$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
