import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
import { InventoryRepository } from '../src/infrastructure/repositories/InventoryRepository';

/* Der schnelle Rohweg der Produktliste ($queryRaw) hat `includeDescription`
   bisher verschluckt — die Fahne wirkte nur auf dem Prisma-Weg. Hier wird der
   ECHTE Repository-Aufruf gegen die ECHTE Datenbank gefahren: einmal ohne und
   einmal mit der Fahne, damit sowohl das SQL als auch die Form der Antwort
   belegt sind. */
(async () => {
    const repository = new InventoryRepository();
    const tenant = await (prisma as any).article.findFirst({
        where: { deletedAt: null, description: { not: null } },
        select: { tenantId: true },
    });
    if (!tenant) {
        console.log('Kein Mandant mit beschriebenen Produkten — Test nicht aussagekraeftig.');
        return;
    }
    const tenantId = tenant.tenantId;

    const plain = await repository.getArticleStockSummaryPaged(tenantId, { page: 1, pageSize: 3 });
    console.log('OHNE includeDescription — Schluessel der ersten Zeile:');
    console.log('  ', Object.keys(plain.items[0] ?? {}).join(', '));
    console.log('   traegt "description"?', Object.prototype.hasOwnProperty.call(plain.items[0] ?? {}, 'description'));

    const withDescription = await repository.getArticleStockSummaryPaged(tenantId, {
        page: 1,
        pageSize: 3,
        includeDescription: true,
    });
    console.log('\nMIT includeDescription — Schluessel der ersten Zeile:');
    console.log('  ', Object.keys(withDescription.items[0] ?? {}).join(', '));
    for (const item of withDescription.items) {
        const text = item.description === null ? '(null)' : String(item.description).replace(/\s+/g, ' ').slice(0, 70);
        console.log(`   ${String(item.articleCode).padEnd(12)} ${text}`);
    }

    // Die Suche muss dieselbe Zeile in beiden Formen liefern; sonst haette die
    // neue Spalte die Gruppierung veraendert.
    const searched = await repository.getArticleStockSummaryPaged(tenantId, {
        page: 1,
        pageSize: 5,
        search: String(withDescription.items[0]?.articleCode ?? ''),
        includeDescription: true,
    });
    console.log('\nSuche nach der ersten Artikelnummer:', searched.total, 'Treffer,',
        searched.items.length, 'Zeile(n) — Menge:', searched.items[0]?.totalQuantity);

    // Der Prisma-Weg (lean) muss unveraendert weiterhin beschreiben.
    const lean = await repository.getArticleStockSummaryPaged(tenantId, {
        page: 1,
        pageSize: 2,
        lean: true,
        includeDescription: true,
    });
    console.log('\nLean-Weg (Produktwaehler) — Schluessel:', Object.keys(lean.items[0] ?? {}).join(', '));

    await prisma.$disconnect();
})().catch(async (error) => {
    console.error('FEHLER:', error);
    await prisma.$disconnect();
    process.exit(1);
});
