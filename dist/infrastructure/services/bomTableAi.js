"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fillTableWithAi = exports.bomTableModel = exports.TableAiError = exports.TABLE_AI_LABELS = void 0;
const gptExtract_1 = require("./gptExtract");
const documentText_1 = require("./documentText");
exports.TABLE_AI_LABELS = ['grossPrice', 'netPrice', 'discount', 'discount2', 'total'];
class TableAiError extends Error {
    code;
    status;
    constructor(message, code, status) {
        super(message);
        this.code = code;
        this.status = status;
    }
}
exports.TableAiError = TableAiError;
/**
 * ── DAS MODELL DER BOM-TABELLE (27.09.2026 abends, Vorgabe Samet) ─────────────
 * «Yapay zekâda bir tık üst model kullanılabilir … almanca olan ya da farklı
 *  dilde olan pdf'lerinden satır olan akıllı bir karar vermesi gerekmekte …
 *  daha üst bir ChatGPT API kullanalım.» Die BOM-Tabelle bekommt ein EIGENES,
 * stärkeres Modell (`gptBomModel`, Vorgabe unten) — die übrigen Belegwege
 * (Beleg-Import, Wareneingang) behalten `gptModel`. Ein denkendes Modell
 * überlegt mit `gptBomReasoningEffort` (Vorgabe medium), bevor es zuordnet.
 * Gewählt nach einem Vergleich auf einem deutschen Angebot (Namen in anderer
 * Sprache, Preis je 100, Blöcke über mehrere Zeilen, fremde und fehlende Zeilen).
 */
const DEFAULT_BOM_MODEL = 'gpt-5.4-mini';
const bomTableModel = () => String(process.env.gptBomModel ?? process.env.GPT_BOM_MODEL ?? DEFAULT_BOM_MODEL).trim() || DEFAULT_BOM_MODEL;
exports.bomTableModel = bomTableModel;
const BOM_REASONING_EFFORT = () => String(process.env.gptBomReasoningEffort ?? 'medium').trim() || 'medium';
const MAX_VALUE = 240;
const MAX_EVIDENCE = 300;
/** So viel Text der Quelle geht höchstens an das Modell (~25'000 Token). */
const MAX_SOURCE_CHARS = 100_000;
/* ── Was die festen Spalten bedeuten ─────────────────────────────────────── */
const ROLE = {
    grossPrice: 'unit price BEFORE discount: the price of ONE unit as the supplier states it (list price / unit price)',
    netPrice: 'unit price AFTER discount: only when the supplier states a net or discounted unit price',
    discount: 'discount percentage for this article, written as a positive number',
    discount2: 'second discount percentage (applied after the first), written as a positive number',
    total: 'amount of the whole line (quantity x price) exactly as the supplier prints it',
};
const columnMeaning = (column) => (column.label
    ? ROLE[column.label]
    : `free column: the value the supplier states for this article under this meaning${column.type === 'number' ? ' (a number)' : ''}`);
