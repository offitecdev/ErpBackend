import { callChatCompletion, gptConfigured, GptError, isReasoningModel, parsePrintedNumber, type GptUsage } from './gptExtract';
import { readDocumentText, DocumentReadError } from './documentText';
import { bomTableModel } from './bomTableAi';
import type { ComparisonRowInput, RawComparison } from '../../domain/services/priceComparison';

/**
 * ── ANGEBOTE VERGLEICHEN (29.09.2026, Vorgabe Samet) ─────────────────────────
 *
 * «Max 4 tedarikçinin 4 PDF'ini yapay zekâya vererek karşılaştıracağız ve
 *  yapay zekâ bize tablo verecek, en uygunları işaretleyerek.»
 *
 * Das Modell bekommt die festen Zeilen des Talep und je Lieferant sein
 * Angebot (die Textlage des PDF; ein gescanntes PDF ohne Textlage geht als
 * Datei selbst mit) und schreibt je Zeile und Angebot Stückpreis, Betrag,
 * Lieferzeit ab — dazu je Angebot Nummer, Datum, Währung, Zahlung und
 * Gültigkeit. Die Wahl «en uygun» rechnet danach `settleComparison`.
 * Dasselbe stärkere Modell wie die BOM-Tabelle (`gptBomModel`).
 */

export interface PriceCompareSource {
    supplierName: string;
    fileName: string;
    /** Das Angebot als PDF. */
    body: Buffer;
}

export interface PriceCompareInput {
    rows: ComparisonRowInput[];
    sources: PriceCompareSource[];
    language: 'tr' | 'de' | 'en';
}

export interface PriceCompareRead {
    raw: RawComparison;
    usage: GptUsage;
    model: string;
}

export type PriceCompareAiPort = (input: PriceCompareInput) => Promise<PriceCompareRead>;

export class PriceCompareError extends Error {
    constructor(message: string, readonly code: string, readonly status: number, readonly params: Record<string, unknown> = {}) {
        super(message);
    }
}

/** So viel Text eines Angebots geht an das Modell (~8'000 Token je Lieferant). */
const MAX_SOURCE_CHARS = 30_000;
const COMPARE_REASONING_EFFORT = (): string => String(process.env.gptCompareReasoningEffort ?? process.env.gptBomReasoningEffort ?? 'medium').trim() || 'medium';

const LANGUAGE_NAME: Record<PriceCompareInput['language'], string> = { tr: 'Turkish', de: 'German', en: 'English' };

const SYSTEM_PROMPT = [
    'You compare supplier quotations for a purchasing department.',
    'You get our request lines (FIXED: never add, remove, merge or reorder them) and up to four supplier documents',
    '(quotations, offers or order confirmations - the text layer of a PDF or the PDF itself).',
    'STEP 1 - MATCH. For every request line find, in EACH supplier document, the one position that means the SAME article.',
    'Compare the manufacturer part/model number first (ignore spaces, dots, dashes, slashes and letter case), otherwise the meaning of the names:',
    'suppliers write in any language (German, English, Turkish ...), abbreviate, reorder words or put the manufacturer in front.',
    'For example "Schütz" = contactor = kontaktör; "Leitungsschutzschalter", "LS-Schalter", "MCB" = miniature circuit breaker = otomatik sigorta;',
    '"Reihenklemme" = terminal block = klemens; "Stk.", "St.", "Stück" = pcs = adet.',
    'A supplier position belongs to at most one request line. Freight, packaging, surcharges, sums and VAT lines never match a request line.',
    'When a document has no position for a line, that supplier has NO offer for the line: leave its unitPrice and total "".',
    'STEP 2 - TRANSCRIBE. unitPrice is the price of ONE unit of the request line AFTER all discounts the document states for that position',
    '(when only a list price and a discount are printed you may apply the discount); total is the printed amount of the whole position.',
    'Copy numbers exactly as printed, without currency and without thousands separators that are not printed. Never invent a value.',
    'When the document prints a price per price unit ("PE 100", "je 100 Stk", "/100"), divide it so that unitPrice is the price of ONE unit.',
    'Take prices without VAT when both are printed. deliveryTime of an offer is the delivery time the document states for that position ("" when none).',
    'In "evidence" copy the matched position of the document, verbatim and short.',
    'For every supplier also read the header: the offer/quotation/confirmation number, its date as yyyy-mm-dd, the currency as a 3-letter ISO code',
    '(EUR, CHF, USD, TRY ...), the general delivery time, the payment terms and how long the offer is valid; "" when a value is not printed.',
    'In "notes" name what matters for the decision in one short sentence (freight, minimum order value, positions the supplier did not offer).',
    'STEP 3 - DECIDE. For every request line set "best" to the supplier index with the lowest unit price for the SAME article (-1 when no supplier',
    'offers it); with different currencies judge the value sensibly and say so in "reason". "reason" is one short sentence.',
    'In "recommendation" pick the supplier you would order from as a whole (-1 when none) and explain in two or three short sentences:',
    'total price, completeness, delivery time and payment terms.',
    'In every text you write ("notes", "reason", "recommendation.text") call a supplier by its NAME and a request line by its product NAME -',
    'never by an index or a number like "supplier 0" or "#1"; the indexes are only for the "supplier", "index" and "best" fields.',
    'Return one entry per request line, in the given order, with that line\'s index, and one offer entry per supplier in every line.',
].join(' ');

