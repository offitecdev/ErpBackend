import { normalizeRichText } from '../src/shared/richText';
import * as fs from 'fs';

/* Die Verkaufsbeschreibung der Datei ist REINER TEXT. Auf dem Server läuft sie
   durch `normalizeRichText` (dieselbe Prüfung wie im Produktformular) — dieser
   Lauf belegt an den ECHTEN Zeilen der Beispieldatei, dass dabei nichts
   verloren geht: keine Umlaute, keine Zeilenumbrüche, keine Sonderzeichen wie
   "≤", "°C" oder "3 x 1,5 mm²". */
const CSV = 'C:/ERP/Erp_Backend/Produkt (product.template) (1).csv';
const DESC_COL = 8;
const IMAGE_COL = 7;
const SAMPLE = 300;

const samples: string[] = [];
let col = 0;
let field: string[] = [];
let quoted = false;
let rowIndex = 0;
let current: Record<number, string> = {};

const pushField = () => {
    if (col !== IMAGE_COL) current[col] = field.join('');
    field = [];
    col += 1;
};
const endRow = () => {
    pushField();
    if (rowIndex > 0) {
        const value = (current[DESC_COL] || '').trim();
        if (value) samples.push(value);
    }
    current = {};
    col = 0;
    rowIndex += 1;
};

const stream = fs.createReadStream(CSV, { encoding: 'utf8', highWaterMark: 1 << 20 });
stream.on('data', (chunk: string | Buffer) => {
    const text = String(chunk);
    for (let i = 0; i < text.length; i += 1) {
        const c = text[i] as string;
        if (quoted) {
            if (c !== '"') { if (col !== IMAGE_COL) field.push(c); continue; }
            if (text[i + 1] === '"') { if (col !== IMAGE_COL) field.push('"'); i += 1; continue; }
            quoted = false; continue;
        }
        if (c === '"') { quoted = true; continue; }
        if (c === ',') { pushField(); continue; }
        if (c === '\n') { endRow(); continue; }
        if (c === '\r') continue;
        if (col !== IMAGE_COL) field.push(c);
    }
    if (samples.length >= SAMPLE) stream.destroy();
});

const report = () => {
    let changed = 0;
    let emptied = 0;
    const examples: Array<{ before: string; after: string }> = [];
    for (const value of samples) {
        const after = normalizeRichText(value);
        if (after === null) { emptied += 1; continue; }
        if (after !== value) {
            changed += 1;
            if (examples.length < 5) examples.push({ before: value, after });
        }
    }
    console.log(`${samples.length} echte Verkaufsbeschreibungen durch normalizeRichText():`);
    console.log(`  unverändert : ${samples.length - changed - emptied}`);
    console.log(`  verändert   : ${changed}`);
    console.log(`  zu null     : ${emptied}`);
    for (const example of examples) {
        console.log('\n  VORHER:', JSON.stringify(example.before.slice(0, 160)));
        console.log('  NACHHER:', JSON.stringify(example.after.slice(0, 160)));
    }
};

stream.on('close', report);
stream.on('end', report);
