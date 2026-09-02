import 'dotenv/config';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';
import { articleImageStorage } from '../src/infrastructure/services/ImageStore';

const BASE = 'http://localhost:3000/api/v1';

const makePng = async (r: number, g: number, b: number) => {
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r, g, b } } }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
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

    const tag = nanoid(6);
    const codes = [`ZZ-BULK-${tag}-A`, `ZZ-BULK-${tag}-B`, `ZZ-BULK-${tag}-C`];
    const items = [
        { articleCode: codes[0], name: 'Massenprobe mit Bild', unit: 'Stk', quantity: 0, imageUrl: await makePng(10, 160, 90) },
        // Diese Zeile hat ein Bild, faellt aber am fehlenden Namen aus.
        { articleCode: codes[1], name: '', unit: 'Stk', quantity: 0, imageUrl: await makePng(220, 200, 10) },
        { articleCode: codes[2], name: 'Massenprobe ohne Bild', unit: 'Stk', quantity: 0 },
    ];

    const res = await fetch(`${BASE}/inventory/articles/bulk`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
    });
    const body: any = await res.json();
    console.log(`POST /inventory/articles/bulk -> ${res.status}`);
    console.log('  angelegt:', (body.created || []).length, '| Fehler:', (body.errors || []).length);
    (body.errors || []).forEach((e: any) => console.log(`     Zeile ${e.index}: ${e.error}`));

    const rows: any[] = await (prisma as any).$queryRawUnsafe(
        `SELECT articleCode, imageUrl FROM Article WHERE tenantId = ? AND articleCode IN (?, ?, ?)`,
        tenantId, codes[0], codes[1], codes[2]);

    console.log('\nSpalten nach dem Import:');
    for (const row of rows) {
        const kind = row.imageUrl === null ? 'NULL'
            : String(row.imageUrl).startsWith('r2:') ? `Verweis  ${row.imageUrl}`
                : `!!! ${String(row.imageUrl).slice(0, 40)}`;
        console.log(`  ${row.articleCode}: ${kind}`);
        if (String(row.imageUrl || '').startsWith('r2:')) {
            const url = await articleImageStorage.displayUrl(row.imageUrl);
            const asset = await fetch(String(url));
            console.log(`     ${asset.status} ${asset.headers.get('content-type')} ${asset.headers.get('content-length')}B`);
        }
    }
    console.log(rows.length === 2 ? '\n  Die namenlose Zeile wurde NICHT angelegt — richtig.' : `\n  !!! ${rows.length} Zeilen`);

    // Aufräumen inkl. der Objekte im Eimer.
    for (const row of rows) {
        if (String(row.imageUrl || '').startsWith('r2:')) await articleImageStorage.remove(row.imageUrl);
    }
    // Der Import schreibt auch Bestands- und Bewegungszeilen — die haengen am
    // Fremdschluessel und muessen zuerst weg.
    const ids = (await (prisma as any).article.findMany({
        where: { tenantId, articleCode: { in: codes } }, select: { id: true },
    })).map((r: any) => r.id);
    await (prisma as any).articleSupplier.deleteMany({ where: { articleId: { in: ids } } });
    await (prisma as any).stockMovement.deleteMany({ where: { articleId: { in: ids } } });
    await (prisma as any).stockBalance.deleteMany({ where: { articleId: { in: ids } } });
    await (prisma as any).pdfImageThumbnail.deleteMany({ where: { tenantId, sourceType: 'ARTICLE', sourceId: { in: ids } } });
    const deleted = await (prisma as any).article.deleteMany({ where: { tenantId, articleCode: { in: codes } } });
    console.log(`\nAufgeräumt: ${deleted.count} Probeprodukte entfernt.`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