const SYSTEM_PROMPT = [
    'You fill the EMPTY cells of an existing purchase order with information from the supplier:',
    'a quotation, price list or order confirmation - as lines the user typed or pasted, a spreadsheet, the text layer of a PDF,',
    'or a photo that was transcribed into a table.',
    'The order rows are FIXED. You never add, remove, merge, split or reorder rows; you only return values for the requested columns.',
    'STEP 1 - MATCH. For EVERY order row find the one line of the supplier information that means the SAME article.',
    'Compare the manufacturer part/model number first, ignoring spaces, dots, dashes, slashes and letter case.',
    'Otherwise compare the product names. They are usually SIMILAR, not identical: another language, abbreviations,',
    'another word order, extra or missing words, the manufacturer written in front or behind. Match on meaning: type, size, rating, variant.',
    'Our ERP code is internal and is usually not printed by the supplier.',
    'The quantity may help to decide between two candidates, but a different quantity alone does not break a match.',
    'A supplier line belongs to at most one order row. When no line fits an order row, that row stays unmatched - never force a match.',
    'The user may paste two separate lists - first the names, then the values (for example the prices) in the same order:',
    'then the n-th value belongs to the n-th name. A plain list of values without names that has exactly as many lines as the order',
    'belongs to the order rows in their given order.',
    'STEP 2 - FILL. For every matched row copy into each requested column the value the supplier states for that article in the column,',
    'or with the words, that mean the same thing. The requested column name may be worded differently from the printed header:',
    '"Einzelpreis", "Birim fiyat", "Unit price", "Stückpreis" and "Preis/Stk." are the same; so are "Lieferzeit", "Teslim süresi" and "Delivery time".',
    'A value is a TRANSCRIPTION of what is printed: copy it character for character. Never translate, round, convert or compute it,',
    'and never add a unit or a currency to a number.',
    'When the supplier information does not state a value for this article and this column, the value is "" (empty).',
    'Never guess, never compute a missing value, and never take a value from a neighbouring line or from another article.',
    'For an unmatched row every value is "".',
    'A requested column that asks for exactly one of OUR row\'s own fields - the manufacturer, the manufacturer part/model number or the unit -',
    'may be taken from our row when the supplier information does not print it.',
    'PRICES. The unit-price column takes the price of ONE unit before discount. When the supplier states only one unit price and no discount,',
    'it goes into the unit-price column; only when the order has no unit-price column does it go into the net-price column.',
    'The net-price column takes a unit price AFTER discount only when the supplier states one.',
    'The line-total column takes the printed amount of the whole line - never multiply yourself.',
    'A discount is a percentage, written as a positive number even when it is printed with a minus sign.',
    'When a price is printed both with and without VAT, take the one without VAT.',
    'LANGUAGES. The supplier information may be written in any language (German, English, Turkish, French, Italian ...) and use trade terms,',
    'while our rows may be in another language. Compare the MEANING across languages, for example: "Schütz" = contactor = kontaktör;',
    '"Leitungsschutzschalter", "LS-Schalter", "MCB" = miniature circuit breaker = otomatik sigorta; "Reihenklemme", "Durchgangsklemme" = terminal block = klemens;',
    '"Mantelleitung", "Leitung", "Kabel" = cable = kablo; "Schaltschrank", "Kompaktgehäuse", "Gehäuse" = enclosure = pano; "Stk.", "St.", "Stück" = pcs = adet.',
    'ARTICLE NUMBERS. Supplier article / order numbers ("Art.-Nr.", "Bestell-Nr.", "Artikelnummer", "Typ", "Order no.", "Ürün kodu") usually equal',
    'our manufacturer part/model number or contain it; such a number match beats any name similarity.',
    'BLOCKS. In a PDF one article often spans several lines: a position number, an article number, a description over two or three lines,',
    'then quantity, unit and prices. Treat such a block as ONE supplier line and read its values from the whole block.',
    'Lines that are not articles - freight, packaging, "Versand", "Fracht", "Porto", "Verpackung", "Mindermengenzuschlag", sums, VAT - never match an order row.',
    'When two supplier lines could fit, prefer the one whose part number matches, then the one whose quantity and unit match ours.',
    'PRICE UNIT - the only computation you may do: when the supplier prints a price for a price unit other than one',
    '("PE 100", "Preiseinheit 100", "je 100 Stk", "per 100 m", "/100", "pro 1000"), the unit-price and net-price columns must hold the price of ONE unit',
    'of our row: divide the printed price by that price unit and write the result as a plain number with a dot and up to 4 decimals,',
    'and name the price unit in "evidence". Tiered prices ("Staffelpreise", "ab 10 Stk"): take the tier that fits the quantity of our row.',
    'In "evidence" copy the supplier line you matched, verbatim and complete (for two paired lists: the name and its value); "" when the row is unmatched.',
    'Text tables: a TAB separates two columns and two TABs in a row mean an empty cell - read every value under its own header.',
    'Return exactly one entry per order row, in the given order, with that row\'s index.',
].join(' ');
const HEADER_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        number: { type: 'string', description: 'The supplier\'s quotation / offer / order-confirmation number printed in the header ("Angebot Nr.", "Angebotsnummer", "Teklif No", "Quote no.", "Offer no."); "" when none is printed' },
        date: { type: 'string', description: 'The date of that document as yyyy-mm-dd; "" when none is printed' },
    },
    required: ['number', 'date'],
};
const buildSchema = (columns, header = false) => ({
    type: 'object',
    additionalProperties: false,
    properties: {
        ...(header ? { document: HEADER_SCHEMA } : {}),
        rows: {
            type: 'array',
            description: 'Exactly one entry per order row, in the given order',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    index: { type: 'integer', description: 'The index (#) of the order row' },
                    evidence: { type: 'string', description: 'The matched supplier line, copied verbatim; "" when no line matches this row' },
                    values: {
                        type: 'object',
                        additionalProperties: false,
                        properties: Object.fromEntries(columns.map((column) => [column.key, {
                                type: 'string',
                                description: `Column "${column.name}" - ${columnMeaning(column)}; "" when the supplier does not state it`,
                            }])),
                        required: columns.map((column) => column.key),
                    },
                },
                required: ['index', 'evidence', 'values'],
            },
        },
    },
    required: header ? ['document', 'rows'] : ['rows'],
});
const oneLine = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const rowsText = (rows) => rows
    .map((row) => [
    `#${row.index}`,
    row.erpCode || '-',
    oneLine(row.name) || '-',
    oneLine(row.brand) || '-',
    oneLine(row.modelNumber) || '-',
    `${row.quantity}${row.unit ? ` ${oneLine(row.unit)}` : ''}`,
].join(' | '))
    .join('\n');
