import 'dotenv/config';

/* ── PRÜFUNG DES BELEG-IMPORTS (Fehlerbild Samet 08.09.2026) ────────────────
   Zwei Fragen, beide ohne einen einzigen Rappen bei OpenAI:

     1. Geht ein FOTO jetzt wirklich als BILD an das Modell — und nicht mehr
        durch den Texterkenner, der die Spalten flachklopft?
     2. Steht der Zeilenanker als ERSTE Eigenschaft im Antwortschema, und
        verlangt die Anweisung die Zuordnung Zeile für Zeile?

   Dafür wird `fetch` abgefangen: die Anfrage, die an OpenAI GINGE, wird
   festgehalten und beantwortet, ohne das Haus zu verlassen. */

process.env.gptApi = process.env.gptApi || 'sk-test-key-not-used';

const calls: any[] = [];
let nextRows: any[] = [];
/* Seit dem 08.09.2026 geht ein Bild ZWEIMAL hinaus: erst die Abschrift
   (Schema `document_table`), dann die Zuordnung. Ohne Zeilen in der
   Abschrift bricht die Route mit 422 ab — richtig so, hier muessen sie
   also gestellt werden. */
let nextLines: string[] = ['10  ART-1  Pumpe  1  78.10'];

const canned = (rows: any[]) => ({
    ok: true,
    status: 200,
    json: async () => ({
        choices: [{
            finish_reason: 'stop',
            message: {
                content: JSON.stringify({
                    supplierName: 'Muster AG', documentNumber: 'A-1', documentDate: '2026-09-08',
                    currency: 'CHF', vatRate: 8.1, totalNet: 100, rows,
                }),
            },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
});

(global as any).fetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body?.response_format?.json_schema?.name === 'document_table') {
        return {
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
                    header: 'Pos\tCode\tBezeichnung\tMenge\tPreis', lines: nextLines,
                }) } }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
        } as any;
    }
    return canned(nextRows) as any;
};

/** Der Aufruf, der die Positionen zuordnet — bei einem Bild der zweite. */
const mappingCall = () => calls.find((c) => c?.response_format?.json_schema?.name === 'supplier_document');
/** Der Aufruf, der die Tabelle abschreibt — bei einem Bild der erste. */
const transcribeCall = () => calls.find((c) => c?.response_format?.json_schema?.name === 'document_table');

import { purchaseOrderImportRouter } from '../src/presentation/routes/purchaseOrderImport.routes';

/** Den echten Handler aus dem Router ziehen — an den Wächtern vorbei. */
const handlerFor = (method: string, path: string) => {
    const layer = (purchaseOrderImportRouter as any).stack
        .find((entry: any) => entry.route?.path === path && entry.route?.methods?.[method]);
    if (!layer) throw new Error(`Route ${method} ${path} nicht gefunden`);
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle;
};

const call = async (body: any) => {
    const handler = handlerFor('post', '/ai-extract');
    let status = 0;
    let payload: any = null;
    const res: any = {
        status(code: number) { status = code; return this; },
        json(value: any) { payload = value; return this; },
    };
    calls.length = 0;
    await handler({ body, user: { id: 'u1', tenantId: 'main-tenant' } }, res);
    return { status, payload };
};

const columns = [
    { key: 'code', name: 'Artikelnummer', type: 'text' },
    { key: 'name', name: 'Bezeichnung', type: 'text' },
    { key: 'quantity', name: 'Menge', type: 'number' },
    { key: 'priceGross', name: 'Bruttopreis', type: 'number' },
];
const base = { language: 'de', columns, withTiers: false };

let failed = 0;
const say = (label: string, ok: boolean, extra = '') => {
    if (!ok) failed += 1;
    console.log(`${ok ? '  OK ' : '  -- '} ${label}${extra ? ` — ${extra}` : ''}`);
};
const imagePartOf = (content: any) => (Array.isArray(content)
    ? content.find((part: any) => part.type === 'image_url')
    : null);
const textPartOf = (content: any) => (Array.isArray(content)
    ? content.find((part: any) => part.type === 'text')?.text ?? ''
    : '');

