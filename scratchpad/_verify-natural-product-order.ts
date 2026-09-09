import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
import { InventoryRepository } from '../src/infrastructure/repositories/InventoryRepository';

/* Der ECHTE Repository-Aufruf gegen die ECHTE Datenbank — genau so, wie der
   Produktwähler der Offerte (und damit der von Rechnung und Nachtrag) ihn
   stellt: schlank, mit Beschreibung, nach der neuen Namensordnung. */
(async () => {
    const repository = new InventoryRepository();
    const tenantId = 'main-tenant';

    const first = await repository.getArticleStockSummaryPaged(tenantId, {
        page: 1, pageSize: 10, lean: true, includeDescription: true,
        sortBy: 'nameNatural', sortDirection: 'asc',
    });
    console.log(`Seite 1 von ${first.total} Produkten — Buchstaben zuerst:`);
    for (const a of first.items) console.log('  ', a.name);
    console.log('   Felder:', Object.keys(first.items[0] ?? {}).join(', '));

    const second = await repository.getArticleStockSummaryPaged(tenantId, {
        page: 2, pageSize: 10, lean: true, includeDescription: true,
        sortBy: 'nameNatural', sortDirection: 'asc',
    });
    console.log('\nSeite 2 setzt fort (keine Wiederholung, kein Sprung):');
    for (const a of second.items) console.log('  ', a.name);
    const overlap = first.items.filter((a: any) => second.items.some((b: any) => b.id === a.id));
    console.log('   Überschneidung Seite 1/2:', overlap.length);

    const searched = await repository.getArticleStockSummaryPaged(tenantId, {
        page: 1, pageSize: 12, lean: true, includeDescription: true,
        search: 'DN', sortBy: 'nameNatural', sortDirection: 'asc',
    });
    console.log(`\nSuche "DN" (${searched.total} Treffer) — Zahlen klein nach gross:`);
    for (const a of searched.items) console.log('  ', a.name);

    const numeric = await repository.getArticleStockSummaryPaged(tenantId, {
        page: 1, pageSize: 8, lean: true, includeDescription: true,
        search: '0057', sortBy: 'nameNatural', sortDirection: 'asc',
    });
    console.log('\nReine Zahlennamen, aufsteigend:');
    for (const a of numeric.items) console.log('  ', a.name);

    const listPage = await repository.getArticleStockSummaryPaged(tenantId, {
        page: 1, pageSize: 5, sortBy: 'nameNatural', sortDirection: 'asc',
    });
    console.log('\nDerselbe Schlüssel auf dem Listenweg (mit Bestand):');
    for (const a of listPage.items) console.log('  ', a.name, '| Bestand', a.totalQuantity);

    const untouched = await repository.getArticleStockSummaryPaged(tenantId, { page: 1, pageSize: 3 });
    console.log('\nOhne sortBy — unverändert (neueste zuerst):', untouched.items.map((a: any) => a.name));
    const byName = await repository.getArticleStockSummaryPaged(tenantId, { page: 1, pageSize: 3, sortBy: 'name', sortDirection: 'asc' });
    console.log('sortBy=name — unverändert (rein lexikografisch):', byName.items.map((a: any) => a.name));
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => process.exit(0));
