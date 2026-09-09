import 'dotenv/config';

/* ── PRÜFUNG: DIE ANZAHL MUSS STIMMEN (Fehlerbild Samet 08.09.2026) ─────────
   «Ich habe eine Aufnahme mit 35 Zeilen geschickt, es hat nicht geklappt — die
    Zeilen passten nicht zusammen, es stimmte nicht einmal die Anzahl. Der
    Typenbezeichner ist nicht nur ein Code, er kann Buchstaben tragen oder
    sogar eine lange Adresse sein, und es koennen leere Zellen oder Zeilen
    dabei sein, die trotzdem mit muessen. Es koennen auch Dezimalwerte
    vorkommen. Ich habe die Laenge angegeben, es hat die Angaben trotzdem nicht
    richtig geholt. Ich will die genaue Uebereinstimmung: steht dort ‹TeSys
    Deca contactor …›, dann muss genau das dastehen — kein ‹D› statt ‹Deca›.»

   Geprueft wird die ganze Kette, ohne einen Rappen bei OpenAI: `fetch` wird
   abgefangen, die Anfrage festgehalten und mit einer gestellten Antwort
   beantwortet.

   Aufruf: npx ts-node scratchpad/_verify-beleg-exact-rows.ts */

process.env.gptApi = process.env.gptApi || 'sk-test-key-not-used';

const calls: any[] = [];
let nextRows: any[] = [];
/** Die Zeilen, die die ERSTE Stufe (die Abschrift) zurueckgibt. */
let nextLines: string[] = [];

const answer = (content: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
});

/* Ein Bild geht jetzt ZWEIMAL an die Schnittstelle: erst abschreiben, dann
   zuordnen. Woran der Aufruf zu erkennen ist: die Abschrift verlangt das
   Schema `document_table`. */
(global as any).fetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const isTranscribe = body?.response_format?.json_schema?.name === 'document_table';
    return answer(isTranscribe
        ? { header: 'Code\tBezeichnung\tMenge\tBrutto', lines: nextLines }
        : {
            supplierName: 'Muster AG', documentNumber: 'A-1', documentDate: '2026-09-08',
            currency: 'CHF', vatRate: 8.1, totalNet: 100, rows: nextRows,
        }) as any;
};

/** Der Aufruf der ZUORDNUNG — der zweite, der die Positionen liefert. */
const mappingCall = () => calls.find((c) => c?.response_format?.json_schema?.name === 'supplier_document');
/** Der Aufruf der ABSCHRIFT — der erste. */
const transcribeCall = () => calls.find((c) => c?.response_format?.json_schema?.name === 'document_table');

import { purchaseOrderImportRouter } from '../src/presentation/routes/purchaseOrderImport.routes';

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
const photo = { language: 'de', columns, withTiers: false, data: 'QUJD', fileName: 'beleg.jpg', mimeType: 'image/jpeg' };

let failed = 0;
const say = (label: string, ok: boolean, extra = '') => {
    if (!ok) failed += 1;
    console.log(`${ok ? '  OK ' : '  -- '} ${label}${extra ? ` — ${extra}` : ''}`);
};

/** Die volle Bezeichnung, an der sich das Abkuerzen zeigen wuerde. */
const LONG_NAME = 'TeSys Deca contactor - 3P(3 NO) - AC-3 - <= 440 V 9 A - 24 V DC coil';
/** Ein Bezeichner, der kein Code ist. */
const URL_CODE = 'https://www.se.com/ww/en/product/LC1D09BD/tesys-deca-contactor-3p-3-no-ac-3-440-v-9-a-24-v-dc-coil/';

