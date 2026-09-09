/**
 * PROBE DES BELEG-IMPORTS (07.09.2026) — ohne einen Rappen bei OpenAI.
 *
 * Geprüft wird die ganze Kette, nur mit einem NACHGEBAUTEN Modell:
 *   1. `compactText`  — staucht der Reiniger, ohne Zahlen zu verlieren?
 *   2. `chunkText`    — schneidet er an Zeilengrenzen mit Überlappung?
 *   3. `readDocumentText` — liest er eine Tabelle (Text) und ein echtes PDF?
 *   4. `extractWithGpt`   — schickt er das richtige Schema und liest er die
 *      Antwort? Dafür läuft hier ein winziger Server, der sich als OpenAI
 *      ausgibt; `gptEndpoint` zeigt auf ihn.
 *
 * Aufruf: npx ts-node scratchpad/_ai-import-e2e.ts
 */

import http from 'http';
import fs from 'fs';
import path from 'path';

/* Die Schlüssel und die Adresse werden bei jedem AUFRUF aus der Umgebung
   gelesen, nicht beim Laden — darum dürfen die Module oben stehen. */
import { compactText, chunkText, readDocumentText, approxTokens } from '../src/infrastructure/services/documentText';
import { extractWithGpt, gptConfigured, normalizeColumns } from '../src/infrastructure/services/gptExtract';

const results: string[] = [];
const ok = (label: string, condition: boolean, extra = '') => {
    results.push(`${condition ? 'OK  ' : 'FEHL'} ${label}${extra ? ` — ${extra}` : ''}`);
    if (!condition) process.exitCode = 1;
};

