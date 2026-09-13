/**
 * DAS SPRACHMODELL HINTER DER LIEFERANTENBESTELLUNG (07.09.2026)
 *
 * Vorgabe Samet: «Ein PDF oder ein Bild, der Text geht an das Modell — GPT-4o
 * mini oder 4o, ich will die günstige Möglichkeit —, zurück kommt JSON nach
 * unserer Vorlage. Es soll NUR das herausziehen, was in der Vorlage steht.
 * Sprache und Aufbau des Belegs dürfen sich ändern, das Ziel bleibt gleich.»
 *
 * ── WARUM ÜBER DEN SERVER ───────────────────────────────────────────────
 * Der Schlüssel darf nicht im Browser-Bündel liegen. Wer die Seite öffnet,
 * könnte ihn sonst lesen und auf unsere Rechnung rechnen lassen. Die
 * Anwendung schickt den TEXT bzw. das BILD hierher, und erst von hier geht
 * es zu OpenAI.
 *
 * ── DIE VORLAGE (Stand 11.09.2026, Vorgabe Samet) ───────────────────────
 * Eine Vorlage ist eine LISTE VON SPALTEN — bis zu zwölf, vom Anwender selbst
 * benannt, jede mit einer Art (Text/Zahl) und freiwillig einer ZUORDNUNG
 * (`label`): Produktname, Menge, Einzelpreis, Nettopreis, Rabatt, Rabatt 2,
 * Zeilensumme. Produktname und Menge sind Pflicht. Der ERP-Code ist KEINE
 * Spalte der Vorlage: er ist fest, steht nur in der Tabelle, nie im PDF und
 * nie in der Anfrage an das Modell.
 *
 * Aus den Spalten wird das Antwortschema gebaut (`response_format:
 * json_schema`, `strict: true`):
 *   1. Das Modell KANN nichts anderes zurückgeben als diese Spalten — es
 *      erfindet keine Felder, und wir müssen nichts nachparsen.
 *   2. Jede nicht angelegte Spalte kostet keine Ausgabe-Token.
 *
 * ── ZWEI WEGE ───────────────────────────────────────────────────────────
 *   TEXT (PDF-Textlage, Excel)   `extractWithGpt`: Zeile für Zeile, mit dem
 *                                Zeilenanker `sourceLine`.
 *   BILD (Foto, Scan)            `readImagePages`: erst die Spalten der
 *                                Tabelle, dann die Tabelle ZEILE FÜR ZEILE
 *                                als Raster — jede Zelle unter ihrer
 *                                Überschrift, eine leere Zelle ist «-»; die
 *                                Zuordnung zur Vorlage macht danach der
 *                                Server (Samet, 11.09.2026, zweite Runde).
 *
 * ── EINRICHTUNG ─────────────────────────────────────────────────────────
 *   gptApi   = der OpenAI-Schlüssel (sk-…)            ← Pflicht
 *   gptModel = das Modell, Vorgabe `gpt-4.1-mini`     ← optional
 * Fehlt `gptApi`, meldet `gptConfigured()` false und die Route antwortet 503
 * mit `code: 'GPT_NOT_CONFIGURED'`.
 */

const API_KEY = (): string => String(
    // Der Name, den Samet vorgegeben hat, steht zuerst; die beiden anderen sind
    // nur Ausweichnamen für Umgebungen, die kleingeschriebene Variablen
    // unschön finden.
    process.env.gptApi ?? process.env.GPT_API ?? process.env.OFFITEC_GPT_API_KEY ?? '',
).trim();

/**
 * ── WELCHES MODELL LIEST ────────────────────────────────────────────────
 * Vorgabe Samet (08.09.2026): «Nimm eine etwas bessere Fassung — eine, die
 * tüchtig ist und nicht übermässig Token frisst.»
 *
 * `gpt-4.1-mini` statt `gpt-4o-mini`: dieselbe Bauart, aber deutlich sicherer
 * darin, eine Tabelle spaltentreu zu lesen. `gptModel` in der Umgebung
 * schlägt diese Vorgabe weiterhin.
 */
const MODEL = (): string => String(process.env.gptModel ?? process.env.GPT_MODEL ?? 'gpt-4.1-mini').trim();

const ENDPOINT = (): string => String(
    process.env.gptEndpoint ?? process.env.GPT_ENDPOINT ?? 'https://api.openai.com/v1/chat/completions',
).trim();

/**
 * ── WIE LANGE EIN BELEG BRAUCHEN DARF ───────────────────────────────────
 * Diese Frist ist die INNERSTE der drei (Nginx 300 s, Browser 290 s) und
 * muss die kleinste bleiben: nur dann meldet sich der Server selbst mit
 * einem verstaendlichen Satz, statt dass die Verbindung wortlos reisst.
 */
const TIMEOUT_MS = Number(process.env.gptTimeoutMs || 240_000);

/**
 * Die Ausgabegrenze eines Durchgangs. 16'384 ist, was die 4o-Reihe hergibt,
 * und reicht fuer weit ueber hundert Positionen samt Zeilenanker.
 */
const MAX_OUTPUT_TOKENS = Number(process.env.gptMaxOutputTokens || 16_384);

/** Steht der Schlüssel? Ohne ihn hat die Route nichts zu tun. */
export const gptConfigured = (): boolean => API_KEY().length > 0;

/** Welches Modell gerade arbeitet — die Oberfläche zeigt es an. */
export const gptModelName = (): string => MODEL();

export class GptError extends Error {
    constructor(message: string, readonly code: string, readonly status: number, readonly detail?: string) {
        super(message);
    }
}

/* ── DIE SPALTEN SIND DIE VORLAGE ────────────────────────────────────────
   Der Aufrufer schickt die Spalten seiner Vorlage, und aus ihnen wird das
   Antwortschema gebaut: der stabile Schluessel (`c1` …) wird der Feldname,
   der vom Anwender vergebene NAME wird die Beschreibung, an der das Modell
   die Spalte im Beleg erkennt, und die ZUORDNUNG sagt, was der Wert bedeutet
   (Listenpreis vor Rabatt, Nettopreis danach …). */

