import {
    callChatCompletion,
    gptConfigured,
    gptModelName,
    GptError,
    imagePart,
    parsePrintedNumber,
    readImagePages,
    type GptUsage,
    type TemplateColumn,
} from './gptExtract';
import { readDocumentText, DocumentReadError } from './documentText';

/**
 * ── DIE TABELLE EINER BOM-BESTELLUNG PER KI FÜLLEN (27.09.2026, Vorgabe Samet) ─
 *
 * «Üretim siparişlerinde yeni sütun ekleme olmayacak, direkt şablon
 *  uygulanacak … bizim satırlar belli; biz prompt olarak alt alta satırlarımızı
 *  ve sipariş fiyatlarını atacağız … şablondaki boş [hücreler] attığımız PDF,
 *  görsel şu bu ile otomatik eşleşip … benzer isimse yapay zeka bunları
 *  eşleştirecek, satırlara bakacak, sütunlara bakacak, nereye yerleşmesi
 *  gerektiğine karar verip dolduracak; boşsa boş bırakacak.»
 *
 * Ersetzt das Füllen EINER selbst angelegten Spalte (bomColumnAi, gleicher Tag):
 * die Spalten kommen jetzt allein aus der VORLAGE der Bestellung, und die KI
 * füllt alle ihre offenen Spalten auf einmal.
 *
 *   · Die Zeilen der Bestellung sind FEST (ERP-Code, Name, Hersteller,
 *     Typennummer, Menge, Einheit) — das Modell bekommt sie und gibt für JEDE
 *     genau einen Eintrag zurück, nie eine Zeile mehr.
 *   · Die Quelle ist, was der Anwender hergibt: eingetippte oder eingefügte
 *     Zeilen mit Preisen (der «Prompt»), eine Excel-Tabelle, ein PDF (Textlage)
 *     oder Bilder. Ein Bild wird ZUERST als Raster abgeschrieben (`readImagePages`,
 *     gemessen spaltentreu, siehe gptExtract.ts) — trägt es keine Tabelle, sieht
 *     das Modell das Bild selbst.
 *   · Zuordnen: gleiche Hersteller-Typennummer zuerst, sonst ÄHNLICHE Namen
 *     (andere Sprache, Abkürzung, andere Reihenfolge) — Samet: «genellikle ilk
 *     seferde isimler olur, benzer isimse eşleştirecek».
 *   · Ein Wert ist eine ABSCHRIFT; steht nichts da, bleibt die Zelle leer.
 *     Welche Zelle am Ende wirklich geschrieben wird (nur leere, oder auch
 *     gefüllte), entscheidet die Oberfläche.
 */

/** Die Zuordnungen einer Vorlagenspalte, die die KI füllen darf — Name und Menge sind fest. */
export type TableAiLabel = 'grossPrice' | 'netPrice' | 'discount' | 'discount2' | 'total';
export const TABLE_AI_LABELS: readonly TableAiLabel[] = ['grossPrice', 'netPrice', 'discount', 'discount2', 'total'];

export interface TableAiColumn {
    /** Schlüssel der Vorlagenspalte (`c3`, `stdUnitPrice`, `x1` …). */
    key: string;
    /** Der Name, den die Vorlage der Spalte gibt. */
    name: string;
    type: 'text' | 'number';
    /** Die feste Bedeutung (Preis, Rabatt, Betrag) — null = eine freie Spalte. */
    label: TableAiLabel | null;
}

export interface TableAiRow {
    index: number;
    erpCode: string | null;
    name: string;
    brand: string | null;
    modelNumber: string | null;
    quantity: number;
    unit: string | null;
}

export interface TableAiInput {
    columns: TableAiColumn[];
    rows: TableAiRow[];
    /** Was der Anwender eingetippt oder eingefügt hat — Zeilen, Preise, Hinweise. */
    prompt: string | null;
    images: Array<{ data: string; mimeType: string }>;
    /** Excel/CSV als Tabulatortext aus dem Browser. */
    text: string | null;
    /** Ein PDF (Base64) — gelesen über seine Textlage. */
    document: { data: string; fileName: string | null; mimeType: string | null } | null;
    language: 'tr' | 'de' | 'en';
}

export type TableAiSource = 'prompt' | 'sheet' | 'pdf' | 'image';

export interface TableAiRowResult {
    index: number;
    /** Die Zeile der Quelle, die zugeordnet wurde — wörtlich; '' = keine. */
    evidence: string;
    /** Spaltenschlüssel → Wert ('' = nichts gefunden). */
    values: Record<string, string>;
}