const main = async () => {
    /* ── Der nachgebaute OpenAI-Server ──────────────────────────────────── */
    let lastBody: any = null;
    const fake = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            lastBody = JSON.parse(raw);
            const answer = {
                supplierName: 'Muster Handels AG',
                documentNumber: 'AN-2026-4711',
                documentDate: '2026-09-01',
                currency: 'CHF',
                vatRate: 8.1,
                totalNet: 1234.5,
                rows: [
                    { articleCode: 'A-100', name: 'Schraube M6', quantity: 100, unit: 'Stk', grossPrice: 0.9, netPrice: 0.72, discount: 20, lineTotal: 72, priceTiers: [{ minQuantity: 1, unitPrice: 0.9 }, { minQuantity: 50, unitPrice: 0.72 }, { minQuantity: 500, unitPrice: 0.6 }] },
                    { articleCode: 'A-200', name: 'Mutter M6', quantity: 100, unit: 'Stk', grossPrice: 0.4, netPrice: 0.32, discount: 20, lineTotal: 32, priceTiers: null },
                ],
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }],
                usage: { prompt_tokens: 1800, completion_tokens: 420, total_tokens: 2220 },
            }));
        });
    });
    await new Promise<void>((resolve) => fake.listen(4599, '127.0.0.1', resolve));

    process.env.gptApi = 'sk-test-nur-fuer-die-probe';
    process.env.gptModel = 'gpt-4o-mini';
    process.env.gptEndpoint = 'http://127.0.0.1:4599/v1/chat/completions';


    /* ── 1) Stauchen ────────────────────────────────────────────────────── */
    const messy = [
        'Muster Handels AG', 'Bahnhofstrasse 1', '',
        'Pos   Artikel ............... Menge     Preis',
        '1     A-100  Schraube M6        100      0.90',
        '',
        'Seite 1 von 3',
        '=========================',
        'Muster Handels AG', 'Bahnhofstrasse 1',
        '2     A-200  Mutter M6          100      0.40',
        'Seite 2 von 3',
        'Muster Handels AG', 'Bahnhofstrasse 1',
        '3     A-300  Scheibe M6         100      0.15',
        'Seite 3 von 3',
    ].join('\n');
    const compact = compactText(messy);
    ok('Stauchen: Kopfzeile nur einmal', (compact.match(/Muster Handels AG/g) || []).length === 1,
        `${(compact.match(/Muster Handels AG/g) || []).length}x`);
    ok('Stauchen: «Seite n von m» weg', !/Seite \d/.test(compact));
    ok('Stauchen: Punktführung weg', !compact.includes('.....'));
    ok('Stauchen: alle drei Preise da', ['0.90', '0.40', '0.15'].every((price) => compact.includes(price)));
    ok('Stauchen: alle drei Artikel da', ['A-100', 'A-200', 'A-300'].every((code) => compact.includes(code)));
    ok('Stauchen spart Zeichen', compact.length < messy.length, `${messy.length} → ${compact.length}`);

    /* ── 2) Schneiden ───────────────────────────────────────────────────── */
    const long = Array.from({ length: 400 }, (_, index) => `Zeile ${index} mit etwas Text und einem Preis 12.${index % 100}`).join('\n');
    const chunks = chunkText(long, 2000);
    ok('Schneiden: mehrere Stücke', chunks.length > 1, `${chunks.length} Stücke`);
    ok('Schneiden: jedes Stück passt', chunks.every((chunk) => chunk.length <= 2000 + 200));
    ok('Schneiden: Überlappung vorhanden', (() => {
        const first = chunks[0] ?? '';
        const second = chunks[1] ?? '';
        const lastOfFirst = first.split('\n').slice(-1)[0] ?? '';
        return Boolean(lastOfFirst) && second.split('\n').includes(lastOfFirst);
    })());
    ok('Schneiden: keine Zeile verloren', (() => {
        const seen = new Set(chunks.flatMap((chunk) => chunk.split('\n')));
        return long.split('\n').every((line) => seen.has(line));
    })());

    /* ── 3) Beleg → Text ────────────────────────────────────────────────── */
    const sheet = await readDocumentText({ text: 'Artikel\tMenge\tPreis\nA-100\t100\t0.90' });
    ok('Tabelle: Quelle text', sheet.source === 'text' && sheet.engine === 'client-text');
    ok('Tabelle: Inhalt erhalten', sheet.text.includes('A-100') && sheet.text.includes('0.90'));

    const pdfDir = path.join(__dirname, '..', 'storage', 'appointment-documents');
    const findPdf = (dir: string): string | null => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const found = findPdf(full);
                if (found) return found;
            } else if (entry.name.endsWith('.pdf')) return full;
        }
        return null;
    };
    const pdfPath = fs.existsSync(pdfDir) ? findPdf(pdfDir) : null;
    if (pdfPath) {
        try {
            const read = await readDocumentText({ data: fs.readFileSync(pdfPath).toString('base64'), fileName: 'probe.pdf' });
            ok('PDF: Textlage gelesen', read.source === 'pdf' && read.text.length > 40,
                `${read.rawChars} → ${read.chars} Zeichen, ~${approxTokens(read.chars)} Token`);
        } catch (error: any) {
            // Ein Scan ohne Textlage ist ein GÜLTIGES Ergebnis dieser Probe.
            ok('PDF: sauberer Fehler statt Müll', error?.code === 'PDF_NO_TEXT_LAYER', error?.code);
        }
    } else {
        results.push('--   PDF: keine Probedatei gefunden, übersprungen');
    }

    /* ── 4) Das Modell ──────────────────────────────────────────────────── */
    ok('Schlüssel erkannt', gptConfigured());

    const columns = [
        { key: 'c1', name: 'Artikel-Nr.', type: 'text' as const },
        { key: 'c2', name: 'Bezeichnung', type: 'text' as const },
        { key: 'c3', name: 'Menge', type: 'number' as const },
        { key: 'c4', name: 'Einheit', type: 'text' as const },
        { key: 'c5', name: 'Listenpreis', type: 'number' as const },
        { key: 'c6', name: 'Nettopreis', type: 'number' as const },
        { key: 'c7', name: 'Rabatt %', type: 'number' as const },
        { key: 'c8', name: 'Betrag', type: 'number' as const },
    ];
    const extracted = await extractWithGpt({
        text: compact,
        columns,
        language: 'de',
        withTiers: true,
    });

    const schema = lastBody?.response_format?.json_schema?.schema;
    const rowProps = schema?.properties?.rows?.items?.properties ?? {};
    ok('Anfrage: json_schema strikt', lastBody?.response_format?.json_schema?.strict === true);
    ok('Anfrage: Modell aus der Umgebung', lastBody?.model === 'gpt-4o-mini', lastBody?.model);
    ok('Anfrage: temperature 0', lastBody?.temperature === 0);
    /* Der Zeilenanker gehoert seit dem 08.09.2026 dazu und steht VORNE
       (siehe `SOURCE_LINE_FIELD`): erst die gedruckte Zeile abschreiben,
       dann in Spalten zerlegen. Geprueft wird weiterhin, dass sonst
       NICHTS im Zeilenschema steht. */
    ok('Anfrage: nur Anker, Vorlagenspalten und Staffel',
        Object.keys(rowProps).sort().join(',')
            === ['sourceLine', ...columns.map((c) => c.key), 'priceTiers'].sort().join(','),
        Object.keys(rowProps).join(','));
    ok('Anfrage: der Spaltenname reist als Beschreibung mit',
        String((rowProps as any).c5?.description || '').includes('Listenpreis'),
        String((rowProps as any).c5?.description || ''));
    ok('Anfrage: jede Spalte ist Pflicht (strict)',
        (schema?.properties?.rows?.items?.required ?? []).length === Object.keys(rowProps).length);
    ok('Anfrage: jede Spalte darf null sein',
        Object.values(rowProps).every((entry: any) => Array.isArray(entry.type) && entry.type.includes('null')));
    ok('Anfrage: Zielsprache steht im Prompt',
        String(lastBody?.messages?.[0]?.content ?? '').includes('German'));
    ok('Anfrage: der Belegtext reist als Benutzernachricht',
        String(lastBody?.messages?.[1]?.content ?? '').includes('A-100'));
    /* ── WAS DIE ANWEISUNG KOSTEN DARF ───────────────────────────────
       700 Zeichen waren der Stand vom 07.09.2026, als die Anweisung noch
       aus zehn Saetzen bestand. Seither traegt sie die Zeilenregel
       (08.09.2026), das durchgerechnete Preisbeispiel und die Vorgabe,
       WOERTLICH abzuschreiben statt zu uebersetzen — zusammen rund 3'800
       Zeichen, also etwa 950 Eingabe-Token. Das sind bei gpt-4o-mini
       0.00014 $ je Beleg und damit weniger, als eine einzige falsch
       gelesene Position kostet.

       Die Grenze bleibt trotzdem stehen, nur auf der Hoehe, die der Sache
       entspricht: sie soll ein Abgleiten ins Uferlose melden, nicht jede
       Regel, die sich als noetig erwiesen hat. */
    ok('Anfrage: Anweisung bleibt im Rahmen (< 5000 Zeichen)',
        String(lastBody?.messages?.[0]?.content ?? '').length < 5000,
        `${String(lastBody?.messages?.[0]?.content ?? '').length} Zeichen`);

    ok('Antwort: Kopfdaten gelesen', extracted.supplierName === 'Muster Handels AG' && extracted.currency === 'CHF');
    ok('Antwort: zwei Positionen', extracted.rows.length === 2);
    ok('Antwort: Staffel durchgereicht', Array.isArray((extracted.rows[0] as any).priceTiers)
        && (extracted.rows[0] as any).priceTiers.length === 3);
    ok('Antwort: Tokennutzung übernommen', extracted.usage.totalTokens === 2220);
    ok('Antwort: Kosten geschätzt', extracted.usage.estimatedUsd !== null
        && Math.abs(extracted.usage.estimatedUsd! - ((1800 * 0.15 + 420 * 0.6) / 1e6)) < 1e-9,
        `$${extracted.usage.estimatedUsd}`);

    /* ── Nur bekannte Spalten dürfen ins Schema ─────────────────────────── */
    await extractWithGpt({
        text: 'x',
        columns: [
            { key: 'c1', name: 'A', type: 'text' as const },
            { key: 'c2', name: 'B', type: 'text' as const },
            { key: 'c3', name: 'C', type: 'number' as const },
            { key: 'c4', name: 'D', type: 'number' as const },
            // Kein gueltiger Bezeichner: er faengt mit einer Ziffer an.
            { key: '1bad', name: 'Erfunden', type: 'text' as const },
            // Ein Bindestrich ist ebenfalls keiner.
            { key: 'has-dash', name: 'Auch erfunden', type: 'text' as const },
        ],
        language: 'tr',
        withTiers: false,
    });
    const secondProps = Object.keys(lastBody?.response_format?.json_schema?.schema?.properties?.rows?.items?.properties ?? {});
    /* Der Zeilenanker steht seit dem 08.09.2026 als ERSTE Eigenschaft vor
       den Spalten (siehe `SOURCE_LINE_FIELD`) — die Pruefung galt bis dahin
       der blossen Spaltenliste und war seither dauerhaft rot. Geprueft wird,
       worum es ging: dass `1bad` und `has-dash` draussen bleiben. */
    ok('Ungueltiger Spaltenschluessel wird verworfen', secondProps.join(',') === 'sourceLine,c1,c2,c3,c4', secondProps.join(','));
    ok('camelCase ist ein gueltiger Schluessel (Preise!)',
        normalizeColumns([{ key: 'priceGross', name: 'Einzelpreis' }, { key: 'priceNet', name: 'Nettopreis' }]).length === 2);
    ok('Türkisch kommt im Prompt an', String(lastBody?.messages?.[0]?.content ?? '').includes('Turkish'));
    ok('Zu wenige Spalten werden abgewiesen', await (async () => {
        try {
            await extractWithGpt({ text: 'x', columns: [{ key: 'c1', name: 'A', type: 'text' as const }], language: 'de', withTiers: false });
            return false;
        } catch (error: any) {
            return error?.code === 'GPT_TOO_FEW_COLUMNS';
        }
    })());
    ok('Spaltenprüfung wirft Doppelte hinaus',
        normalizeColumns([{ key: 'c1', name: 'A' }, { key: 'c1', name: 'B' }, { key: 'c2', name: '' }]).length === 1);

    fake.close();
    console.log(results.join('\n'));
    console.log(results.some((line) => line.startsWith('FEHL')) ? '\n>>> ES GIBT FEHLER' : '\n>>> alles gruen');
};

main().catch((error) => {
    console.error('Probe abgebrochen:', error);
    process.exit(1);
});