export type ColumnType = 'text' | 'number';

/**
 * DIE ZUORDNUNGEN (Vorgabe Samet, 11.09.2026): Produktname und Menge sind
 * ueberall Pflicht; die uebrigen sind freiwillig, jede hoechstens einmal je
 * Vorlage. Sie sind zugleich die Feldnamen der Bestellzeile.
 */
export const TEMPLATE_LABELS = ['productName', 'quantity', 'grossPrice', 'netPrice', 'discount', 'discount2', 'total'] as const;
export type TemplateLabel = (typeof TEMPLATE_LABELS)[number];
export const REQUIRED_TEMPLATE_LABELS: TemplateLabel[] = ['productName', 'quantity'];

const LABEL_SET = new Set<string>(TEMPLATE_LABELS);

export interface TemplateColumn {
    /** Stabiler Bezug: c1 … c12. Er wird der Feldname im Schema. */
    key: string;
    /** Der Name, den der Anwender vergeben hat — die Beschreibung im Schema. */
    name: string;
    type: ColumnType;
    /** Die Rolle in der Bestellzeile; null/fehlend = eine freie Spalte. */
    label?: TemplateLabel | null;
}

export const TEMPLATE_MIN_COLUMNS = 1;
/**
 * Zwoelf Spalten — plus den festen ERP-Code, der nie hierher kommt: «bis zu
 * dreizehn Spalten (12+1)» (Vorgabe Samet, 11.09.2026).
 */
export const TEMPLATE_MAX_COLUMNS = 12;

/**
 * Ein Schluessel ist ein schlichter Bezeichner: ein Buchstabe, dann Buchstaben
 * oder Ziffern. GROSSBUCHSTABEN GEHOEREN DAZU — was hier nicht durchkommt,
 * verschwindet OHNE Fehler, also muss die Form grosszuegig sein.
 */
const COLUMN_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,15}$/;

/**
 * Die Spalten einer Anfrage pruefen. Was hier nicht durchkommt, geht auch
 * nicht an das Modell: fremde Schluessel, leere Namen, Doppelte, eine
 * Zuordnung, die schon vergeben ist, und alles jenseits der zwoelften Spalte.
 */
export const normalizeColumns = (raw: unknown): TemplateColumn[] => {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set<string>();
    const usedLabels = new Set<string>();
    const columns: TemplateColumn[] = [];
    for (const entry of list) {
        const key = String((entry as any)?.key ?? '').trim();
        const name = String((entry as any)?.name ?? '').trim().slice(0, 60);
        if (!COLUMN_KEY.test(key) || !name || seen.has(key)) continue;
        seen.add(key);
        const rawLabel = String((entry as any)?.label ?? '').trim();
        const label = LABEL_SET.has(rawLabel) && !usedLabels.has(rawLabel) ? rawLabel as TemplateLabel : null;
        if (label) usedLabels.add(label);
        columns.push({ key, name, type: (entry as any)?.type === 'number' ? 'number' : 'text', label });
        if (columns.length >= TEMPLATE_MAX_COLUMNS) break;
    }
    return columns;
};

/** Fehlt eine Pflichtzuordnung? Gibt die fehlenden zurueck (leer = alles da). */
export const missingTemplateLabels = (columns: TemplateColumn[]): TemplateLabel[] => {
    const present = new Set(columns.map((column) => column.label));
    return REQUIRED_TEMPLATE_LABELS.filter((label) => !present.has(label));
};

/**
 * ── DER ZEILENANKER (Textweg) ───────────────────────────────────────────────
 * Steht als ERSTE Eigenschaft der Zeile: das Modell muss die gedruckte Zeile
 * ABSCHREIBEN, bevor es sie in Spalten zerlegt — danach darf jeder Wert der
 * Position nur aus dieser einen Zeile stammen.
 */
export const SOURCE_LINE_FIELD = 'sourceLine';

/* ── WAS DIE ZUORDNUNGEN BEDEUTEN ─────────────────────────────────────────
   Die Anwendung schickt Spaltennamen; die Bedeutung steht hier. Ohne sie
   raet das Modell — und riet bei zwei Preisspalten zweimal dieselbe Zahl. */
const ROLE_HINTS: Record<TemplateLabel, string> = {
    productName: 'The item description of this row, copied EXACTLY as printed, in full and character for character. Never translate it, never abbreviate a word, never shorten or summarise it: "TeSys Deca contactor - 3P(3 NO)" stays "TeSys Deca contactor - 3P(3 NO)" and never becomes "TeSys D contactor"',
    quantity: 'Ordered quantity as a plain number, without the unit',
    grossPrice: 'The MATERIAL price of one unit as printed in the price column - the list price BEFORE any discount. Never put a discounted price, a line amount or a total here',
    netPrice: 'The price of one unit AFTER the discount. It is always LOWER than the gross price whenever a discount exists, and equal to it only when there is none',
    discount: 'The discount PERCENTAGE of this line as a positive number, even when the document prints it with a minus sign: "-45.36" means 45.36. Use 0 when the line has no discount',
    discount2: 'A second discount percentage applied after the first, positive, 0 if none',
    total: 'Amount of the whole line: quantity * the NET unit price - never the gross one. Take the printed line amount when the document shows one. It never contains VAT',
};

const columnDescription = (column: TemplateColumn): string => (column.label
    ? `${ROLE_HINTS[column.label]} (document column: "${column.name}")`
    : `Column "${column.name}" of the position, copied as printed`);

/* ── Antwortschema (Textweg) ──────────────────────────────────────────────
   `strict: true` verlangt, dass JEDE Eigenschaft in `required` steht und
   `additionalProperties: false` gesetzt ist. «Nicht gefunden» wird deshalb
   nicht durch Weglassen ausgedrueckt, sondern durch `null`. */

