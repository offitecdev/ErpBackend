/**
 * ── SELBSTTEST DER DRITTEN VERTRAGSFASSUNG (offer-integration-api.md) ───────
 * Ohne Datenbank und ohne laufenden Server: geprüft wird die Auswertung der
 * Nutzlast, also genau das, was sich mit der neuen Fassung geändert hat.
 *
 * Die Eingaben sind WÖRTLICH die Beispiele aus dem Vertrag (§1 und §1b) —
 * kommen sie hier durch, kommt auch die echte Anfrage durch.
 *
 *     npx ts-node scratchpad/osp-contract-v3-check.ts
 */
import {
    mergeSpecs,
    pickDatasheetUrl,
    specsFromOfferEntry,
    parseDatasheetSpecs,
} from '../src/infrastructure/services/ospDatasheet';

let failed = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a === b) { console.log(`  ok   ${name}`); return; }
    failed += 1;
    console.log(`  FAIL ${name}\n       erwartet: ${b}\n       erhalten: ${a}`);
};

/* ── §1, erster Eintrag des Vertragsbeispiels: ein CHILLER ───────────────── */
const CHILLER = {
    username: 'Anna',
    surname: 'Keller',
    companyName: 'Keller Kältetechnik AG',
    email: 'anna.keller@example.com',
    phone: '+41 44 123 45 67',
    country: 'Switzerland',
    city: 'Zürich',
    projectAddress: 'Bahnhofstrasse 12, 8005 Zürich',
    shippingAddress: 'Bahnhofstrasse 12, 8005 Zürich',
    billingAddress: 'Postfach 44, 8021 Zürich',
    projectNumber: '4820193-57',
    pdfUrl: 'https://assets.osp.offitec.ch/documents/4820193-57-datasheet.pdf',
    created_at: '2026-08-21T09:14:07.482',
    coolingCapacityKw: '106.2',
    heatingCapacityKw: null,
    eer: '2.8',
    cop: null,
    refrigerant: 'R290',
    condenserType: 'Micro-channel',
    evaporatorType: 'Plate',
    soundPressureAt1mDb: '72.4',
    soundPressureAt10mDb: '52.4',
    lengthMm: '2400',
    widthMm: '1100',
    heightMm: '2050',
    operatingWeightKg: '980',
};

/* ── §1, zweiter Eintrag: eine WÄRMEPUMPE (beide Leistungen, beide Zahlen) ─ */
const HEAT_PUMP = {
    ...CHILLER,
    projectNumber: '4820193-58',
    pdfUrl: 'https://assets.osp.offitec.ch/documents/4820193-58-datasheet.pdf',
    coolingCapacityKw: '118.4',
    heatingCapacityKw: '131.7',
    eer: '3.1',
    cop: '4.2',
    refrigerant: 'R32',
    condenserType: 'Plate',
    evaporatorType: 'Plate',
    soundPressureAt1mDb: '69.8',
    soundPressureAt10mDb: '49.8',
    lengthMm: '1900',
    widthMm: '1000',
    heightMm: '1850',
    operatingWeightKg: '740',
};

console.log('\n§1 — die berechneten Angaben aus der Nutzlast');
check('Chiller: Kühlleistung ist die Kopfzahl', specsFromOfferEntry(CHILLER), {
    power: '106.2 kW',
    powerIsCooling: true,
    eer: '2.8',
    technology: 'Verdampfer: Plate\nVerflüssiger: Micro-channel\nKältemittel: R290',
    sound1m: '72.4 dB(A)',
    sound10m: '52.4 dB(A)',
    dimensions: '2400 x 1100 x 2050 mm',
    weight: '980 kg',
});
check('Wärmepumpe: Heizleistung führt, Kühlleistung daneben', specsFromOfferEntry(HEAT_PUMP), {
    power: '131.7 kW',
    powerIsCooling: false,
    coolingPower: '118.4 kW',
    cop: '4.2',
    eer: '3.1',
    technology: 'Verdampfer: Plate\nVerflüssiger: Plate\nKältemittel: R32',
    sound1m: '69.8 dB(A)',
    sound10m: '49.8 dB(A)',
    dimensions: '1900 x 1000 x 1850 mm',
    weight: '740 kg',
});

/* "Ein Beleg, dessen Bericht die Momentaufnahme noch nicht hatte" (§1): jedes
   Feld dieses Abschnitts ist null — dann bleibt schlicht nichts übrig. */
const OLD_DOCUMENT: Record<string, unknown> = { ...CHILLER };
for (const key of [
    'coolingCapacityKw', 'heatingCapacityKw', 'eer', 'cop', 'refrigerant',
    'condenserType', 'evaporatorType', 'soundPressureAt1mDb', 'soundPressureAt10mDb',
    'lengthMm', 'widthMm', 'heightMm', 'operatingWeightKg',
]) OLD_DOCUMENT[key] = null;
check('alter Beleg (alles null) ergibt keine Angaben', specsFromOfferEntry(OLD_DOCUMENT), {});

/* Eine halbe Abmessung ist keine Abmessung. */
check(
    'unvollständige Abmessung fällt weg',
    specsFromOfferEntry({ lengthMm: '2400', widthMm: null, heightMm: '2050' }).dimensions,
    undefined,
);

console.log('\n§1 — pdfUrl schlägt jedes andere Adressfeld');
check('pdfUrl gewinnt', pickDatasheetUrl(CHILLER), CHILLER.pdfUrl);
check(
    'pdfUrl schlägt auch einen verlockenderen Feldnamen',
    pickDatasheetUrl({ pdfUrl: 'https://a.example/x.pdf', datasheetUrl: 'https://b.example/y.pdf' }),
    'https://a.example/x.pdf',
);
check(
    'ohne pdfUrl greift weiterhin die Suche',
    pickDatasheetUrl({ datasheetUrl: 'https://b.example/y.pdf', proposalUrl: 'https://c.example/offer' }),
    'https://b.example/y.pdf',
);

console.log('\nDas PDF füllt nur noch auf, was der Vertrag nicht kennt');
const fromPdf = parseDatasheetSpecs([
    'Kühlleistung: 99.9 kW',
    'COP: 1.11',
    'Medium: Wasser/Glykol',
].join('\n'));
const merged = mergeSpecs(fromPdf, specsFromOfferEntry(CHILLER));
check('Zahlen des Vertrags gewinnen', merged.power, '106.2 kW');
check('COP aus dem PDF weicht dem EER des Vertrags nicht', merged.cop, '1.11');
check('… der EER steht daneben', merged.eer, '2.8');
check('das Medium kommt weiterhin aus dem PDF', merged.medium, 'Wasser/Glykol');

console.log('\n§1b — der Rückzug (Vertragsbeispiel)');
const WITHDRAWAL = {
    projectNumber: '4820193-57',
    projectName: 'Basel Data Centre',
    username: 'Anna',
    surname: 'Keller',
    email: 'anna.keller@example.com',
    offerStatus: 'under review',
    salesmanEmail: 'marco.rossi@offitec.ch',
    withdrawn_at: '2026-08-31T14:22:09.114',
};
check('Zeitpunkt ist lesbar', Number.isNaN(Date.parse(WITHDRAWAL.withdrawn_at)), false);
check(
    'Name der zurückziehenden Person',
    [WITHDRAWAL.username, WITHDRAWAL.surname].filter(Boolean).join(' '),
    'Anna Keller',
);

console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen.\n` : '\nAlles in Ordnung.\n');
process.exit(failed ? 1 : 0);