/** Eingetippter Text bleibt, wie er ist — nur Zeilenenden und geschützte Leerzeichen werden vereinheitlicht. */
const plainText = (raw) => raw
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
const stripDataUrl = (value) => (value.includes(',') ? value.slice(value.indexOf(',') + 1) : value);
/** Eine erkannte Zelle ins Format der Spalte bringen: Zahlenspalten als Zahl mit Punkt, Rabatte ohne Vorzeichen. */
const cleanValue = (column, raw) => {
    const text = oneLine(raw).slice(0, MAX_VALUE);
    if (!text || /^[-–—]$/.test(text))
        return '';
    if (!column.label && column.type !== 'number')
        return text;
    const value = (0, gptExtract_1.parsePrintedNumber)(text);
    // Eine Preis- oder Rabattspalte trägt nur eine Zahl; eine freie Zahlenspalte darf «3-4» behalten.
    if (value === null)
        return column.label ? '' : text;
    return String(column.label === 'discount' || column.label === 'discount2' ? Math.abs(value) : value);
};
const sumUsage = (parts) => parts.reduce((total, part) => ({
    promptTokens: total.promptTokens + part.promptTokens,
    completionTokens: total.completionTokens + part.completionTokens,
    totalTokens: total.totalTokens + part.totalTokens,
    estimatedUsd: total.estimatedUsd === null || part.estimatedUsd === null
        ? null
        : Math.round((total.estimatedUsd + part.estimatedUsd) * 1e6) / 1e6,
}), { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedUsd: 0 });
/** Ein abgeschriebenes Raster als Tabulatortext, Kopfzeile zuerst; eine leere Zelle bleibt leer. */
const gridText = (grid) => [
    grid.headers.join('\t'),
    ...grid.rows.map((cells) => cells.map((cell) => cell ?? '').join('\t')),
].join('\n');
const fillTableWithAi = async (input) => {
    if (!(0, gptExtract_1.gptConfigured)())
        throw new TableAiError('Die KI ist nicht eingerichtet.', 'AI_NOT_CONFIGURED', 503);
    if (!input.rows.length)
        throw new TableAiError('Die Bestellung hat keine Zeilen.', 'AI_COLUMNS_REQUIRED', 400);
    if (!input.columns.length)
        throw new TableAiError('Die Vorlage hat keine Spalte, die gefüllt werden kann.', 'AI_COLUMNS_REQUIRED', 400);
    const usages = [];
    const sources = [];
    /* Die Quelle als Text, Abschnitt für Abschnitt; Bilder ohne Tabelle gehen als Bild mit. */
    const sections = [];
    const looseImages = [];
    const prompt = plainText(String(input.prompt ?? ''));
    if (prompt.trim()) {
        sections.push(`=== Typed or pasted by the user ===\n${prompt}`);
        sources.push('prompt');
    }
    const readText = async (read) => {
        try {
            return (await (0, documentText_1.readDocumentText)(read)).text;
        }
        catch (error) {
            if (error instanceof documentText_1.DocumentReadError)
                throw new TableAiError(error.message, 'AI_SOURCE_UNREADABLE', 422);
            throw error;
        }
    };
    if (input.text?.trim()) {
        sections.push(`=== Spreadsheet (a TAB separates two columns, two TABs in a row mean an empty cell) ===\n${await readText({ text: input.text })}`);
        sources.push('sheet');
    }
    if (input.document?.data) {
        const name = input.document.fileName ? ` ${oneLine(input.document.fileName)}` : '';
        const text = await readText({ data: input.document.data, fileName: input.document.fileName, mimeType: input.document.mimeType });
        sections.push(`=== PDF${name} (text layer; a TAB marks a column gap) ===\n${text}`);
        sources.push('pdf');
    }
    if (input.images.length) {
        sources.push('image');
        /* ERST ABSCHREIBEN, DANN ZUORDNEN: das Raster ist spaltentreu (gptExtract.ts,
           gemessen 302/304 Zellen); die Spalten der Vorlage helfen dem ersten Blick,
           die Tabelle zu erkennen. */
        const gridColumns = [
            { key: 'aiItem', name: 'Product / description', type: 'text', label: 'productName' },
            ...input.columns.map((column) => ({ key: column.key, name: column.name, type: column.type, label: column.label })),
        ];
        let pages = [];
        try {
            pages = await (0, gptExtract_1.readImagePages)(input.images, gridColumns, gridColumns.length);
        }
        catch (error) {
            if (!(error instanceof gptExtract_1.GptError))
                throw error;
            throw new TableAiError(error.message, error.code, error.status);
        }
        pages.forEach((page, index) => {
            usages.push(page.usage);
            const label = `Image ${index + 1} of ${input.images.length}`;
            if (page.grid.rows.length) {
                sections.push(`=== ${label}, transcribed as a table (a TAB separates two columns, an empty cell is empty) ===\n${gridText(page.grid)}`);
            }
            else {
                // Keine Tabelle erkannt (Mail, Notiz): das Modell sieht das Bild selbst.
                looseImages.push({ ...input.images[index], label });
            }
        });
    }
    if (!sections.length && !looseImages.length) {
        throw new TableAiError('Zeilen, Bild, Excel oder PDF des Lieferanten fehlen.', 'AI_SOURCE_REQUIRED', 400);
    }
    let sourceText = sections.join('\n\n');
    if (sourceText.length > MAX_SOURCE_CHARS)
        sourceText = sourceText.slice(0, MAX_SOURCE_CHARS);
    const columnList = input.columns
        .map((column) => `- ${column.key}: "${column.name}" = ${columnMeaning(column)}`)
        .join('\n');
    const intro = [
        'Requested columns (fill these):',
        columnList,
        '',
        'Order rows (fixed) - # | our ERP code | name | manufacturer | manufacturer part/model number | quantity and unit:',
        rowsText(input.rows),
        '',
        ...(input.header ? ['Also read the document header: the supplier\'s quotation / offer number and its date (in "document").', ''] : []),
        'Supplier information:',
    ].join('\n');
    const content = [{ type: 'text', text: intro }];
    if (sourceText)
        content.push({ type: 'text', text: sourceText });
    for (const image of looseImages) {
        content.push({ type: 'text', text: `=== ${image.label} (no table found - read it directly) ===` });
        content.push((0, gptExtract_1.imagePart)({ data: stripDataUrl(image.data), mimeType: image.mimeType || 'image/png' }));
    }
    let parsed;
    const model = (0, exports.bomTableModel)();
    const thinking = (0, gptExtract_1.isReasoningModel)(model);
    // Ein denkendes Modell braucht Raum für sein Überlegen — die Grenze schliesst es ein.
    const answerBudget = Math.min(16_384, 400 + input.rows.length * (140 + input.columns.length * 20));
    try {
        const response = await (0, gptExtract_1.callChatCompletion)({
            model,
            temperature: 0,
            max_tokens: thinking ? answerBudget + 24_000 : answerBudget,
            ...(thinking ? { reasoning_effort: BOM_REASONING_EFFORT() } : {}),
            response_format: { type: 'json_schema', json_schema: { name: 'order_table_fill', strict: true, schema: buildSchema(input.columns, input.header === true) } },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content },
            ],
        }, 'bom-table');
        parsed = response.parsed ?? {};
        usages.push(response.usage);
    }
    catch (error) {
        if (error instanceof gptExtract_1.GptError)
            throw new TableAiError(error.message, error.code, error.status);
        throw error;
    }
    const allowed = new Set(input.rows.map((row) => row.index));
    const byIndex = new Map();
    for (const entry of Array.isArray(parsed.rows) ? parsed.rows : []) {
        const index = Number(entry?.index);
        if (!Number.isInteger(index) || !allowed.has(index) || byIndex.has(index))
            continue;
        const raw = entry?.values && typeof entry.values === 'object' ? entry.values : {};
        byIndex.set(index, {
            index,
            evidence: oneLine(entry?.evidence).slice(0, MAX_EVIDENCE),
            values: Object.fromEntries(input.columns.map((column) => [column.key, cleanValue(column, raw[column.key])])),
        });
    }
    /* EINE LIEFERANTENZEILE GEHÖRT HÖCHSTENS EINER BESTELLZEILE (27.09.2026 abends):
       gemessen ordnete das Modell in einem von fünf Läufen eine fehlende Position
       (SM 1223) derselben Angebotszeile zu wie ihre Nachbarin (SM 1231). Teilen
       sich Zeilen einen Beleg, behält ihn die, deren Typennummer in ihm steht —
       sonst die mit den meisten gemeinsamen Wörtern; die anderen bleiben leer. */
    const squash = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, '');
    const words = (value) => String(value ?? '').toLowerCase().split(/[^a-z0-9äöüß]+/).filter((word) => word.length >= 3);
    const rowByIndex = new Map(input.rows.map((row) => [row.index, row]));
    const byEvidence = new Map();
    for (const [index, entry] of byIndex) {
        const key = squash(entry.evidence);
        if (key.length < 4)
            continue;
        byEvidence.set(key, [...(byEvidence.get(key) ?? []), index]);
    }
    for (const [key, indexes] of byEvidence) {
        if (indexes.length < 2)
            continue;
        const score = (index) => {
            const row = rowByIndex.get(index);
            const model = squash(row?.modelNumber);
            if (model.length >= 4 && key.includes(model))
                return 1000;
            const evidence = String(byIndex.get(index)?.evidence ?? '').toLowerCase();
            return words(`${row?.name ?? ''} ${row?.brand ?? ''} ${row?.modelNumber ?? ''}`).filter((word) => evidence.includes(word)).length;
        };
        const keep = [...indexes].sort((a, b) => score(b) - score(a) || a - b)[0];
        for (const index of indexes) {
            if (index === keep)
                continue;
            byIndex.set(index, { index, evidence: '', values: Object.fromEntries(input.columns.map((column) => [column.key, ''])) });
        }
    }
    // Jede Zeile der Bestellung bekommt genau einen Eintrag — keine mehr, keine weniger.
    const empty = () => Object.fromEntries(input.columns.map((column) => [column.key, '']));
    const rows = input.rows.map((row) => byIndex.get(row.index) ?? { index: row.index, evidence: '', values: empty() });
    const valuesOf = (row) => Object.values(row.values).filter(Boolean).length;
    return {
        rows,
        matched: rows.filter((row) => row.evidence || valuesOf(row) > 0).length,
        filled: rows.reduce((sum, row) => sum + valuesOf(row), 0),
        usage: sumUsage(usages),
        model,
        sources,
        ...(input.header
            ? {
                document: {
                    number: oneLine(parsed.document?.number).slice(0, 120),
                    date: /^\d{4}-\d{2}-\d{2}$/.test(oneLine(parsed.document?.date)) ? oneLine(parsed.document?.date) : '',
                },
            }
            : {}),
    };
};
exports.fillTableWithAi = fillTableWithAi;
//# sourceMappingURL=bomTableAi.js.map