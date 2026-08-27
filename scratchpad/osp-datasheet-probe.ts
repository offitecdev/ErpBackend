import dotenv from 'dotenv';
dotenv.config();
import prisma from '../src/infrastructure/database/prisma.client';

/**
 * Nur lesen/prüfen: Lässt sich das Datenblatt einer echten Zeile über eine aus
 * der Referenz ABGELEITETE Adresse holen (Muster aus offer-integration-api §1:
 * https://osp.offitec.ch/files/datasheets/<reference>.pdf)? Für Zeilen, deren
 * Webhook noch keine datasheetUrl trug.
 */
const sameHost = (a: string, b: string): boolean => {
    try { return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase(); }
    catch { return false; }
};

(async () => {
    const setting = await (prisma as any).ospSetting.findFirst({
        where: { NOT: { ospBaseUrl: null } },
        select: { tenantId: true, ospBaseUrl: true, ospApiKey: true },
    });
    if (!setting?.ospBaseUrl) { console.log('no OSP setting with base url'); process.exit(0); }
    const base = String(setting.ospBaseUrl).trim().replace(/\/+$/, '');
    console.log('base url:', base);
    const origin = new URL(base).origin;

    const docs = await (prisma as any).ospDocument.findMany({
        where: { datasheetFile: null },
        orderBy: { createdAt: 'desc' },
        take: 2,
        select: { reference: true },
    });
    if (!docs.length) { console.log('no rows without datasheet'); process.exit(0); }

    for (const doc of docs) {
        const ref = doc.reference;
        const candidates = [
            `${origin}/files/datasheets/${ref}.pdf`,
            `${base}/files/datasheets/${ref}.pdf`,
            `${base}/integration/datasheet/${ref}`,
            `${base}/integration/datasheets/${ref}`,
        ];
        for (const url of candidates) {
            const headers: Record<string, string> = (setting.ospApiKey && sameHost(url, base))
                ? { 'X-OSP-Integration-Key': String(setting.ospApiKey).trim() }
                : {};
            try {
                const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000), redirect: 'follow' });
                const buf = Buffer.from(await res.arrayBuffer());
                const head = buf.subarray(0, 8).toString('latin1');
                console.log(`${ref} ${url} -> ${res.status} ${res.headers.get('content-type')} bytes=${buf.length} head=${JSON.stringify(head)}`);
            } catch (e: any) {
                console.log(`${ref} ${url} -> FAIL ${e?.name || ''} ${e?.message || e}`);
            }
        }
    }
    await (prisma as any).$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