const buildSchema = (columns: TemplateColumn[], includeDocumentHeader = true) => {
    const properties: Record<string, unknown> = {};
    properties[SOURCE_LINE_FIELD] = {
        type: ['string', 'null'],
        description: 'The complete printed line of this position, copied verbatim from the document, '
            + 'including its continuation lines. Every other field of this row must be taken from THIS line only',
    };
    for (const column of columns) {
        properties[column.key] = {
            type: [column.type === 'number' ? 'number' : 'string', 'null'],
            description: columnDescription(column),
        };
    }
    const rowKeys = Object.keys(properties);
    const documentProperties = includeDocumentHeader ? {
        supplierName: { type: ['string', 'null'], description: 'Company that issued the document' },
        documentNumber: { type: ['string', 'null'], description: 'Offer / order number on the document' },
        documentDate: { type: ['string', 'null'], description: 'Date on the document, ISO yyyy-mm-dd' },
        currency: { type: ['string', 'null'], description: 'ISO currency code, e.g. CHF, EUR' },
        vatRate: { type: ['number', 'null'], description: 'VAT percentage of the whole document' },
        totalNet: { type: ['number', 'null'], description: 'Net total of the document' },
    } : {};
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            ...documentProperties,
            rows: {
                type: 'array',
                description: 'One entry per order position',
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties,
                    required: rowKeys,
                },
            },
        },
        required: includeDocumentHeader
            ? ['supplierName', 'documentNumber', 'documentDate', 'currency', 'vatRate', 'totalNet', 'rows']
            : ['rows'],
    };
};

/* ── Die Anweisung (Textweg) ──────────────────────────────────────────────
   Englisch, weil dieselbe Anweisung auf Englisch rund ein Drittel weniger
   Token braucht als auf Deutsch. */

const LANGUAGE_NAMES: Record<string, string> = {
    de: 'German',
    en: 'English',
    tr: 'Turkish',
};

const systemPrompt = (language: string): string => {
    const target = LANGUAGE_NAMES[language] ?? LANGUAGE_NAMES.de;
    return [
        'Read the supplier document text and return its order positions.',
        'Each field is named after a column of the order; take the value that belongs to that column.',
        'Work through the document ONE POSITION LINE AT A TIME, from top to bottom, in the printed order.',
        `For each position, first copy its whole printed line verbatim into "${SOURCE_LINE_FIELD}" (including any continuation line that belongs to it), and only then split THAT line into the fields.`,
        'Every value of a row must come from that row\'s own line. Never take a value from the line above or below, never carry a value over from the previous position, and never collect a column top-down across the document.',
        'If a line does not show a value, that field is null for this position - do not fill the gap from a neighbouring line.',
        'In the text form of the document a TAB separates two columns.',
        'Two tabs in a row mean the cell between them is EMPTY: that field is null, and the value after the gap keeps'
        + ' its own column. Never slide a value left into an empty cell, and never let an empty cell shift the rest of the row.',
        'Count the columns of every line from the left, gap by gap, and match them against the header line of the table.',
        'Return the positions in the order they are printed, one entry per printed position, and never reorder them.',
        'Return one entry per line of the table - no more, no fewer.',
        'A row belongs in the answer even when most of its cells are empty: an empty cell is null, an empty row is still a row.',
        'Never merge two printed rows into one entry, never split one printed row into two, and never leave out a row because it looks unimportant, repeats the row above, or continues it.',
        'The last printed row of the table matters as much as the first - do not stop before you reach it.',
        'Every text value is a TRANSCRIPTION of what is printed, not a translation: copy it character for character,'
        + ' with its own wording, spelling, punctuation, spacing, capitalisation and units.',
        'Never translate, abbreviate, expand, shorten, summarise, correct or tidy any value you take from the document -'
        + ' not the description, not the unit, not an identifier.',
        `This holds for "${SOURCE_LINE_FIELD}" as well: it is never translated, shortened or tidied - it is the document's own wording.`,
        `You may use ${target} only for a word you have to invent yourself, and there is none in this task.`,
        'Numbers: plain decimals with a dot, no thousand separators, no currency symbol, no percent sign.',
        'Keep every decimal place that is printed - 9.50 stays 9.50 and 0.125 stays 0.125 - and never round a value.',
        'Percentages are numbers: 7.5 means 7.5%.',
        'Price logic of one position, in this order:',
        '(1) the gross price is the material list price of one unit, before discount;',
        '(2) the discount is a PERCENTAGE, positive even when printed with a minus sign;',
        '(3) the net price is the unit price after that discount: net = gross * (1 - discount/100);',
        '(4) the line total is quantity * net price, never quantity * gross price;',
        '(5) VAT is not part of any of these - it is applied at the very end, on the sum of the line totals, so never add it to a price or to a line total.',
        'Worked example: gross 78.10 with a printed discount of -45.36 gives discount 45.36, net 42.67 and, for quantity 1, a line total of 42.67.',
        'Gross and net are equal only when the line truly has no discount. Otherwise derive the missing one from the other - never copy the same number into both.',
        'Leave out only what is printed OUTSIDE the position table: page headers and footers, the address block,'
        + ' delivery and payment terms, and the closing total block of the document.',
        'Inside the position table nothing is left out. Do not judge whether a row is important - transcribe it.',
        'The same holds column by column: an empty cell stays empty. Read each value from the column it is printed under,'
        + ' never from the nearest column that happens to have a number in it.',
        'A value that is not on the document is null. Never guess or invent.',
    ].join(' ');
};

/* ── Preisliste je Modell ────────────────────────────────────────────────
   Nur zur ANZEIGE. Ein unbekanntes Modell bekommt keine geschätzten Kosten,
   sondern `null` — lieber keine Zahl als eine falsche. */
const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'gpt-4o': { input: 2.5, output: 10 },
    'gpt-4.1-mini': { input: 0.4, output: 1.6 },
    'gpt-4.1-nano': { input: 0.1, output: 0.4 },
};

export interface GptUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** Geschätzte Kosten in US-Dollar — `null`, wenn das Modell unbekannt ist. */
    estimatedUsd: number | null;
}