export interface TableAiResult {
    rows: TableAiRowResult[];
    /** Zeilen, zu denen die Quelle etwas sagt. */
    matched: number;
    /** Gefundene Werte insgesamt. */
    filled: number;
    usage: GptUsage;
    model: string;
    sources: TableAiSource[];
}

export class TableAiError extends Error {
    constructor(message: string, readonly code: string, readonly status: number) {
        super(message);
    }
}

const MAX_VALUE = 240;
const MAX_EVIDENCE = 300;
/** So viel Text der Quelle geht höchstens an das Modell (~25'000 Token). */
const MAX_SOURCE_CHARS = 100_000;

/* ── Was die festen Spalten bedeuten ─────────────────────────────────────── */
const ROLE: Record<TableAiLabel, string> = {
    grossPrice: 'unit price BEFORE discount: the price of ONE unit as the supplier states it (list price / unit price)',
    netPrice: 'unit price AFTER discount: only when the supplier states a net or discounted unit price',
    discount: 'discount percentage for this article, written as a positive number',
    discount2: 'second discount percentage (applied after the first), written as a positive number',
    total: 'amount of the whole line (quantity x price) exactly as the supplier prints it',
};

const columnMeaning = (column: TableAiColumn): string => (column.label
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
    'In "evidence" copy the supplier line you matched, verbatim and complete (for two paired lists: the name and its value); "" when the row is unmatched.',
    'Text tables: a TAB separates two columns and two TABs in a row mean an empty cell - read every value under its own header.',
    'Return exactly one entry per order row, in the given order, with that row\'s index.',
].join(' ');

