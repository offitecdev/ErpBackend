/**
 * EIN EINZIGER ECHTER DURCHGANG BEI OPENAI (07.09.2026).
 *
 * Die grosse Probe (`_ai-import-e2e.ts`) läuft gegen einen nachgebauten Server
 * und kostet nichts. Diese hier geht wirklich hinaus — mit einem kurzen,
 * erfundenen Lieferantenbeleg — und beantwortet die eine Frage, die ein
 * Nachbau nicht beantworten kann: nimmt OpenAI unser Schema an, und kommt
 * zurück, was wir erwarten?
 *
 * Kosten: ein paar hundert Token, also Bruchteile eines Rappens. Die Nutzung
 * steht am Ende auf dem Schirm.
 *
 * Aufruf: npx ts-node --transpile-only scratchpad/_gpt-live.ts
 */

import 'dotenv/config';
import { extractWithGpt, gptConfigured, gptModelName } from '../src/infrastructure/services/gptExtract';
import { compactText } from '../src/infrastructure/services/documentText';

const BELEG = `
Muster Handels AG · Bahnhofstrasse 1 · 8000 Zürich
Offerte AN-2026-4711 vom 01.09.2026

Pos  Art.-Nr.   Bezeichnung              Menge  Einzelpreis  Rabatt  Nettopreis
1    A-100      Schraube M6 verzinkt      100      0.90       20%      0.72
2    A-200      Mutter M6                 100      0.40       20%      0.32
3    B-410      Winkelprofil 40x40 mm      12     14.50       20%     11.60

Ab 500 Stück gilt für Pos. 1 ein Stückpreis von 0.60.
Alle Preise exkl. 8.1% MwSt. Währung CHF.
`;

const main = async () => {
    if (!gptConfigured()) {
        console.error('gptApi fehlt — nichts zu tun.');
        process.exit(1);
    }

    const columns = [
        { key: 'code', name: 'Artikelnummer', type: 'text' as const },
        { key: 'name', name: 'Bezeichnung', type: 'text' as const },
        { key: 'quantity', name: 'Menge', type: 'number' as const },
        { key: 'priceGross', name: 'Einzelpreis', type: 'number' as const },
        { key: 'priceNet', name: 'Nettopreis', type: 'number' as const },
        { key: 'discount', name: 'Rabatt', type: 'number' as const },
    ];

    const text = compactText(BELEG);
    console.log(`Modell: ${gptModelName()} · ${text.length} Zeichen gehen hinaus\n`);

    const result = await extractWithGpt({ text, columns, language: 'de', withTiers: true });

    console.log('Kopfdaten:', {
        supplierName: result.supplierName,
        documentNumber: result.documentNumber,
        currency: result.currency,
        vatRate: result.vatRate,
    });
    console.log('\nPositionen:');
    for (const row of result.rows) console.log(' ', Object.keys(row).join(','), '→', JSON.stringify(row));
    console.log('\nNutzung:', result.usage);

    /* Die Prüfungen, die zählen. */
    const checks: Array<[string, boolean]> = [
        ['drei Positionen erkannt', result.rows.length === 3],
        ['nur unsere Spalten in der Antwort', result.rows.every((row) => Object
            .keys(row).every((key) => [...columns.map((c) => c.key), 'priceTiers'].includes(key)))],
        ['Artikelnummern wörtlich übernommen', ['A-100', 'A-200', 'B-410']
            .every((code) => result.rows.some((row) => String((row as any).code) === code))],
        ['Zahlen sind Zahlen', result.rows.every((row) => typeof (row as any).quantity === 'number')],
        ['Rabatt als Zahl ohne Prozentzeichen', result.rows.every((row) => (row as any).discount === 20)],
        ['Währung und Steuersatz gelesen', result.currency === 'CHF' && result.vatRate === 8.1],
        ['jede Zeile traegt ALLE Spalten (strict)', result.rows.every((row) => columns.every((c) => c.key in (row as any)))],
        ['Preise sind angekommen', result.rows.some((row) => Number((row as any).priceNet) > 0)],
        ['Mengenstaffel bei Position 1 gefunden',
            Array.isArray((result.rows.find((row) => (row as any).code === 'A-100') as any)?.priceTiers)],
    ];

    console.log('');
    let failed = false;
    for (const [label, condition] of checks) {
        if (!condition) failed = true;
        console.log(`${condition ? 'OK  ' : 'FEHL'} ${label}`);
    }
    console.log(failed ? '\n>>> ES GIBT FEHLER' : '\n>>> alles gruen');
    process.exit(failed ? 1 : 0);
};

main().catch((error) => {
    console.error('Durchgang abgebrochen:', error?.code || '', error?.message || error);
    process.exit(1);
});