const usageOf = (raw: any, model: string): GptUsage => {
    const promptTokens = Number(raw?.prompt_tokens) || 0;
    const completionTokens = Number(raw?.completion_tokens) || 0;
    const price = PRICE_PER_MILLION[model];
    return {
        promptTokens,
        completionTokens,
        totalTokens: Number(raw?.total_tokens) || promptTokens + completionTokens,
        estimatedUsd: price
            ? Math.round(((promptTokens * price.input + completionTokens * price.output) / 1e6) * 1e6) / 1e6
            : null,
    };
};

/* ── DIE NEUERE MODELLREIHE ──────────────────────────────────────────────
   gpt-5… und die o-Reihe denken vor der Antwort. Sie nehmen keine
   `temperature` ausser der eigenen und kein `max_tokens` — die Grenze heisst
   dort `max_completion_tokens` und schliesst das Denken ein. Wie viel sie
   denken duerfen, sagt `gptReasoningEffort` (Vorgabe `low`). Ohne diese
   Anpassung lehnt OpenAI jede Anfrage an ein solches Modell mit 400 ab. */
const isReasoningModel = (model: string): boolean => /^(o\d|gpt-5|gpt-6)/i.test(model) && !/chat/i.test(model);

const REASONING_EFFORT = (): string => String(process.env.gptReasoningEffort ?? 'low').trim();

const fitBodyToModel = (body: any): any => {
    if (!isReasoningModel(String(body?.model ?? ''))) return body;
    const { temperature: _temperature, max_tokens: maxTokens, ...rest } = body;
    return { ...rest, max_completion_tokens: maxTokens, reasoning_effort: REASONING_EFFORT() };
};

/* ── Ein Aufruf, drei Fehlerbilder ───────────────────────────────────────
   Beide Wege (Text und Bild) reden mit demselben Endpunkt und scheitern auf
   dieselben Arten. Die Faelle, die NICHT am Beleg liegen, sondern am Konto,
   muessen sich anders anfuehlen als «der Beleg wurde abgelehnt». */