(async () => {
    /* ── 1) FOTO ─────────────────────────────────────────────────────────── */
    nextRows = [{
        sourceLine: '10  ART-1  Pumpe  1  78.10',
        code: 'ART-1', name: 'Pumpe', quantity: 1, priceGross: 78.1,
    }];
    const photo = await call({ ...base, data: 'QUJD', fileName: 'beleg.jpg', mimeType: 'image/jpeg' });
    /* Das BILD reist im ersten Aufruf (Abschrift), das SCHEMA der Positionen
       im zweiten (Zuordnung) — darum zwei verschiedene Quellen. */
    const sent = mappingCall();
    const content = transcribeCall()?.messages?.[1]?.content;
    const imagePart = imagePartOf(content);

    console.log('\n── Foto ───────────────────────────────────────────────');
    say('Antwort 200', photo.status === 200, `status ${photo.status}`);
    say('engine = gpt-vision (kein Texterkenner)', photo.payload?.engine === 'gpt-vision', String(photo.payload?.engine));
    say('source = image', photo.payload?.source === 'image');
    say('zwei Durchgaenge: erst abschreiben, dann zuordnen', calls.length === 2, `${calls.length} Aufruf(e)`);
    say('das Bild reist als image_url', Boolean(imagePart));
    say('detail: high (Rappenstellen bleiben lesbar)', imagePart?.image_url?.detail === 'high');
    say('genau EIN data:-Kopf', (String(imagePart?.image_url?.url).match(/data:/g) || []).length === 1,
        String(imagePart?.image_url?.url).slice(0, 40));
    say('die Abschrift zaehlt Zeichen (sie IST jetzt der Text)',
        Number(photo.payload?.text?.chars) > 0, `${photo.payload?.text?.chars} Zeichen`);
    say('Position kommt durch', photo.payload?.rows?.length === 1);
    say('Zeilenanker reist mit', Boolean(photo.payload?.rows?.[0]?.sourceLine),
        String(photo.payload?.rows?.[0]?.sourceLine));

    /* ── 2) DAS SCHEMA UND DIE ANWEISUNG ─────────────────────────────────── */
    const schema = sent?.response_format?.json_schema?.schema;
    const rowProps = Object.keys(schema?.properties?.rows?.items?.properties || {});
    const required: string[] = schema?.properties?.rows?.items?.required || [];
    const prompt = String(sent?.messages?.[0]?.content || '');

    console.log('\n── Schema & Anweisung ─────────────────────────────────');
    say('sourceLine ist die ERSTE Eigenschaft', rowProps[0] === 'sourceLine', rowProps.join(', '));
    say('sourceLine ist verlangt (strict)', required.includes('sourceLine'));
    say('Anweisung: eine Zeile nach der anderen', /ONE POSITION LINE AT A TIME/.test(prompt));
    say('Anweisung: erst abschreiben, dann zerlegen', /first copy its whole printed line verbatim/.test(prompt));
    say('Anweisung: nichts von der Nachbarzeile', /Never take a value from the line above or below/.test(prompt));
    say('Anweisung: Reihenfolge bleibt', /never reorder them/.test(prompt));
    say('Anker wird NICHT übersetzt', /is never translated/.test(prompt));
    say('der Abschrift-Auftrag nennt die Tabelle', /Transcribe the table in this image/.test(textPartOf(content)));

    /* ── 3) data:-Kopf mitgeschickt ──────────────────────────────────────── */
    const withHeader = await call({ ...base, data: 'data:image/png;base64,QUJD', fileName: 'foto.png' });
    const headerUrl = String(imagePartOf(transcribeCall()?.messages?.[1]?.content)?.image_url?.url);
    console.log('\n── Base64 mit data:-Kopf ──────────────────────────────');
    say('Antwort 200', withHeader.status === 200);
    say('kein doppelter Kopf', (headerUrl.match(/data:/g) || []).length === 1, headerUrl);
    say('Typ aus dem Kopf übernommen', headerUrl === 'data:image/png;base64,QUJD');

    /* ── 4) ZWEI GLEICHE POSITIONEN in EINEM Durchgang ───────────────────── */
    nextLines = ['10\tART-9\tVerschraubung\t2\t12.50', '11\tART-9\tVerschraubung\t2\t12.50'];
    nextRows = [
        { sourceLine: '10  ART-9  Verschraubung  2  12.50', code: 'ART-9', name: 'Verschraubung', quantity: 2, priceGross: 12.5 },
        { sourceLine: '11  ART-9  Verschraubung  2  12.50', code: 'ART-9', name: 'Verschraubung', quantity: 2, priceGross: 12.5 },
    ];
    const twins = await call({ ...base, data: 'QUJD', fileName: 'beleg.jpg', mimeType: 'image/jpeg' });
    console.log('\n── Zwei gleiche Zeilen, ein Durchgang ─────────────────');
    say('beide bleiben stehen (nichts rutscht herauf)', twins.payload?.rows?.length === 2,
        `${twins.payload?.rows?.length} Position(en)`);

    /* ── 5) TABELLE: der Textweg bleibt, wie er war ──────────────────────── */
    nextRows = [{ sourceLine: 'ART-2 Ventil 3 9.90', code: 'ART-2', name: 'Ventil', quantity: 3, priceGross: 9.9 }];
    const sheet = await call({ ...base, text: 'ART-2\tVentil\t3\t9.90', fileName: 'preise.xlsx' });
    const sheetContent = mappingCall()?.messages?.[1]?.content;
    console.log('\n── Tabelle (Textweg) ──────────────────────────────────');
    say('Antwort 200', sheet.status === 200);
    say('engine = client-text', sheet.payload?.engine === 'client-text', String(sheet.payload?.engine));
    say('kein Bild im Aufruf', typeof sheetContent === 'string');
    say('Textzähler gefüllt', Number(sheet.payload?.text?.chars) > 0, `${sheet.payload?.text?.chars} Zeichen`);

    /* ── 6) EIN PDF nimmt weiterhin den Textweg ──────────────────────────── */
    const pdf = await call({ ...base, data: 'JVBERi0=', fileName: 'beleg.pdf', mimeType: 'application/pdf' });
    console.log('\n── PDF ────────────────────────────────────────────────');
    say('geht NICHT als Bild (Textlage wird gelesen)', pdf.payload?.engine !== 'gpt-vision',
        `status ${pdf.status}, ${pdf.payload?.code ?? pdf.payload?.engine}`);

    console.log(`\n${failed === 0 ? 'Alles wie verlangt.' : `${failed} Prüfung(en) fehlgeschlagen.`}`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
