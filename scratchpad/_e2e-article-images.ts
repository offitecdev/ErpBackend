import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';

const BASE = 'http://localhost:3000/api/v1';

(async () => {
    // Das Konto muss im Mandanten sitzen, in dem die Produktbilder liegen.
    const [owner]: any = await (prisma as any).$queryRawUnsafe(
        "SELECT tenantId, COUNT(*) AS n FROM Article WHERE imageUrl LIKE 'r2:%' GROUP BY tenantId ORDER BY n DESC LIMIT 1");
    const user = await prisma.employee.findFirst({
        where: { deletedAt: null, bannedAt: null, isActive: true, tenantId: owner.tenantId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    if (!user) throw new Error('kein Konto');
    const token = jwtTokenService.generateToken('access', {
        id: user.id, tenantId: user.tenantId, email: user.email, pwdAt: toPwdAtClaim(user.passwordChangedAt),
    } as any);
    const auth = { Authorization: `Bearer ${token}` };
    console.log('Konto:', user.email, '| Mandant:', user.tenantId, '\n');

    const row: any = await (prisma as any).$queryRawUnsafe(
        "SELECT id, articleCode, name FROM Article WHERE tenantId = ? AND imageUrl LIKE 'r2:%' LIMIT 1", user.tenantId);
    if (!row.length) { console.log('kein migriertes Produktbild in diesem Mandanten'); process.exit(0); }
    const article = row[0];
    console.log('Produkt:', article.articleCode, article.name, `(${article.id})\n`);

    // 1. Detailseite: die Adresse muss direkt in der Antwort stehen.
    const detail = await fetch(`${BASE}/inventory/articles/${article.id}/detail`, { headers: auth });
    const detailBody: any = await detail.json();
    console.log(`1. /inventory/articles/:id/detail -> ${detail.status}`);
    console.log('   imageUrl:', detailBody.imageUrl);
    console.log('   Antwortgroesse:', JSON.stringify(detailBody).length, 'Zeichen');

    // 2. Die Adresse muss ohne Anmeldung ein Bild liefern.
    if (detailBody.imageUrl) {
        const asset = await fetch(detailBody.imageUrl);
        console.log(`2. ${new URL(detailBody.imageUrl).host} -> ${asset.status} ${asset.headers.get('content-type')} ${asset.headers.get('content-length')}B`);
    }

    // 3. Der alte Binaerausgang muss weiter Bytes liefern (Verweis wird gelesen).
    const binary = await fetch(`${BASE}/inventory/articles/${article.id}/image?v=x`, { headers: auth });
    console.log(`3. /inventory/articles/:id/image -> ${binary.status} ${binary.headers.get('content-type')} ${(await binary.arrayBuffer()).byteLength}B`);

    // 4. Volles Produkt (Schnellansicht) -> aufgeloeste Adresse.
    const full = await fetch(`${BASE}/articles/${article.id}`, { headers: auth });
    const fullBody: any = await full.json();
    console.log(`4. /articles/:id -> ${full.status}`);
    console.log('   imageUrl:', String(fullBody.imageUrl).slice(0, 96));

    // 5. Suche (Stockbewegung / Offert-Picker).
    const search = await fetch(`${BASE}/inventory/search-items?q=${encodeURIComponent(String(article.articleCode))}`, { headers: auth });
    const searchBody: any = await search.json();
    const hit = (searchBody || []).find((r: any) => r.id === article.id);
    console.log(`5. /inventory/search-items -> ${search.status}`);
    console.log('   imageUrl:', String(hit?.imageUrl).slice(0, 96));

    // 6. Speichern OHNE Bildaenderung darf den Verweis nicht ueberschreiben.
    const before: any = await (prisma as any).$queryRawUnsafe('SELECT imageUrl FROM Article WHERE id = ?', article.id);
    const patch = await fetch(`${BASE}/inventory/articles/${article.id}/detail`, {
        method: 'PATCH',
        headers: { ...auth, 'Content-Type': 'application/json' },
        // Genau die Falle: der Browser schickt die gelesene Adresse zurueck.
        body: JSON.stringify({ imageUrl: detailBody.imageUrl }),
    });
    const after: any = await (prisma as any).$queryRawUnsafe('SELECT imageUrl FROM Article WHERE id = ?', article.id);
    console.log(`6. PATCH mit zurueckgeschickter Adresse -> ${patch.status}`);
    console.log('   Spalte vorher :', before[0].imageUrl);
    console.log('   Spalte nachher:', after[0].imageUrl);
    console.log('   ', before[0].imageUrl === after[0].imageUrl ? 'UNVERAENDERT — richtig.' : '!!! UEBERSCHRIEBEN');

    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