const callChatCompletion = async (body: unknown, scope: string): Promise<{ parsed: any; usage: GptUsage }> => {
    const key = API_KEY();
    if (!key) throw new GptError('Die KI-Erkennung ist nicht eingerichtet.', 'GPT_NOT_CONFIGURED', 503);
    const model = MODEL();

    let response: Response;
    try {
        response = await fetch(ENDPOINT(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify(fitBodyToModel(body)),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (error: any) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        throw new GptError(
            timedOut ? 'Die KI-Erkennung hat zu lange gebraucht.' : 'Die KI-Erkennung ist nicht erreichbar.',
            timedOut ? 'GPT_TIMEOUT' : 'GPT_UNREACHABLE',
            504,
        );
    }

    const payload: any = await response.json().catch(() => null);
    if (!response.ok) {
        const message = String(payload?.error?.message || '').slice(0, 400);
        console.error(`[gptExtract/${scope}] OpenAI antwortete`, response.status, message || '(ohne Grund)');
        if (response.status === 401 || response.status === 403) {
            throw new GptError('Der KI-Schlüssel wird nicht angenommen.', 'GPT_KEY_REJECTED', 503, message);
        }
        if (response.status === 429) {
            throw new GptError('Die KI-Erkennung ist ausgelastet oder das Guthaben ist aufgebraucht.', 'GPT_QUOTA', 429, message);
        }
        if (response.status === 404) {
            throw new GptError(`Das Modell «${model}» steht diesem Schlüssel nicht offen.`, 'GPT_MODEL_UNAVAILABLE', 503, message);
        }
        throw new GptError('Die KI-Erkennung hat den Beleg abgelehnt.', 'GPT_REJECTED', 502, message);
    }

    const choice = payload?.choices?.[0];
    /* `length` heisst: die Antwort wurde mitten im JSON abgeschnitten. Sie
       wegzuwerfen ist richtig — halb geparste Positionen wären schlimmer als
       keine, weil sie glaubwürdig aussehen. */
    if (choice?.finish_reason === 'length') {
        throw new GptError(
            'Der Beleg ist für einen Durchgang zu lang. Bitte weniger Seiten aufs Mal hochladen.',
            'GPT_TRUNCATED',
            422,
            `Die Antwort riss nach ${MAX_OUTPUT_TOKENS} Token ab.`,
        );
    }
    if (choice?.message?.refusal) {
        throw new GptError('Die KI-Erkennung hat den Beleg abgelehnt.', 'GPT_REFUSED', 422, String(choice.message.refusal).slice(0, 300));
    }

    let parsed: any;
    try {
        parsed = JSON.parse(String(choice?.message?.content ?? ''));
    } catch {
        throw new GptError('Die Antwort der KI war nicht lesbar.', 'GPT_BAD_JSON', 502);
    }
    return { parsed, usage: usageOf(payload?.usage, model) };
};

/* ═══════════════════════════════════════════════════════════════════════
   DER BILDWEG — ERST DIE TABELLE, DANN DIE VORLAGE
   ═══════════════════════════════════════════════════════════════════════

   Fehlerbild Samet (11.09.2026, zweite Runde, am Blatt «Malzeme Grubu …»):
   «Die KI versteht die Luecken im Bild nicht. Sie muss erkennen, welche
   Werte unter welcher Spalte stehen und welche leer sind — eine Tabelle
   daraus machen. Sie schiebt Werte ineinander, und eine Spalte hat sie gar
   nicht gesehen.»

   Am selben Blatt gemessen (scratchpad/_grid-live.ts, 38 Zeilen, Soll von
   Hand abgeschrieben): das SPALTENWEISE Lesen vom Vormittag — je Spalte
   eine Liste von oben nach unten, «-» fuer leer — traf 93 % der Zellen,
   aber die Fehler sassen genau dort, wo es wehtut. Eine Spalte bekam 39
   Eintraege statt 38, und ab dort stand jede Gruppe eine Zeile zu tief;
   leere Zellen wurden vom Nachbarn gefuellt (ZBY9320 unter der Typnummer,
   «Adet» in der leeren Einheit); die Links unter «Ürün Tip Numarası»
   fehlten ganz. Wer eine Spalte von oben nach unten abliest, verliert die
   Zeile aus den Augen: ein «-» zu viel oder zu wenig, und alles darunter
   rutscht.

   Darum jetzt zwei Blicke auf dasselbe Bild:
     1. DER KOPF    Welche Spalten hat die Tabelle, von links nach rechts —
                    ALLE, nicht nur die der Vorlage —, und welche davon ist
                    welche Spalte der Vorlage? (`readGridHead`)
     2. DAS RASTER  Die Tabelle ZEILE FUER ZEILE. Jede Zeile ist ein Objekt
                    mit einem Feld fuer JEDE gedruckte Spalte, benannt nach
                    ihrer Ueberschrift (`p3_urun_tip_numarasi`). Jedes Feld
                    ist Pflicht, also kann keine Zelle ausgelassen werden;
                    eine leere Zelle ist ein ausdrueckliches «-», nie ein
                    Nachbarwert. Und weil der Feldname die Spalte nennt,
                    schreibt das Modell vor jeden Wert, unter welcher
                    Ueberschrift es ihn sieht. (`readGridRows`)
   Welche gedruckte Spalte welche Vorlagenspalte ist, entscheidet danach
   dieser Server (`resolveGridMapping`): gleicher Name zuerst, dann der
   Vorschlag des Modells, dann ein aehnlicher Name. Das Raster reist in der
   Antwort mit — so ist nachzusehen, was auf dem Blatt stand. */

/** Was in einer Zelle als «leer» gilt — das vereinbarte «-» und Nichts. */
const EMPTY_CELL = /^[-–—]?$/;

/**
 * Eine gedruckte Zahl in eine JavaScript-Zahl: «CHF 1'234.50», «1.234,50»,
 * «12,50», «-45.36 %» — alles, was ein Lieferant so druckt. `null`, wenn in
 * der Zelle keine Zahl steckt.
 */
export const parsePrintedNumber = (raw: string): number | null => {
    const cleaned = raw.replace(/[^\d.,'’\s+-]/g, '').replace(/[’'\s]/g, '').trim();
    if (!cleaned || !/\d/.test(cleaned)) return null;
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    let normalized: string;
    if (lastComma >= 0 && lastDot >= 0) {
        // Beide Zeichen: das LETZTE ist das Dezimalzeichen, das andere trennt Tausender.
        normalized = lastComma > lastDot
            ? cleaned.replace(/\./g, '').replace(',', '.')
            : cleaned.replace(/,/g, '');
    } else if (lastComma >= 0) {
        // Nur Kommas: «1,234» (genau drei Ziffern danach, einmalig) ist ein
        // Tausender; «12,5» und «12,50» sind Dezimalzahlen.
        const after = cleaned.length - lastComma - 1;
        const commas = (cleaned.match(/,/g) ?? []).length;
        normalized = commas === 1 && after !== 3 ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
    } else if (lastDot >= 0) {
        const dots = (cleaned.match(/\./g) ?? []).length;
        // «1.234.567» sind Tausender; «1.234» allein bleibt eine Dezimalzahl,
        // denn ein Preis von 1.234 ist haeufiger als eine Menge von 1234.
        normalized = dots > 1 ? cleaned.replace(/\./g, '') : cleaned;
    } else {
        normalized = cleaned;
    }
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
};

/** So viele gedruckte Spalten traegt ein Raster hoechstens. */
const GRID_MAX_COLUMNS = 24;

/** Was eine Zuordnung bedeutet — kurz, fuer die Frage «welche Spalte ist das?». */
const ROLE_NAMES: Record<TemplateLabel, string> = {
    productName: 'the item description / product name',
    quantity: 'the ordered quantity',
    grossPrice: 'the unit list price BEFORE discount',
    netPrice: 'the unit price AFTER discount',
    discount: 'the discount percentage',
    discount2: 'a second discount percentage',
    total: 'the amount of the whole line',
};

const HEADER_PROMPT = [
    'You look at a printed table in an image and describe its COLUMNS. You do not read the rows yet.',
    'List every column of the position table from left to right - all of them: columns you are not asked about, columns whose cells are mostly empty, and narrow ones such as a position number.',
    'For each column write its header exactly as printed (a header printed on two lines is joined with one space; a column without a header gets "")'
    + ' and the first non-empty value printed under it, copied exactly ("" when the whole column is empty).',
    'Then match the requested columns: for each one give the number of the printed column that holds it (1 = the leftmost column), or 0 when the table has no such column.',
    'A requested column whose name is printed as a header is that column. Two requested columns never point to the same printed column.',
].join(' ');

const GRID_PROMPT = [
    'You transcribe a printed table from an image into a grid, ROW BY ROW. You do not interpret, summarise, translate or correct anything.',
    'Every entry of "rows" is one position row of the table, top to bottom, in printed order. The header row is not a position row.',
    'A row has one field for every printed column; the field name says which column it is - its number from the left and its header.',
    'For every row, go through the fields from left to right. For each field, look straight down from that column\'s header into this row and copy exactly what is printed in that cell - and nothing from any other cell.',
    'A cell with nothing printed in it is written as "-". Never fill an empty cell with the value of the neighbouring column or of the row above or below:'
    + ' the empty cell stays "-", and every value to the right of it stays in its own column.',
    'A value belongs to the column whose header stands above it. When a row shows fewer values than the table has columns, some of its cells are empty -'
    + ' decide WHICH ones by where each value is printed, never by counting the values from the left.',
    'A row can be taller than one line: all text between the row\'s top and bottom border belongs to that row, also when it sits at the bottom or in the middle of the cell.',
    'Text that wraps over several lines inside one cell is ONE value: join the lines with a single space - a web address or a word that was broken across lines is joined back without a space.',
    'Copy every value character for character: descriptions, identifiers, web addresses, units and numbers alike. Keep the digits and the decimal separator exactly as printed.',
    'Transcribe every position row, including the last one and rows whose cells are mostly empty.'
    + ' Leave out only what stands outside the table: headings, notes, the address block and the closing totals.',
].join(' ');

/** Ein Name auf Buchstaben und Ziffern gebracht — «Ürün Sip. Numarası» → «urun sip numarasi». */
const foldName = (value: string): string => value
    .replace(/[ıİ]/g, 'i')
    .replace(/ß/g, 'ss')
    .replace(/[øØ]/g, 'o')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Der Feldname einer gedruckten Spalte im Raster: Nummer plus Ueberschrift, `p3_urun_tip_numarasi`. */
const gridField = (index: number, header: string): string => {
    const slug = foldName(header).replace(/ /g, '_').slice(0, 28).replace(/_+$/, '');
    return slug ? `p${index + 1}_${slug}` : `p${index + 1}`;
};

const imagePart = (image: { data: string; mimeType: string }) => ({
    type: 'image_url',
    /* `detail: 'high'` ist noetig: bei `low` schrumpft die Seite auf 512px
       und die Rappenstellen sind nicht mehr lesbar. */
    image_url: { url: `data:${image.mimeType};base64,${image.data}`, detail: 'high' },
});

const addUsages = (a: GptUsage, b: GptUsage): GptUsage => ({
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    estimatedUsd: a.estimatedUsd === null || b.estimatedUsd === null
        ? null
        : Math.round((a.estimatedUsd + b.estimatedUsd) * 1e6) / 1e6,
});

/** Eine gedruckte Spalte, wie der erste Blick sie sah. */
export interface GridColumn {
    /** Die Ueberschrift, wie sie gedruckt ist ('' ohne Ueberschrift). */
    header: string;
    /** Der erste gefuellte Wert darunter — hilft dem zweiten Blick, die Spalte wiederzufinden. */
    firstValue: string;
    /** Der Feldname im Raster. */
    field: string;
}

interface GridHead {
    columns: GridColumn[];
    /** Vorschlag des Modells: Vorlagenspalte → gedruckte Spalte (0-basiert), -1 = keine. */
    suggested: Record<string, number>;
    usage: GptUsage;
}

/* ── Antwortschema des ersten Blicks: die Spalten und die Zuordnung ───── */
const buildHeaderSchema = (columns: TemplateColumn[]) => ({
    type: 'object',
    additionalProperties: false,
    properties: {
        columns: {
            type: 'array',
            description: 'Every printed column of the position table, left to right',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    header: { type: 'string', description: 'The column header exactly as printed; "" when the column has none' },
                    firstValue: { type: 'string', description: 'The first non-empty value printed under this header, copied exactly; "" when the column is empty' },
                },
                required: ['header', 'firstValue'],
            },
        },
        mapping: {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(columns.map((column) => [column.key, {
                type: 'integer',
                description: `Number of the printed column (1 = leftmost) that holds the requested column "${column.name}"; 0 when the table has none`,
            }])),
            required: columns.map((column) => column.key),
        },
    },
    required: ['columns', 'mapping'],
});