const TEXT = { type: 'string' } as const;
const INT = { type: 'integer' } as const;

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        suppliers: {
            type: 'array',
            description: 'One entry per supplier document',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    supplier: { ...INT, description: 'The supplier index' },
                    offerNumber: { ...TEXT, description: 'Offer / quotation / confirmation number; "" when none is printed' },
                    offerDate: { ...TEXT, description: 'The date of the document as yyyy-mm-dd; "" when none is printed' },
                    currency: { ...TEXT, description: '3-letter ISO currency code of the prices; "" when unclear' },
                    deliveryTime: { ...TEXT, description: 'General delivery time; "" when none is printed' },
                    paymentTerms: { ...TEXT, description: 'Payment terms; "" when none are printed' },
                    validity: { ...TEXT, description: 'How long the offer is valid; "" when not printed' },
                    notes: { ...TEXT, description: 'One short sentence on what matters for the decision; "" when nothing' },
                },
                required: ['supplier', 'offerNumber', 'offerDate', 'currency', 'deliveryTime', 'paymentTerms', 'validity', 'notes'],
            },
        },
        rows: {
            type: 'array',
            description: 'Exactly one entry per request line, in the given order',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    index: { ...INT, description: 'The index (#) of the request line' },
                    offers: {
                        type: 'array',
                        description: 'One entry per supplier',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                supplier: { ...INT, description: 'The supplier index' },
                                unitPrice: { ...TEXT, description: 'Price of ONE unit after discounts, as printed; "" when the supplier does not offer this line' },
                                total: { ...TEXT, description: 'Printed amount of the whole position; "" when not printed' },
                                deliveryTime: { ...TEXT, description: 'Delivery time of this position; "" when none is printed' },
                                note: { ...TEXT, description: 'A short remark (another variant, other quantity, alternative article); "" when nothing' },
                                evidence: { ...TEXT, description: 'The matched position, copied verbatim and short; "" when none' },
                            },
                            required: ['supplier', 'unitPrice', 'total', 'deliveryTime', 'note', 'evidence'],
                        },
                    },
                    best: { ...INT, description: 'Supplier index with the most favourable offer for this line; -1 when none' },
                    reason: { ...TEXT, description: 'One short sentence why' },
                },
                required: ['index', 'offers', 'best', 'reason'],
            },
        },
        recommendation: {
            type: 'object',
            additionalProperties: false,
            properties: {
                supplier: { ...INT, description: 'The supplier to order from as a whole; -1 when none' },
                text: { ...TEXT, description: 'Two or three short sentences explaining the choice' },
            },
            required: ['supplier', 'text'],
        },
    },
    required: ['suppliers', 'rows', 'recommendation'],
};

const oneLine = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();

const rowsText = (rows: ComparisonRowInput[]): string => rows
    .map((row, index) => [
        `#${index}`,
        row.erpCode || '-',
        oneLine(row.name) || '-',
        oneLine(row.brand) || '-',
        oneLine(row.modelNumber) || '-',
        `${row.quantity}${row.unit ? ` ${oneLine(row.unit)}` : ''}`,
    ].join(' | '))
    .join('\n');

/** Eine Zahl aus der Abschrift; «» und alles, was keine Zahl ist → null. */
const printed = (value: unknown): number | null => {
    const text = oneLine(value);
    if (!text) return null;
    const number = parsePrintedNumber(text);
    return number !== null && Number.isFinite(number) ? Math.abs(number) : null;
};