const buildSchema = (columns: TableAiColumn[]) => ({
    type: 'object',
    additionalProperties: false,
    properties: {
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
    required: ['rows'],
});

const oneLine = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

const rowsText = (rows: TableAiRow[]): string => rows
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
const plainText = (raw: string): string => raw
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');

const stripDataUrl = (value: string): string => (value.includes(',') ? value.slice(value.indexOf(',') + 1) : value);

/** Eine erkannte Zelle ins Format der Spalte bringen: Zahlenspalten als Zahl mit Punkt, Rabatte ohne Vorzeichen. */
const cleanValue = (column: TableAiColumn, raw: unknown): string => {
    const text = oneLine(raw).slice(0, MAX_VALUE);
    if (!text || /^[-–—]$/.test(text)) return '';
    if (!column.label && column.type !== 'number') return text;
    const value = parsePrintedNumber(text);
    // Eine Preis- oder Rabattspalte trägt nur eine Zahl; eine freie Zahlenspalte darf «3-4» behalten.
    if (value === null) return column.label ? '' : text;
    return String(column.label === 'discount' || column.label === 'discount2' ? Math.abs(value) : value);
};

const sumUsage = (parts: GptUsage[]): GptUsage => parts.reduce<GptUsage>((total, part) => ({
    promptTokens: total.promptTokens + part.promptTokens,
    completionTokens: total.completionTokens + part.completionTokens,
    totalTokens: total.totalTokens + part.totalTokens,
    estimatedUsd: total.estimatedUsd === null || part.estimatedUsd === null
        ? null
        : Math.round((total.estimatedUsd + part.estimatedUsd) * 1e6) / 1e6,
}), { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedUsd: 0 });

/** Ein abgeschriebenes Raster als Tabulatortext, Kopfzeile zuerst; eine leere Zelle bleibt leer. */
const gridText = (grid: { headers: string[]; rows: Array<Array<string | null>> }): string => [
    grid.headers.join('\t'),
    ...grid.rows.map((cells) => cells.map((cell) => cell ?? '').join('\t')),
].join('\n');

export const fillTableWithAi = async (input: TableAiInput): Promise<TableAiResult> => {
    if (!gptConfigured()) throw new TableAiError('Die KI ist nicht eingerichtet.', 'AI_NOT_CONFIGURED', 503);
    if (!input.rows.length) throw new TableAiError('Die Bestellung hat keine Zeilen.', 'AI_COLUMNS_REQUIRED', 400);
    if (!input.columns.length) throw new TableAiError('Die Vorlage hat keine Spalte, die gefüllt werden kann.', 'AI_COLUMNS_REQUIRED', 400);

    const usages: GptUsage[] = [];
    const sources: TableAiSource[] = [];
    /* Die Quelle als Text, Abschnitt für Abschnitt; Bilder ohne Tabelle gehen als Bild mit. */
    const sections: string[] = [];
    const looseImages: Array<{ data: string; mimeType: string; label: string }> = [];

    const prompt = plainText(String(input.prompt ?? ''));
    if (prompt.trim()) {
        sections.push(`=== Typed or pasted by the user ===\n${prompt}`);
        sources.push('prompt');
    }

    const readText = async (read: Parameters<typeof readDocumentText>[0]): Promise<string> => {
        try {
            return (await readDocumentText(read)).text;
        } catch (error) {
            if (error instanceof DocumentReadError) throw new TableAiError(error.message, 'AI_SOURCE_UNREADABLE', 422);
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
        const gridColumns: TemplateColumn[] = [
            { key: 'aiItem', name: 'Product / description', type: 'text', label: 'productName' },
            ...input.columns.map((column) => ({ key: column.key, name: column.name, type: column.type, label: column.label })),
        ];
        let pages: Awaited<ReturnType<typeof readImagePages>> = [];
        try {
            pages = await readImagePages(input.images, gridColumns);
        } catch (error) {
            if (!(error instanceof GptError)) throw error;
            throw new TableAiError(error.message, error.code, error.status);
        }
        pages.forEach((page, index) => {
            usages.push(page.usage);
            const label = `Image ${index + 1} of ${input.images.length}`;
            if (page.grid.rows.length) {
                sections.push(`=== ${label}, transcribed as a table (a TAB separates two columns, an empty cell is empty) ===\n${gridText(page.grid)}`);
            } else {
                // Keine Tabelle erkannt (Mail, Notiz): das Modell sieht das Bild selbst.
                looseImages.push({ ...input.images[index]!, label });
            }
        });
    }

    if (!sections.length && !looseImages.length) {
        throw new TableAiError('Zeilen, Bild, Excel oder PDF des Lieferanten fehlen.', 'AI_SOURCE_REQUIRED', 400);
    }

    let sourceText = sections.join('\n\n');
    if (sourceText.length > MAX_SOURCE_CHARS) sourceText = sourceText.slice(0, MAX_SOURCE_CHARS);

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
        'Supplier information:',
    ].join('\n');

    const content: unknown[] = [{ type: 'text', text: intro }];
    if (sourceText) content.push({ type: 'text', text: sourceText });
    for (const image of looseImages) {
        content.push({ type: 'text', text: `=== ${image.label} (no table found - read it directly) ===` });
        content.push(imagePart({ data: stripDataUrl(image.data), mimeType: image.mimeType || 'image/png' }));
    }

    let parsed: { rows?: Array<{ index?: unknown; evidence?: unknown; values?: Record<string, unknown> }> };
    try {
        const response = await callChatCompletion({
            model: gptModelName(),
            temperature: 0,
            max_tokens: Math.min(16_384, 400 + input.rows.length * (140 + input.columns.length * 20)),
            response_format: { type: 'json_schema', json_schema: { name: 'order_table_fill', strict: true, schema: buildSchema(input.columns) } },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content },
            ],
        }, 'bom-table');
        parsed = response.parsed ?? {};
        usages.push(response.usage);
    } catch (error) {
        if (error instanceof GptError) throw new TableAiError(error.message, error.code, error.status);
        throw error;
    }

    const allowed = new Set(input.rows.map((row) => row.index));
    const byIndex = new Map<number, TableAiRowResult>();
    for (const entry of Array.isArray(parsed.rows) ? parsed.rows : []) {
        const index = Number(entry?.index);
        if (!Number.isInteger(index) || !allowed.has(index) || byIndex.has(index)) continue;
        const raw = entry?.values && typeof entry.values === 'object' ? entry.values : {};
        byIndex.set(index, {
            index,
            evidence: oneLine(entry?.evidence).slice(0, MAX_EVIDENCE),
            values: Object.fromEntries(input.columns.map((column) => [column.key, cleanValue(column, raw[column.key])])),
        });
    }
    // Jede Zeile der Bestellung bekommt genau einen Eintrag — keine mehr, keine weniger.
    const empty = (): Record<string, string> => Object.fromEntries(input.columns.map((column) => [column.key, '']));
    const rows = input.rows.map((row) => byIndex.get(row.index) ?? { index: row.index, evidence: '', values: empty() });
    const valuesOf = (row: TableAiRowResult) => Object.values(row.values).filter(Boolean).length;
    return {
        rows,
        matched: rows.filter((row) => row.evidence || valuesOf(row) > 0).length,
        filled: rows.reduce((sum, row) => sum + valuesOf(row), 0),
        usage: sumUsage(usages),
        model: gptModelName(),
        sources,
    };
};
