import dotenv from 'dotenv';
dotenv.config();
import prisma from '../src/infrastructure/database/prisma.client';

/** Nur lesen: weitere Pfad-Kandidaten fürs Datenblatt + eine Unsinn-Kontrolle,
 *  um zu erkennen, ob 403 "gibt es, aber gesperrt" oder Pauschalantwort ist. */
(async () => {
    const setting = await (prisma as any).ospSetting.findFirst({
        where: { NOT: { ospBaseUrl: null } },
        select: { ospBaseUrl: true, ospApiKey: true },
    });
    const base = String(setting.ospBaseUrl).trim().replace(/\/+$/, '');
    const origin = new URL(base).origin;
    const key = String(setting.ospApiKey || '').trim();
    const ref = '9904222-1802';
    const docId = '1802';

    const candidates = [
        `${base}/files/nonsense/zzz-control.pdf`,          // Kontrolle
        `${base}/files/datasheet/${ref}.pdf`,
        `${base}/files/reports/${ref}.pdf`,
        `${base}/files/report/${ref}.pdf`,
        `${base}/datasheets/${ref}.pdf`,
        `${base}/files/datasheets/${docId}.pdf`,
        `${base}/integration/offer-datasheet/${ref}`,
        `${base}/integration/offer-status/${ref}/datasheet`,
        `${base}/documents/${docId}/datasheet`,
        `${base}/documents/${docId}/pdf`,
        `${origin}/files/datasheets/${docId}.pdf`,
    ];
    for (const url of candidates) {
        try {
            const res = await fetch(url, {
                headers: { 'X-OSP-Integration-Key': key },
                signal: AbortSignal.timeout(15000),
                redirect: 'follow',
            });
            const buf = Buffer.from(await res.arrayBuffer());
            const head = buf.subarray(0, 30).toString('latin1').replace(/\s+/g, ' ');
            console.log(`${res.status} ${res.headers.get('content-type')} bytes=${buf.length} ${url} head=${JSON.stringify(head)}`);
        } catch (e: any) {
            console.log(`FAIL ${url} ${e?.message || e}`);
        }
    }
    await (prisma as any).$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