export const compareOffersWithAi: PriceCompareAiPort = async (input) => {
    if (!gptConfigured()) throw new PriceCompareError('Die KI ist nicht eingerichtet.', 'AI_NOT_CONFIGURED', 503);
    if (!input.rows.length) throw new PriceCompareError('Der Talep hat keine Zeilen.', 'REQUEST_EMPTY', 400);
    if (!input.sources.length) throw new PriceCompareError('Kein Angebot gewählt.', 'COMPARE_COUNT', 400);

    /* Je Angebot die Textlage; ein Scan ohne Textlage geht als Datei mit — das Modell liest ihn selbst. */
    const parts: unknown[] = [];
    for (const [index, source] of input.sources.entries()) {
        const head = `=== Supplier ${index}: ${oneLine(source.supplierName) || '-'} (file ${oneLine(source.fileName) || '-'}) ===`;
        try {
            const read = await readDocumentText({ data: source.body.toString('base64'), fileName: source.fileName, mimeType: 'application/pdf' });
            parts.push({ type: 'text', text: `${head}\n${read.text.slice(0, MAX_SOURCE_CHARS)}` });
        } catch (error) {
            if (!(error instanceof DocumentReadError)) throw error;
            if (error.code !== 'PDF_NO_TEXT_LAYER') {
                throw new PriceCompareError(error.message, 'COMPARE_PDF_UNREADABLE', 422, { supplier: source.supplierName });
            }
            parts.push({ type: 'text', text: `${head}\n(scanned PDF without a text layer - the file follows)` });
            parts.push({
                type: 'file',
                file: {
                    filename: oneLine(source.fileName) || `supplier-${index}.pdf`,
                    file_data: `data:application/pdf;base64,${source.body.toString('base64')}`,
                },
            });
        }
    }

    const intro = [
        `Write "notes", "reason" and "recommendation.text" in ${LANGUAGE_NAME[input.language] ?? 'Turkish'}.`,
        '',
        'Request lines (fixed) - # | our ERP code | name | manufacturer | manufacturer part/model number | quantity and unit:',
        rowsText(input.rows),
        '',
        `Supplier documents (${input.sources.length}), indexed 0 to ${input.sources.length - 1}:`,
    ].join('\n');

    const model = bomTableModel();
    const thinking = isReasoningModel(model);
    const answerBudget = Math.min(16_384, 800 + input.rows.length * input.sources.length * 90 + input.sources.length * 200);
    let parsed: any;
    let usage: GptUsage;
    try {
        const response = await callChatCompletion({
            model,
            temperature: 0,
            max_tokens: thinking ? answerBudget + 24_000 : answerBudget,
            ...(thinking ? { reasoning_effort: COMPARE_REASONING_EFFORT() } : {}),
            response_format: { type: 'json_schema', json_schema: { name: 'offer_comparison', strict: true, schema: SCHEMA } },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: [{ type: 'text', text: intro }, ...parts] },
            ],
        }, 'bom-compare');
        parsed = response.parsed ?? {};
        usage = response.usage;
    } catch (error) {
        if (error instanceof GptError) throw new PriceCompareError(error.message, error.code, error.status);
        throw error;
    }

    const suppliers = Array.isArray(parsed.suppliers) ? parsed.suppliers : [];
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    const raw: RawComparison = {
        suppliers: suppliers.map((entry: any) => ({
            supplier: Number(entry?.supplier),
            offerNumber: oneLine(entry?.offerNumber),
            offerDate: oneLine(entry?.offerDate),
            currency: oneLine(entry?.currency),
            deliveryTime: oneLine(entry?.deliveryTime),
            paymentTerms: oneLine(entry?.paymentTerms),
            validity: oneLine(entry?.validity),
            notes: oneLine(entry?.notes),
        })),
        rows: rows.map((entry: any) => ({
            index: Number(entry?.index),
            offers: (Array.isArray(entry?.offers) ? entry.offers : []).map((offer: any) => ({
                supplier: Number(offer?.supplier),
                unitPrice: printed(offer?.unitPrice),
                total: printed(offer?.total),
                deliveryTime: oneLine(offer?.deliveryTime),
                note: oneLine(offer?.note),
                evidence: oneLine(offer?.evidence),
            })),
            best: Number(entry?.best),
            reason: oneLine(entry?.reason),
        })),
        recommendation: {
            supplier: Number(parsed.recommendation?.supplier),
            text: oneLine(parsed.recommendation?.text),
        },
    };
    return { raw, usage, model };
};
