import 'dotenv/config';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';
import { articleImageStorage } from '../src/infrastructure/services/ImageStore';
import { getArticleThumbnails } from '../src/infrastructure/services/PdfImageThumbnailService';

const BASE = 'http://localhost:3000/api/v1';

/** Ein echtes, kleines PNG — kein Platzhalter, sharp muss es umwandeln koennen. */
const makePng = async (colour: { r: number; g: number; b: number }) => {
    const png = await sharp({
        create: { width: 600, height: 400, channels: 3, background: colour },
    }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
};

const column = async (id: string) => {
    const [row]: any = await (prisma as any).$queryRawUnsafe('SELECT imageUrl FROM Article WHERE id = ?', id);
    return row?.imageUrl ?? null;
};

(async () => {
    const [owner]: any = await (prisma as any).$queryRawUnsafe(
        "SELECT tenantId, COUNT(*) AS n FROM Article WHERE imageUrl LIKE 'r2:%' GROUP BY tenantId ORDER BY n DESC LIMIT 1");
    const tenantId = owner.tenantId as string;
    const user = await prisma.employee.findFirst({
        where: { deletedAt: null, bannedAt: null, isActive: true, tenantId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    if (!user) throw new Error('kein Konto');
    const token = jwtTokenService.generateToken('access', {
        id: user.id, tenantId, email: user.email, pwdAt: toPwdAtClaim(user.passwordChangedAt),
    } as any);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const id = nanoid(10);
    const articleCode = `ZZ-IMG-${id}`;
    await (prisma as any).article.create({
        data: { id, tenantId, articleCode, name: 'Bildprobe (wird gelöscht)', unit: 'Stk', baseCost: 0, salePrice: 0 },
    });
    console.log('Probeprodukt:', articleCode, `(${id})\n`);

    try {
        // 1. ERSTES BILD
        const first = await makePng({ r: 200, g: 40, b: 40 });
        let res = await fetch(`${BASE}/inventory/articles/${id}/detail`, {
            method: 'PATCH', headers, body: JSON.stringify({ imageUrl: first }),
        });
        let body: any = await res.json();
        const refA = await column(id);
        console.log(`1. Neues Bild hochladen -> ${res.status}`);
        console.log('   Spalte  :', refA);
        console.log('   Adresse :', body.imageUrl);
        const assetA = await fetch(String(body.imageUrl));
        console.log(`   abrufbar: ${assetA.status} ${assetA.headers.get('content-type')} ${assetA.headers.get('content-length')}B`);

        // 2. PDF-VORSCHAUBILD — muss eine Daten-URI sein, nie ein Verweis.
        const article = await (prisma as any).article.findUnique({ where: { id }, select: { updatedAt: true } });
        await (prisma as any).pdfImageThumbnail.deleteMany({ where: { tenantId, sourceType: 'ARTICLE', sourceId: id } });
        const thumbs = await getArticleThumbnails(tenantId, [{ id, updatedAt: article.updatedAt }]);
        const thumb = thumbs[0]?.imageUrl || '';
        console.log(`\n2. PDF-Vorschaubild aus dem Verweis`);
        console.log('   Anfang  :', thumb.slice(0, 34));
        console.log('   Groesse :', thumb.length, 'Zeichen');
        console.log('   ', thumb.startsWith('data:image/') ? 'ist ein Bild — richtig.' : '!!! kein Bild');

        // 3. ERSETZEN — das alte Objekt muss verschwinden.
        const second = await makePng({ r: 30, g: 90, b: 220 });
        res = await fetch(`${BASE}/inventory/articles/${id}/detail`, {
            method: 'PATCH', headers, body: JSON.stringify({ imageUrl: second }),
        });
        body = await res.json();
        const refB = await column(id);
        console.log(`\n3. Bild ersetzen -> ${res.status}`);
        console.log('   neue Spalte:', refB);
        let oldGone = false;
        try { await articleImageStorage.read(String(refA)); } catch { oldGone = true; }
        console.log('   altes Objekt:', oldGone ? 'aufgeräumt — richtig.' : '!!! liegt noch im Eimer');
        const assetB = await fetch(String(body.imageUrl));
        console.log(`   neues abrufbar: ${assetB.status} ${assetB.headers.get('content-length')}B`);

        // 4. LEEREN
        res = await fetch(`${BASE}/inventory/articles/${id}/detail`, {
            method: 'PATCH', headers, body: JSON.stringify({ imageUrl: null }),
        });
        body = await res.json();
        const refC = await column(id);
        let secondGone = false;
        try { await articleImageStorage.read(String(refB)); } catch { secondGone = true; }
        console.log(`\n4. Bild entfernen -> ${res.status}`);
        console.log('   Spalte :', refC === null ? 'NULL — richtig.' : `!!! ${refC}`);
        console.log('   Adresse:', body.imageUrl === null ? 'null — richtig.' : `!!! ${body.imageUrl}`);
        console.log('   Objekt :', secondGone ? 'aufgeräumt — richtig.' : '!!! liegt noch im Eimer');

        // 5. UNSINN wird abgewiesen.
        res = await fetch(`${BASE}/inventory/articles/${id}/detail`, {
            method: 'PATCH', headers, body: JSON.stringify({ imageUrl: 'https://example.com/fremd.png' }),
        });
        console.log(`\n5. Fremde Adresse -> ${res.status} ${res.status === 400 ? '(abgewiesen — richtig.)' : '!!! angenommen'}`);
    } finally {
        await (prisma as any).pdfImageThumbnail.deleteMany({ where: { tenantId, sourceType: 'ARTICLE', sourceId: id } });
        await (prisma as any).article.delete({ where: { id } });
        console.log('\nProbeprodukt entfernt.');
    }
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
