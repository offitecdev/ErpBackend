import 'dotenv/config';
import fs from 'fs';
import path from 'path';

/* ── WAS WIRKLICH AN DIE SCHNITTSTELLE GEHT ─────────────────────────────────
   Vorgabe Samet (08.09.2026): «Schreib in eine Textdatei, was du der
   Schnittstelle gibst.»

   Hier wird nichts nachgebaut: der ECHTE Weg wird gegangen (`/ai-extract` samt
   `readDocumentText`, `buildSchema` und `systemPrompt`), nur `fetch` wird
   abgefangen. Was das Abfangen sieht, IST die Anfrage — Wort für Wort.

   Aufruf: npx ts-node scratchpad/_dump-api-request.ts <bild> [ziel.txt] */

process.env.gptApi = process.env.gptApi || 'sk-test-key-not-used';

const calls: any[] = [];
/* Ein Bild geht in ZWEI Schritten hinaus: erst die Abschrift, dann die
   Zuordnung. Beide werden hier abgefangen und beide stehen im Auszug. */
(global as any).fetch = async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init?.headers ?? {}, body });
    const isTranscribe = body?.response_format?.json_schema?.name === 'document_table';
    const content = isTranscribe
        ? { header: 'Kopfzeile', lines: ['(hier stuende die abgeschriebene Tabelle)'] }
        : {
            supplierName: null, documentNumber: null, documentDate: null, currency: null,
            vatRate: null, totalNet: null, rows: [],
        };
    return {
        ok: true,
        status: 200,
        json: async () => ({
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
    } as any;
};

import { purchaseOrderImportRouter } from '../src/presentation/routes/purchaseOrderImport.routes';

const handlerFor = (method: string, routePath: string) => {
    const layer = (purchaseOrderImportRouter as any).stack
        .find((entry: any) => entry.route?.path === routePath && entry.route?.methods?.[method]);
    if (!layer) throw new Error(`Route ${method} ${routePath} nicht gefunden`);
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle;
};

const call = async (body: any) => {
    const handler = handlerFor('post', '/ai-extract');
    const res: any = { status() { return this; }, json() { return this; } };
    calls.length = 0;
    await handler({ body, user: { id: 'dump', tenantId: 'main-tenant' } }, res);
    return [...calls];
};

/* Die Spalten, die die BESTELLSEITE schickt — `templateColumns()` im Browser,
   mit den deutschen Beschriftungen, die dort auf dem Schirm stehen. */
const ORDER_COLUMNS = [
    { key: 'code', name: 'Produktcode', type: 'text' },
    { key: 'name', name: 'Produktname', type: 'text' },
    { key: 'quantity', name: 'Menge', type: 'number' },
    { key: 'priceGross', name: 'Bruttopreis', type: 'number' },
    { key: 'priceNet', name: 'Nettopreis', type: 'number' },
    { key: 'discount', name: 'Rabatt', type: 'number' },
    { key: 'discount2', name: 'Rabatt 2', type: 'number' },
    { key: 'lineTotal', name: 'Zeilensumme', type: 'number' },
];

/* Dieselbe Seite im FIYAT TALEBİ: dort gibt es keine Preise, und die eigenen
   Angaben tragen die Spalten, die dieses Blatt wirklich hat. */
const REQUEST_COLUMNS = [
    { key: 'code', name: 'Ürün Tip Numarası', type: 'text' },
    { key: 'name', name: 'Malzeme Açıklama', type: 'text' },
    { key: 'quantity', name: 'Toplam Adet', type: 'number' },
    { key: 'x1', name: 'Malzeme Grubu', type: 'text' },
    { key: 'x2', name: 'Ürün Sip. Numarası', type: 'text' },
    { key: 'x3', name: 'Üretici', type: 'text' },
    { key: 'x4', name: 'Birim', type: 'text' },
    { key: 'x5', name: 'Toplam Uzunluk', type: 'number' },
];

const rule = (title: string) => `\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n`;

/** Base64 ist hier hunderttausend Zeichen lang — gezeigt wird Kopf und Fuss. */
const shortenImage = (url: string): string => {
    const comma = url.indexOf(',');
    const head = url.slice(0, comma + 1);
    const data = url.slice(comma + 1);
    return `${head}${data.slice(0, 64)}`
        + `\n            […  ${data.length.toLocaleString('de-CH')} Zeichen Base64  …]\n            `
        + `${data.slice(-32)}`;
};

const render = (sent: any, label: string, note: string): string => {
    const body = sent.body;
    const messages = body.messages ?? [];
    const system = messages[0]?.content ?? '';
    const user = messages[1]?.content;
    const textPart = Array.isArray(user) ? user.find((p: any) => p.type === 'text')?.text : user;
    const imagePart = Array.isArray(user) ? user.find((p: any) => p.type === 'image_url') : null;

    const out: string[] = [];
    out.push(rule(label));
    out.push(note);
    out.push(`\nPOST ${sent.url}`);
    out.push('Content-Type: application/json');
    out.push('Authorization: Bearer sk-…  (der Schlüssel steht nur auf dem Server)');
    out.push('');
    out.push('--- Kopf der Anfrage ------------------------------------------------------');
    out.push(`model:       ${body.model}`);
    out.push(`temperature: ${body.temperature}`);
    out.push(`max_tokens:  ${body.max_tokens}`);
    out.push(`response_format.type: ${body.response_format?.type}`);
    out.push(`response_format.json_schema.name:   ${body.response_format?.json_schema?.name}`);
    out.push(`response_format.json_schema.strict: ${body.response_format?.json_schema?.strict}`);

    out.push('\n--- messages[0]  role: system  (die Anweisung) ----------------------------');
    out.push(String(system));

    out.push('\n--- messages[1]  role: user ----------------------------------------------');
    if (imagePart) {
        out.push('content[0]  type: text');
        out.push(String(textPart));
        out.push('');
        out.push('content[1]  type: image_url');
        out.push(`            detail: ${imagePart.image_url?.detail}`);
        out.push(`            url:    ${shortenImage(String(imagePart.image_url?.url))}`);
    } else {
        out.push('content (Text):');
        out.push(String(textPart));
    }

    out.push('\n--- response_format.json_schema.schema  (die erzwungene Antwortform) ------');
    out.push(JSON.stringify(body.response_format?.json_schema?.schema, null, 2));
    return out.join('\n');
};

(async () => {
    const imagePath = process.argv[2];
    if (!imagePath) throw new Error('Bitte den Pfad zum Bild angeben.');
    const target = process.argv[3] || path.join(path.dirname(imagePath), 'api-anfrage.txt');

    const bytes = fs.readFileSync(imagePath);
    const base64 = bytes.toString('base64');

    const head: string[] = [];
    head.push('WAS DIE ANWENDUNG AN DIE SCHNITTSTELLE GIBT');
    head.push('===========================================');
    head.push('');
    head.push(`Beleg:        ${path.basename(imagePath)}`);
    head.push(`Grösse:       ${bytes.length.toLocaleString('de-CH')} Bytes`);
    head.push(`Als Base64:   ${base64.length.toLocaleString('de-CH')} Zeichen`);
    head.push(`Erzeugt am:   ${new Date().toISOString()}`);
    head.push('');
    head.push('Diese Datei ist KEINE Nachbildung. Der echte Weg der Bestellseite wurde');
    head.push('gegangen und die ausgehenden Anfragen abgefangen — was hier steht, ist');
    head.push('Wort für Wort das, was an die Schnittstelle geht. Nur der Schlüssel und');
    head.push('der Bildinhalt sind gekürzt.');
    head.push('');
    head.push('SEIT DEM 08.09.2026 SIND ES ZWEI SCHRITTE (Vorgabe Samet):');
    head.push('  1. Das Bild wird ordentlich in eine TABELLE umgewandelt.');
    head.push('  2. Diese Tabelle — nicht das Bild — geht an das Modell, das die');
    head.push('     Spalten der Vorlage zuordnet.');
    head.push('Eine angesagte Zeilenzahl gibt es nicht mehr; die Zahl ergibt sich aus');
    head.push('der Abschrift und wird gegen die Zuordnung geprüft.');

    const order = await call({
        language: 'de', columns: ORDER_COLUMNS, withTiers: true,
        data: base64, fileName: path.basename(imagePath), mimeType: 'image/png',
    });
    const request = await call({
        language: 'tr', columns: REQUEST_COLUMNS, withTiers: false,
        data: base64, fileName: path.basename(imagePath), mimeType: 'image/png',
    });

    const text = [
        head.join('\n'),
        render(order[0], 'STUFE 1 — DIE ORDENTLICHE UMWANDLUNG (Bild → Tabelle)',
            'Hier geht die Aufnahme hin, und NUR hier. Dieser Durchgang ordnet nichts\n'
            + 'zu: er schreibt die Tabelle ab, Zeile für Zeile, Zellen mit Tabulator,\n'
            + 'leere Zelle bleibt leer. Was er zurückgibt, ist eine Liste von Zeilen —\n'
            + 'lesbar, mit dem Blatt vergleichbar, und in der Antwort der Anwendung\n'
            + 'unter «transcript» zu finden.'),
        render(order[1], 'STUFE 2a — DIE ZUORDNUNG, Bestellung (Standardvorlage, Deutsch)',
            'Dieser Durchgang bekommt KEIN Bild mehr, sondern die abgeschriebene\n'
            + 'Tabelle als Text — genau wie eine Excel-Datei. ⚠ Dieses Blatt trägt gar\n'
            + 'keine Preise: Bruttopreis, Nettopreis, Rabatt und Zeilensumme finden auf\n'
            + 'ihm nichts und kommen als null zurück.'),
        render(request[1], 'STUFE 2b — DIE ZUORDNUNG, wie sie zu DIESEM Blatt passt',
            'Dieselbe Abschrift, aber die Vorlage trägt die Überschriften, die WIRKLICH\n'
            + 'auf dem Blatt stehen. «Ürün Tip Numarası» ist dabei der Produktcode — die\n'
            + 'Typennummer IST der Code. Die übrigen Spalten reisen als eigene Angaben\n'
            + '(x1…x5) mit.'),
        '',
    ].join('\n');

    fs.writeFileSync(target, text, 'utf8');
    console.log(`geschrieben: ${target}`);
    console.log(`             ${text.length.toLocaleString('de-CH')} Zeichen`);
})().catch((e) => { console.error(e); process.exit(1); });