/* ── Antwortschema des zweiten Blicks: das Raster ────────────────────────
   Je gedruckte Spalte EIN Pflichtfeld je Zeile: die Zeile kann keine Zelle
   verschweigen, sie kann sie nur ausdruecklich leer («-») nennen.

   Bewusst NUR `string`, kein `['string', 'null']`: mit der Wahl zwischen
   null und Text lief das Modell am Blatt vom 08.09. in eine Schleife — es
   schrieb mitten in einer Zelle bis zur Tokengrenze nur noch das Nullzeichen U+0000
   (16'384 Token, keine Antwort). */
const buildGridSchema = (grid: GridColumn[]) => ({
    type: 'object',
    additionalProperties: false,
    properties: {
        rows: {
            type: 'array',
            description: 'One entry per position row of the table, top to bottom',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: Object.fromEntries(grid.map((column, index) => [column.field, {
                    type: 'string',
                    description: `Cell of column ${index + 1} from the left, header "${column.header || '(no header)'}"`
                        + `${column.firstValue ? ` (first value in this column: "${column.firstValue}")` : ''}; "-" when this row's cell is empty`,
                }])),
                required: grid.map((column) => column.field),
            },
        },
    },
    required: ['rows'],
});

/** Eine gedruckte Zelle, bereinigt: Weissraum zu einem Leerzeichen, «-» und Nichts zu null. */
const gridCell = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    const text = String(value).replace(/\s+/g, ' ').trim();
    return EMPTY_CELL.test(text) ? null : text;
};

/**
 * DER ERSTE BLICK: welche Spalten die Tabelle hat, und welche davon welche
 * Spalte der Vorlage ist. Ab der zweiten Aufnahme kennt er die Spalten der
 * ersten — eine Folgeseite druckt die Kopfzeile oft nicht noch einmal.
 */