(async () => {
    /* ── 1) 35 ZEILEN HINEIN, 35 ZEILEN HERAUS ──────────────────────────── */
    nextLines = Array.from({ length: 35 }, (_, index) => `${index + 1}\tLC1D09BD\t${LONG_NAME}\t1\t78.10`);
    nextRows = Array.from({ length: 35 }, (_, index) => ({
        sourceLine: `${index + 1}  LC1D09BD  ${LONG_NAME}  1  78.10`,
        code: 'LC1D09BD', name: LONG_NAME, quantity: 1, priceGross: 78.1,
    }));
    const full = await call(photo);

    console.log('\n── 35 Zeilen ──────────────────────────────────────────');
    say('Antwort 200', full.status === 200, `status ${full.status}`);
    say('35 Positionen kommen an', full.payload?.rows?.length === 35, `${full.payload?.rows?.length}`);
    say('nichts fiel weg', full.payload?.rowCount?.dropped === 0, `${full.payload?.rowCount?.dropped}`);
    say('die Abschrift zaehlt 35 Zeilen', full.payload?.rowCount?.table === 35, `${full.payload?.rowCount?.table}`);
    say('die Abschrift reist zum Nachsehen mit', full.payload?.transcript?.lines?.length === 35,
        `${full.payload?.transcript?.lines?.length} Zeilen`);
    say('returned === rows.length', full.payload?.rowCount?.returned === full.payload?.rows?.length);
    say('die Bezeichnung bleibt ungekuerzt', full.payload?.rows?.[0]?.name === LONG_NAME,
        String(full.payload?.rows?.[0]?.name).slice(0, 40));

    /* ── 2) ZWEI STUFEN: ERST ABSCHREIBEN, DANN ZUORDNEN ─────────────────── */
    const first = calls[0];
    const second = calls[1];
    const firstContent = first?.messages?.[1]?.content;
    const imagePart = Array.isArray(firstContent)
        ? firstContent.find((part: any) => part.type === 'image_url')
        : null;

    console.log('\n── Erst umwandeln, dann an das Modell ─────────────────');
    say('genau ZWEI Aufrufe', calls.length === 2, `${calls.length}`);
    say('der ERSTE ist die Abschrift', first?.response_format?.json_schema?.name === 'document_table',
        String(first?.response_format?.json_schema?.name));
    say('  → nur er bekommt das Bild', Boolean(imagePart));
    say('  → er soll NUR abschreiben', /You do NOT interpret it/.test(String(first?.messages?.[0]?.content || '')));
    say('  → Tabulator trennt die Zellen', /separate the cells with a TAB/.test(String(first?.messages?.[0]?.content || '')));
    say('  → leere Zelle bleibt leer', /A cell that is empty on the page stays empty/.test(String(first?.messages?.[0]?.content || '')));
    say('der ZWEITE ist die Zuordnung', second?.response_format?.json_schema?.name === 'supplier_document',
        String(second?.response_format?.json_schema?.name));
    say('  → er bekommt KEIN Bild mehr, nur Text',
        typeof second?.messages?.[1]?.content === 'string', typeof second?.messages?.[1]?.content);
    say('  → er bekommt die abgeschriebene Tabelle',
        String(second?.messages?.[1]?.content || '').includes(LONG_NAME));
    say('  → mit der Kopfzeile davor',
        String(second?.messages?.[1]?.content || '').startsWith('Code\tBezeichnung'));

    console.log('\n── «35» gibt es nicht mehr ────────────────────────────');
    const allPrompts = calls.map((c) => String(c?.messages?.[0]?.content || '')).join(' ');
    say('keine angesagte Zeilenzahl in der Anweisung', !/counted \d+ position rows/.test(allPrompts));
    say('kein "Return exactly N entries"', !/Return exactly \d+ entries/.test(allPrompts));
    say('kein printedRowCount im Schema',
        !JSON.stringify(second?.response_format?.json_schema?.schema ?? {}).includes('printedRowCount'));

    /* ── 3) LEERE ZELLEN, LEERE ZEILEN ──────────────────────────────────── */
    nextLines = ['1', '2', '3', '4', '5'];
    nextRows = [
        { sourceLine: '1  LC1D09BD  Schuetz  1  78.10', code: 'LC1D09BD', name: 'Schuetz', quantity: 1, priceGross: 78.1 },
        // Zeile mit LEEREN Zellen — sie stand auf dem Beleg und muss mit.
        { sourceLine: '2  ohne Zuordnung gedruckt', code: null, name: null, quantity: null, priceGross: null },
        // Menge 0 ist ein WERT, keine Leere.
        { sourceLine: '3  LC1D12BD  Schuetz gross  0  92.40', code: 'LC1D12BD', name: 'Schuetz gross', quantity: 0, priceGross: 92.4 },
        // Nur die Bezeichnung, sonst nichts.
        { sourceLine: null, code: null, name: 'Nachtrag laut Beilage', quantity: null, priceGross: null },
        // Diese eine ist wirklich leer und darf fallen.
        { sourceLine: null, code: null, name: null, quantity: null, priceGross: null },
    ];
    const sparse = await call(photo);
    const names = (sparse.payload?.rows || []).map((row: any) => row.sourceLine ?? row.name ?? '(leer)');

    console.log('\n── Leere Zellen und leere Zeilen ──────────────────────');
    say('4 von 5 bleiben stehen', sparse.payload?.rows?.length === 4, `${sparse.payload?.rows?.length}: ${names.join(' | ')}`);
    say('die Zeile ohne Zuordnung bleibt', names.some((value: string) => String(value).includes('ohne Zuordnung')));
    say('Menge 0 bleibt eine Position', names.some((value: string) => String(value).includes('LC1D12BD')));
    say('die wirklich leere Zeile faellt', sparse.payload?.rowCount?.dropped === 1, `${sparse.payload?.rowCount?.dropped}`);
    say('die Reihenfolge bleibt', String(names[0]).startsWith('1  ') && String(names[1]).startsWith('2  '));

    /* ── 4) DER BEZEICHNER IST NICHT NUR EIN CODE ───────────────────────── */
    nextLines = ['A', 'B'];
    nextRows = [
        { sourceLine: `A  ${URL_CODE}  ${LONG_NAME}  2  78.105`, code: URL_CODE, name: LONG_NAME, quantity: 2, priceGross: 78.105 },
        { sourceLine: 'B  XB4-BA31/2.5  Drucktaster  1  0.125', code: 'XB4-BA31/2.5', name: 'Drucktaster', quantity: 1, priceGross: 0.125 },
    ];
    const codes = await call(photo);
    console.log('\n── Bezeichner und Dezimalwerte ────────────────────────');
    say('die volle Adresse bleibt stehen', codes.payload?.rows?.[0]?.code === URL_CODE,
        String(codes.payload?.rows?.[0]?.code).slice(0, 44) + '…');
    say('Buchstaben, Schraegstrich und Punkt bleiben', codes.payload?.rows?.[1]?.code === 'XB4-BA31/2.5',
        String(codes.payload?.rows?.[1]?.code));
    say('drei Nachkommastellen bleiben', codes.payload?.rows?.[0]?.priceGross === 78.105);
    say('0.125 bleibt 0.125', codes.payload?.rows?.[1]?.priceGross === 0.125);

    /* ── 5) DIE ANWEISUNG SELBST ────────────────────────────────────────── */
    const rules = String(mappingCall()?.messages?.[0]?.content || '');
    const schema = mappingCall()?.response_format?.json_schema?.schema;
    const headKeys: string[] = schema?.required || [];
    console.log('\n── Anweisung und Schema ───────────────────────────────');
    say('abschreiben, nicht uebersetzen', /is a TRANSCRIPTION of what is printed, not a translation/.test(rules));
    say('nichts abkuerzen', /Never translate, abbreviate, expand, shorten, summarise, correct or tidy/.test(rules));
    say('das Beispiel des Anwenders steht drin', rules.includes('TeSys Deca contactor'));
    say('KEIN Auftrag mehr, Namen zu uebersetzen', !/translate names that are in another language/.test(rules));
    say('ein Bezeichner darf eine Adresse sein', /or be a complete URL/.test(rules));
    say('Nachkommastellen bleiben', /Keep every decimal place that is printed/.test(rules));
    /* Gezaehlt und angesagt wird nichts mehr — die Abschrift gibt die Zahl
       vor, und die Zuordnung muss ihr folgen. */
    say('eine Zeile der Tabelle = ein Eintrag',
        /Return one entry per line of the table - no more, no fewer/.test(rules));
    say('eine leere Zeile ist eine Zeile', /an empty row is still a row/.test(rules));
    say('nicht zusammenfassen, nicht auslassen', /Never merge two printed rows into one entry/.test(rules));
    say('die letzte Zeile zaehlt auch', /do not stop before you reach it/.test(rules));
    say('nur ausserhalb der Tabelle wird weggelassen', /Leave out only what is printed OUTSIDE the position table/.test(rules));
    say('kein Freibrief mehr zum Aussortieren', !/Skip totals, subtotals, delivery terms, headers and footers/.test(rules));
    say('kein printedRowCount mehr im Kopf', !headKeys.includes('printedRowCount'), headKeys.join(', '));
    say('Ausgabegrenze gesetzt', Number(mappingCall()?.max_tokens) >= 16384, String(mappingCall()?.max_tokens));

    /* ── 6) DIE ALTEN ZUSAGEN GELTEN WEITER ─────────────────────────────── */
    nextLines = ['10', '11'];
    nextRows = [
        { sourceLine: '10  ART-9  Verschraubung  2  12.50', code: 'ART-9', name: 'Verschraubung', quantity: 2, priceGross: 12.5 },
        { sourceLine: '11  ART-9  Verschraubung  2  12.50', code: 'ART-9', name: 'Verschraubung', quantity: 2, priceGross: 12.5 },
    ];
    const twins = await call(photo);
    console.log('\n── Was schon galt ─────────────────────────────────────');
    say('zwei gleiche Zeilen bleiben zwei', twins.payload?.rows?.length === 2, `${twins.payload?.rows?.length}`);
    say('engine bleibt gpt-vision', twins.payload?.engine === 'gpt-vision');
    say('der Zeilenanker steht weiter im Schema (Abschrift + Anker)',
        Boolean(transcribeCall()) && Boolean(mappingCall()));
    say('sourceLine bleibt die erste Eigenschaft',
        Object.keys(mappingCall()?.response_format?.json_schema?.schema?.properties?.rows?.items?.properties || {})[0] === 'sourceLine');

    console.log(`\n${failed === 0 ? 'Alles wie verlangt.' : `${failed} Prüfung(en) fehlgeschlagen.`}`);
    process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
