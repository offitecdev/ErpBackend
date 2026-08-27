import { parseDatasheetSpecs, pickDatasheetUrl } from '../src/infrastructure/services/ospDatasheet';

const DATASHEET = `
OFFITEC Selection Platform
Datenblatt  AWRC-150.2CI290            Projekt 9904222-1403

Leistungsdaten
Heizleistung: 227.3 kW
Kälteleistung           198.4 kW
COP: 3.82
Medium: Wasser

Ausführung
Verdampfer und Verflüssiger für Wasser/Wasser - PWT
Umweltfreundliches Kältemittel R290
Intelligente Steuerung via Schneider Electric

Akustik
Schalldruck bei 1 m: 75 dB(A) mit normalem Schallschutz
Schalldruck bei 10 m: 56 dB(A)

Abmessungen (L x B x H): ca. 2,07 m x 0,90 m x 1,95 m
Betriebsgewicht: ca. 1'403 kg
`;

console.log('=== specs (chiller-style sheet, both capacities) ===');
console.log(JSON.stringify(parseDatasheetSpecs(DATASHEET), null, 2));

const HEAT_ONLY = `Heizleistung
227.3 kW
COP
3.82
Wärmeträger: Wasser
Gewicht 1403 kg
Dimensions 2070 mm x 900 mm x 1950 mm`;
console.log('\n=== specs (heat pump, values on next line) ===');
console.log(JSON.stringify(parseDatasheetSpecs(HEAT_ONLY), null, 2));

console.log('\n=== url picking ===');
const cases: Array<[string, unknown]> = [
    ['pdfUrl', { projectNumber: '1-2', pdfUrl: 'https://osp.offitec.ch/files/a.pdf' }],
    ['datasheet_url', { datasheet_url: 'https://osp.offitec.ch/d/9.pdf' }],
    ['nested document.url', { document: { url: 'https://osp.offitec.ch/x/1.pdf' } }],
    ['proposal link only', { proposalUrl: 'https://osp.offitec.ch/projects/9904222' }],
    ['proposal + pdf', { proposalUrl: 'https://osp.offitec.ch/p/1', datasheetUrl: 'https://osp.offitec.ch/d/1.pdf' }],
    ['generic link to pdf', { link: 'https://osp.offitec.ch/d/2.pdf' }],
    ['no url', { projectNumber: '1-2', model: 'X' }],
];
for (const [label, payload] of cases) console.log(`${label.padEnd(22)} -> ${pickDatasheetUrl(payload)}`);