const readGridHead = async (
    image: { data: string; mimeType: string },
    columns: TemplateColumn[],
    previousHeaders: string[] | null,
): Promise<GridHead> => {
    const requested = columns
        .map((column) => `${column.key}: "${column.name}"${column.label ? ` (${ROLE_NAMES[column.label]})` : ''}`)
        .join('\n');
    const previous = previousHeaders?.length
        ? `\n\nThe previous page of this document had these columns, left to right: ${previousHeaders.map((header, index) => `${index + 1}. "${header}"`).join(', ')}.`
            + ' If this page continues that table without printing the header row again, list exactly those columns.'
        : '';
    const body = {
        model: MODEL(),
        temperature: 0,
        max_tokens: 4_000,
        response_format: {
            type: 'json_schema',
            json_schema: { name: 'document_columns', strict: true, schema: buildHeaderSchema(columns) },
        },
        messages: [
            { role: 'system', content: HEADER_PROMPT },
            {
                role: 'user',
                content: [
                    { type: 'text', text: `Requested columns:\n${requested}${previous}\n\nDescribe the columns of the table in this image.` },
                    imagePart(image),
                ],
            },
        ],
    };
    const { parsed, usage } = await callChatCompletion(body, 'grid-head');
    const printed: any[] = Array.isArray(parsed?.columns) ? parsed.columns.slice(0, GRID_MAX_COLUMNS) : [];
    const gridColumns = printed.map((entry, index) => {
        const header = String(entry?.header ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
        return {
            header,
            firstValue: String(entry?.firstValue ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
            field: gridField(index, header),
        };
    });
    const suggested: Record<string, number> = {};
    for (const column of columns) {
        const value = Math.trunc(Number(parsed?.mapping?.[column.key]));
        suggested[column.key] = Number.isFinite(value) && value >= 1 && value <= gridColumns.length ? value - 1 : -1;
    }
    return { columns: gridColumns, suggested, usage };
};

/**
 * DER ZWEITE BLICK: die Tabelle Zeile fuer Zeile, jede Zelle unter ihrer
 * Ueberschrift. Zurueck kommt das Raster — eine Liste je Zeile, eine Zelle
 * je gedruckte Spalte, null = leer.
 */
const readGridRows = async (
    image: { data: string; mimeType: string },
    grid: GridColumn[],
): Promise<{ rows: Array<Array<string | null>>; usage: GptUsage }> => {
    const columnList = grid
        .map((column, index) => `${index + 1}. "${column.header || '(no header)'}" → field "${column.field}"`
            + `${column.firstValue ? `, first value "${column.firstValue}"` : ''}`)
        .join('\n');
    const body = {
        model: MODEL(),
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: {
            type: 'json_schema',
            json_schema: { name: 'document_grid', strict: true, schema: buildGridSchema(grid) },
        },
        messages: [
            { role: 'system', content: GRID_PROMPT },
            {
                role: 'user',
                content: [
                    { type: 'text', text: `The table has ${grid.length} columns, left to right:\n${columnList}\n\nTranscribe it row by row into the grid.` },
                    imagePart(image),
                ],
            },
        ],
    };
    const { parsed, usage } = await callChatCompletion(body, 'grid-rows');
    const raw: any[] = Array.isArray(parsed?.rows) ? parsed.rows : [];
    /* Die Kopfzeile ist keine Position. Schreibt das Modell sie doch ab —
       oder steht sie auf dem Blatt ein zweites Mal —, faellt sie hier weg. */
    const headerLine = grid.map((column) => foldName(column.header)).join('|');
    const rows: Array<Array<string | null>> = [];
    for (const entry of raw) {
        const cells = grid.map((column) => gridCell(entry?.[column.field]));
        if (cells.every((cell) => cell === null)) continue;
        if (cells.map((cell) => foldName(cell ?? '')).join('|') === headerLine) continue;
        rows.push(cells);
    }
    return { rows, usage };
};

/**
 * WELCHE GEDRUCKTE SPALTE WELCHE VORLAGENSPALTE IST — ohne Modell.
 *   1. Derselbe Name: die Vorlage wird nach dem Blatt benannt, also ist
 *      «Toplam Adet» die Spalte «Toplam Adet». Stehen zwei gleiche
 *      Ueberschriften da, entscheidet der Vorschlag des Modells.
 *   2. Der Vorschlag des Modells — es kennt die Bedeutung der Zuordnung
 *      («Menge» heisst auf dem Blatt auch «Qty» oder «Stk.»).
 *   3. Ein aehnlicher Name (mindestens die Haelfte der Woerter gleich).
 * Keine gedruckte Spalte wird zweimal vergeben. Was nirgends passt, bleibt
 * null: die Spalte bleibt dann leer, statt eine fremde zu zeigen.
 * Rueckgabe: Vorlagenschluessel → Index in `grid` (0-basiert) oder null.
 */
export const resolveGridMapping = (
    columns: TemplateColumn[],
    grid: Array<{ header: string }>,
    suggested: Record<string, number>,
): Record<string, number | null> => {
    const taken = new Set<number>();
    const result: Record<string, number | null> = {};
    const headers = grid.map((column) => foldName(column.header));
    const claim = (key: string, index: number) => { result[key] = index; taken.add(index); };

    for (const column of columns) {
        const wanted = foldName(column.name);
        if (!wanted) continue;
        const hits = headers
            .map((header, index) => (header === wanted && !taken.has(index) ? index : -1))
            .filter((index) => index >= 0);
        if (!hits.length) continue;
        const proposal = suggested[column.key] ?? -1;
        claim(column.key, hits.includes(proposal) ? proposal : hits[0]!);
    }
    for (const column of columns) {
        if (column.key in result) continue;
        const proposal = suggested[column.key] ?? -1;
        if (proposal >= 0 && proposal < grid.length && !taken.has(proposal)) claim(column.key, proposal);
    }
    for (const column of columns) {
        if (column.key in result) continue;
        const wanted = new Set(foldName(column.name).split(' ').filter(Boolean));
        let best = -1;
        let bestScore = 0;
        headers.forEach((header, index) => {
            if (taken.has(index) || !wanted.size) return;
            const words = header.split(' ').filter(Boolean);
            if (!words.length) return;
            const score = words.filter((word) => wanted.has(word)).length / Math.max(words.length, wanted.size);
            if (score > bestScore) { bestScore = score; best = index; }
        });
        if (best >= 0 && bestScore >= 0.5) claim(column.key, best);
        else result[column.key] = null;
    }
    return result;
};

/** Eine Rasterzeile → eine Zeile der Vorlage (Zahlenspalten als Zahl). */
export const gridRowToTemplate = (
    columns: TemplateColumn[],
    cells: Array<string | null>,
    mapping: Record<string, number | null>,
): Record<string, string | number | null> => {
    const row: Record<string, string | number | null> = {};
    for (const column of columns) {
        const index = mapping[column.key];
        const cell = index === null || index === undefined ? null : cells[index] ?? null;
        row[column.key] = cell === null ? null : column.type === 'number' ? (parsePrintedNumber(cell) ?? cell) : cell;
    }
    return row;
};

/* ── WAS NICHT HALF (11.09.2026, gemessen, bitte nicht wieder einbauen) ────
   Nach dem Raster blieb am Blatt vom 08.09. genau EIN Fehler: in der Zeile
   «Harmony XB4 …» ist die Typnummer leer und ZBY9320 steht unter der
   Bestellnummer — das Raster schreibt ZBY9320 unter die Typnummer. Drei
   Versuche, das zu richten, machten es jeweils SCHLECHTER:
     · ein dritter Blick, der jede Luecke einzeln fragt («steht ZBY9320 unter
       Spalte 3 oder 4?», Antwort als `enum`): gpt-4.1-mini antwortete in
       derselben Zeile falsch und schob zusaetzlich «SE» in die leere Zelle
       (301 statt 302 von 304). Auf Einzelfragen nach der Lage antwortet das
       Modell schlechter, als es abschreibt — auch bei Zellen, die das Raster
       richtig hatte (M4190).
     · dieselben Fragen an einen AUSSCHNITT nur der fraglichen Spalten: 4 von
       5 falsch.
     · staerkere Modelle: gpt-4.1 verkleinert die Seite auf 768 px Hoehe und
       verlor eine ganze Zeile; gpt-5.4-mini 299/304, gpt-5-mini brach nach
       der Haelfte ab.
   Das Raster mit gpt-4.1-mini ist damit das Beste, was gemessen wurde. */

export interface GptGridPage {
    /** Eine Zeile je gedruckter Position, Schluessel = Vorlagenspalte. */
    rows: Array<Record<string, string | number | null>>;
    /** Die Tabelle, wie sie auf dem Blatt steht: alle Spalten, null = leere Zelle. */
    grid: { headers: string[]; rows: Array<Array<string | null>> };
    /** Vorlagenschluessel → Spalte in `grid.headers` (0-basiert), null = nicht gefunden. */
    mapping: Record<string, number | null>;
    usage: GptUsage;
}

/**
 * Die Aufnahmen eines Belegs lesen, in ihrer Reihenfolge. Die erste
 * Aufnahme gibt ihre Spalten an die folgenden weiter; sonst laeuft alles
 * gleichzeitig — jedes Raster wartet nur auf seinen eigenen Kopf.
 */
export const readImagePages = async (
    images: Array<{ data: string; mimeType: string }>,
    columnsInput: TemplateColumn[],
): Promise<GptGridPage[]> => {
    const columns = normalizeColumns(columnsInput);
    if (columns.length < TEMPLATE_MIN_COLUMNS) {
        throw new GptError(`Die Vorlage braucht mindestens ${TEMPLATE_MIN_COLUMNS} Spalten.`, 'GPT_TOO_FEW_COLUMNS', 400);
    }
    if (!images.length) return [];
    const firstHead = readGridHead(images[0]!, columns, null);
    const heads = images.map((image, index) => (index === 0
        ? firstHead
        : firstHead.then((head) => readGridHead(image, columns, head.columns.map((column) => column.header)))));
    return Promise.all(images.map(async (image, index): Promise<GptGridPage> => {
        const head = await heads[index]!;
        const mapping = resolveGridMapping(columns, head.columns, head.suggested);
        if (!head.columns.length) {
            return { rows: [], grid: { headers: [], rows: [] }, mapping, usage: head.usage };
        }
        const read = await readGridRows(image, head.columns);
        /* Eine Zeile, die in KEINER Vorlagenspalte etwas traegt, gibt keine
           Bestellzeile her — im Raster bleibt sie trotzdem stehen. */
        const rows = read.rows
            .map((cells) => gridRowToTemplate(columns, cells, mapping))
            .filter((row) => Object.values(row).some((value) => value !== null));
        return {
            rows,
            grid: { headers: head.columns.map((column) => column.header), rows: read.rows },
            mapping,
            usage: addUsages(head.usage, read.usage),
        };
    }));
};

/* ═══════════════════════════════════════════════════════════════════════
   DER TEXTWEG — PDF-Textlage und Excel
   ═══════════════════════════════════════════════════════════════════════ */

export interface GptExtractInput {
    /** Der Text des Belegs (Tabulator = Spaltengrenze). */
    text: string;
    /** DIE SPALTEN DER VORLAGE — sie werden zum Antwortschema. */
    columns: TemplateColumn[];
    /** Zielsprache der Textwerte: 'de' | 'en' | 'tr'. */
    language: string;
    /** False for goods receipt: supplier/order identity is already known. */
    includeDocumentHeader?: boolean;
}

export interface GptExtractResult {
    model: string;
    supplierName: string | null;
    documentNumber: string | null;
    documentDate: string | null;
    currency: string | null;
    vatRate: number | null;
    totalNet: number | null;
    rows: Array<Record<string, unknown>>;
    usage: GptUsage;
}

/**
 * EINEN Textblock lesen lassen. Für lange Belege ruft die Route diese Funktion
 * mehrfach auf (ein Stück je Aufruf) und führt die Positionen zusammen.
 */
export const extractWithGpt = async (input: GptExtractInput): Promise<GptExtractResult> => {
    if (!String(input.text || '').trim()) {
        throw new GptError('Der Beleg enthält keinen lesbaren Inhalt.', 'GPT_EMPTY_INPUT', 422);
    }
    const columns = normalizeColumns(input.columns);
    if (columns.length < TEMPLATE_MIN_COLUMNS) {
        throw new GptError(`Die Vorlage braucht mindestens ${TEMPLATE_MIN_COLUMNS} Spalten.`, 'GPT_TOO_FEW_COLUMNS', 400);
    }

    const model = MODEL();
    const body = {
        model,
        // Ein Beleg ist kein Ort für Einfälle: dieselbe Seite muss zweimal
        // dasselbe ergeben.
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'supplier_document',
                strict: true,
                schema: buildSchema(columns, input.includeDocumentHeader !== false),
            },
        },
        messages: [
            { role: 'system', content: systemPrompt(input.language) },
            { role: 'user', content: input.text },
        ],
    };

    const { parsed, usage } = await callChatCompletion(body, 'text');
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    return {
        model,
        supplierName: parsed?.supplierName ?? null,
        documentNumber: parsed?.documentNumber ?? null,
        documentDate: parsed?.documentDate ?? null,
        currency: parsed?.currency ?? null,
        vatRate: Number.isFinite(Number(parsed?.vatRate)) ? Number(parsed.vatRate) : null,
        totalNet: Number.isFinite(Number(parsed?.totalNet)) ? Number(parsed.totalNet) : null,
        rows,
        usage,
    };
};
