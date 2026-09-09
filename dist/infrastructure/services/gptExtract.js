"use strict";
/**
 * DAS SPRACHMODELL HINTER DER LIEFERANTENBESTELLUNG (07.09.2026)
 *
 * Vorgabe Samet: «Ein PDF oder ein Bild, der Text geht an das Modell — GPT-4o
 * mini oder 4o, ich will die günstige Möglichkeit —, zurück kommt JSON nach
 * unserer Vorlage. Es soll NUR das herausziehen, was in der Vorlage steht.
 * Sprache und Aufbau des Belegs dürfen sich ändern, das Ziel bleibt gleich.»
 *
 * ── WARUM ÜBER DEN SERVER ───────────────────────────────────────────────
 * Wie bei Google Vision: der Schlüssel darf nicht im Browser-Bündel liegen.
 * Wer die Seite öffnet, könnte ihn sonst lesen und auf unsere Rechnung
 * rechnen lassen. Die Anwendung schickt den TEXT hierher, und erst von hier
 * geht er zu OpenAI.
 *
 * ── DIE VORLAGE ─────────────────────────────────────────────────────────
 * Eine Vorlage ist in diesem Modul nichts als eine LISTE VON SPALTEN-
 * ÜBERSCHRIFTEN — vier bis acht, vom Anwender selbst benannt. Aus ihnen wird
 * das Antwortschema gebaut, das dem Modell mitgegeben wird
 * (`response_format: json_schema`, `strict: true`). Das hat zwei Wirkungen,
 * und beide sind der Grund, warum es so und nicht als freier Text gemacht ist:
 *   1. Das Modell KANN nichts anderes zurückgeben als diese Spalten — es
 *      erfindet keine Felder, und wir müssen nichts nachparsen.
 *   2. Jede nicht angelegte Spalte kostet keine Ausgabe-Token. Die Vorlage ist
 *      also zugleich die Sparbremse.
 *
 * ── WAS DAS KOSTET ──────────────────────────────────────────────────────
 * gpt-4o-mini: 0.15 $ je Mio. Eingabe-Token, 0.60 $ je Mio. Ausgabe-Token.
 * Eine zweiseitige Bestellung sind rund 2'000 Eingabe- und 1'000 Ausgabe-Token
 * — also etwa 0.09 Rappen. Die Antwort trägt die tatsächliche Nutzung mit
 * (`usage`), damit auf dem Schirm steht, was der Vorgang gekostet hat, statt
 * dass es jemand raten muss.
 *
 * ── EINRICHTUNG ─────────────────────────────────────────────────────────
 *   gptApi   = der OpenAI-Schlüssel (sk-…)            ← Pflicht
 *   gptModel = das Modell, Vorgabe `gpt-4o-mini`      ← optional
 * Fehlt `gptApi`, meldet `gptConfigured()` false und die Route antwortet 503
 * mit `code: 'GPT_NOT_CONFIGURED'` — die Anwendung sagt dann sauber, dass die
 * Erkennung nicht eingerichtet ist, statt still nichts zu tun.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractWithGpt = exports.SOURCE_LINE_FIELD = exports.TIER_FIELD = exports.normalizeColumns = exports.TEMPLATE_MAX_COLUMNS = exports.TEMPLATE_MIN_COLUMNS = exports.GptError = exports.gptModelName = exports.gptConfigured = void 0;
const API_KEY = () => String(
// Der Name, den Samet vorgegeben hat, steht zuerst; die beiden anderen sind
// nur Ausweichnamen für Umgebungen, die kleingeschriebene Variablen
// unschön finden.
process.env.gptApi ?? process.env.GPT_API ?? process.env.OFFITEC_GPT_API_KEY ?? '').trim();
const MODEL = () => String(process.env.gptModel ?? process.env.GPT_MODEL ?? 'gpt-4o-mini').trim();
const ENDPOINT = () => String(process.env.gptEndpoint ?? process.env.GPT_ENDPOINT ?? 'https://api.openai.com/v1/chat/completions').trim();
const TIMEOUT_MS = Number(process.env.gptTimeoutMs || 90_000);
/** Steht der Schlüssel? Ohne ihn hat die Route nichts zu tun. */
const gptConfigured = () => API_KEY().length > 0;
exports.gptConfigured = gptConfigured;
/** Welches Modell gerade arbeitet — die Oberfläche zeigt es an. */
const gptModelName = () => MODEL();
exports.gptModelName = gptModelName;
class GptError extends Error {
    code;
    status;
    detail;
    constructor(message, code, status, detail) {
        super(message);
        this.code = code;
        this.status = status;
        this.detail = detail;
    }
}
exports.GptError = GptError;
exports.TEMPLATE_MIN_COLUMNS = 4;
/**
 * Die feste Ausstattung sind sechs Spalten (Code, Bezeichnung, Menge, Preis,
 * Rabatt 1, Rabatt 2), dazu bis zu drei eigene — zwoelf laesst Luft nach oben,
 * ohne dass eine Anfrage ins Uferlose waechst.
 */
exports.TEMPLATE_MAX_COLUMNS = 12;
/**
 * Ein Schluessel ist ein schlichter Bezeichner: ein Buchstabe, dann Buchstaben
 * oder Ziffern.
 *
 * ⚠ GROSSBUCHSTABEN GEHOEREN DAZU. Am 07.09.2026 stand hier `[a-z0-9]`, und
 * damit fielen `priceGross` und `priceNet` still durch die Pruefung: die
 * Antwort kam mit 200 zurueck, aber ohne Preise — die Bestellung war leer und
 * niemand sah, warum. Was hier nicht durchkommt, verschwindet OHNE Fehler,
 * also muss die Form grosszuegig sein und die Pruefung woanders zubeissen
 * (Mindestzahl der Spalten, siehe unten).
 */
const COLUMN_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,15}$/;
/**
 * Die Spalten einer Anfrage pruefen. Was hier nicht durchkommt, geht auch
 * nicht an das Modell: fremde Schluessel, leere Namen, Doppelte, und alles
 * jenseits der achten Spalte.
 */
const normalizeColumns = (raw) => {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const columns = [];
    for (const entry of list) {
        const key = String(entry?.key ?? '').trim();
        const name = String(entry?.name ?? '').trim().slice(0, 60);
        if (!COLUMN_KEY.test(key) || !name || seen.has(key))
            continue;
        seen.add(key);
        columns.push({ key, name, type: entry?.type === 'number' ? 'number' : 'text' });
        if (columns.length >= exports.TEMPLATE_MAX_COLUMNS)
            break;
    }
    return columns;
};
exports.normalizeColumns = normalizeColumns;
/**
 * MENGENSTAFFEL. Vorgabe Samet: «Die Werte aendern sich je nach Menge, das
 * System muss den passenden nehmen, sobald die Menge gewaehlt ist.» Steht auf
 * dem Beleg eine Staffel («ab 10 Stk 17.50»), wandert sie als eigene Liste an
 * die Position. Kostet nur dort Token, wo sie angefordert wird.
 */
exports.TIER_FIELD = 'priceTiers';
/**
 * ── DER ZEILENANKER ─────────────────────────────────────────────────────────
 * Fehlerbild Samet (08.09.2026): «Im Bild ordnet es vieles falsch zu, jedes
 * Produkt landet an der falschen Stelle. Die Zuordnung muss ZEILE FÜR ZEILE
 * geschehen; wenn die Ausgabe durcheinander ist, muss zeilenweise kopiert
 * werden.»
 *
 * Das ist genau das, was dieses Feld erzwingt. Es steht als ERSTE Eigenschaft
 * der Zeile, und diese Reihenfolge ist die ganze Wirkung: das Modell schreibt
 * seine Antwort Feld für Feld in der Reihenfolge des Schemas, muss also die
 * gedruckte Zeile ABSCHREIBEN, bevor es sie in Spalten zerlegt. Danach hat es
 * die eine Zeile vor sich, aus der jeder Wert der Position stammen darf —
 * statt über die ganze Seite zu greifen und den Preis der Nachbarzeile zu
 * erwischen.
 *
 * Der Anker kostet Ausgabe-Token (grob 15 je Position, also gut ein halber
 * Rappen auf eine ganze Bestellung). Eine Bestellung, in der die Preise um
 * eine Zeile verrutscht sind, kostet mehr: sie sieht richtig aus.
 */
exports.SOURCE_LINE_FIELD = 'sourceLine';
/* ── Antwortschema bauen ──────────────────────────────────────────────────
   `strict: true` verlangt, dass JEDE Eigenschaft in `required` steht und
   `additionalProperties: false` gesetzt ist. «Nicht gefunden» wird deshalb
   nicht durch Weglassen ausgedrueckt, sondern durch `null` — darum traegt jedes
   Feld seinen Typ UND `null`. */
const buildSchema = (columns, withTiers) => {
    const properties = {};
    /* ZUERST der Anker, dann die Spalten — die Reihenfolge IST die Wirkung
       (siehe `SOURCE_LINE_FIELD`): erst abschreiben, dann zerlegen. */
    properties[exports.SOURCE_LINE_FIELD] = {
        type: ['string', 'null'],
        description: 'The complete printed line of this position, copied verbatim from the document, '
            + 'including its continuation lines. Every other field of this row must be taken from THIS line only',
    };
    for (const column of columns) {
        properties[column.key] = {
            type: [column.type === 'number' ? 'number' : 'string', 'null'],
            /* Die ROLLE schlaegt den Spaltennamen. Ein blosses
               «Column "Nettopreis"» sagte dem Modell nicht, worin sich Brutto
               und Netto unterscheiden — es schrieb dieselbe Zahl in beide
               Felder (Fehlerbild Samet, 07.09.2026: «Brutto und Netto kommen
               gleich heraus»). Mit der Rolle weiss es, dass eines der
               Listenpreis VOR Rabatt und das andere der Preis DANACH ist. */
            description: ROLE_HINTS[column.key]
                ? `${ROLE_HINTS[column.key]} (document column: "${column.name}")`
                : `Column "${column.name}" of the position`,
        };
    }
    if (withTiers) {
        properties[exports.TIER_FIELD] = {
            type: ['array', 'null'],
            description: 'Quantity price breaks of this line, if the document shows any',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    minQuantity: { type: 'number', description: 'Lowest quantity this price applies to' },
                    unitPrice: { type: 'number', description: 'Price per unit at that quantity' },
                },
                required: ['minQuantity', 'unitPrice'],
            },
        };
    }
    const rowKeys = Object.keys(properties);
    return {
        type: 'object',
        additionalProperties: false,
        properties: {
            /* Kopfdaten des Belegs. Sie kosten zusammen ein paar Dutzend Token
               und ersparen der Anwendung das Raten, welcher Lieferant, welche
               Waehrung und welcher Steuersatz gemeint sind. */
            supplierName: { type: ['string', 'null'], description: 'Company that issued the document' },
            documentNumber: { type: ['string', 'null'], description: 'Offer / order number on the document' },
            documentDate: { type: ['string', 'null'], description: 'Date on the document, ISO yyyy-mm-dd' },
            currency: { type: ['string', 'null'], description: 'ISO currency code, e.g. CHF, EUR' },
            vatRate: { type: ['number', 'null'], description: 'VAT percentage of the whole document' },
            totalNet: { type: ['number', 'null'], description: 'Net total of the document' },
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
        required: ['supplierName', 'documentNumber', 'documentDate', 'currency', 'vatRate', 'totalNet', 'rows'],
    };
};
/* ── WAS DIE FESTEN FELDER BEDEUTEN ───────────────────────────────────────
   Die Anwendung schickt nur Spaltennamen; die Bedeutung steht hier. Ohne sie
   raet das Modell — und riet bei zwei Preisspalten zweimal dieselbe Zahl. */
const ROLE_HINTS = {
    code: 'Article or catalogue number of the item, exactly as printed',
    name: 'Description of the item',
    quantity: 'Ordered quantity as a plain number, without the unit',
    priceGross: 'The MATERIAL price of one unit as printed in the price column - the list price BEFORE any discount. In the worked example below this is 78.10. Never put a discounted price, a line amount or a total here',
    priceNet: 'The price of one unit AFTER the discount. It is always LOWER than the gross price whenever a discount exists, and equal to it only when there is none. In the worked example this is 42.67',
    discount: 'The discount PERCENTAGE of this line as a positive number, even when the document prints it with a minus sign: "-45.36" means 45.36. Use 0 when the line has no discount',
    discount2: 'A second discount percentage applied after the first, positive, 0 if none',
    lineTotal: 'Amount of the whole line: quantity * the NET unit price - never the gross one. Take the printed line amount when the document shows one, otherwise compute it. It never contains VAT',
};
/* ── Die Anweisung ────────────────────────────────────────────────────────
   Englisch, weil dieselbe Anweisung auf Englisch rund ein Drittel weniger
   Token braucht als auf Deutsch — und das Modell die Zielsprache trotzdem
   sauber trifft. Die AUSGABE ist deutsch/englisch/tuerkisch, je nachdem,
   welche Sprache die Anwendung gerade traegt. */
const LANGUAGE_NAMES = {
    de: 'German',
    en: 'English',
    tr: 'Turkish',
};
/**
 * Was dem Modell zum BILD gesagt wird. Die eigentliche Anweisung steht schon
 * in `systemPrompt`; dieser Satz sagt nur, dass die Quelle diesmal eine Seite
 * ist und nicht ein Textauszug.
 */
const IMAGE_TASK = 'Read the supplier document in this image and return its order positions, following the rules above. '
    + 'Work down the position table one printed row at a time and stay inside the row you are on.';
const systemPrompt = (language) => {
    const target = LANGUAGE_NAMES[language] ?? LANGUAGE_NAMES.de;
    return [
        'Read the supplier document text and return its order positions.',
        'Each field is named after a column of the order; take the value that belongs to that column.',
        /* ── ZEILE FÜR ZEILE ───────────────────────────────────────────────
           Fehlerbild Samet (08.09.2026): «Im Bild ordnet es vieles falsch zu,
           jedes Produkt landet an der falschen Stelle. Die Zuordnung muss
           ZEILE FÜR ZEILE geschehen.»

           Ein Beleg ist eine Tabelle, und eine Tabelle wird spaltenweise
           falsch gelesen: das Modell sammelt erst alle Artikelnummern, dann
           alle Preise, und schiebt sie am Ende zusammen — verrutscht dabei
           eine Spalte um eine Zeile, trägt JEDE Position von da an den Preis
           ihrer Nachbarin, und die Bestellung sieht trotzdem plausibel aus.

           Dagegen steht hier eine einzige Arbeitsweise: eine Zeile
           abschreiben, diese Zeile zerlegen, zur nächsten gehen. Der Anker
           (`sourceLine`) macht sie nachprüfbar, diese Sätze machen sie
           verbindlich. Beides zusammen, nicht eines davon. */
        'Work through the document ONE POSITION LINE AT A TIME, from top to bottom, in the printed order.',
        `For each position, first copy its whole printed line verbatim into "${exports.SOURCE_LINE_FIELD}" (including any continuation line that belongs to it), and only then split THAT line into the fields.`,
        'Every value of a row must come from that row\'s own line. Never take a value from the line above or below, never carry a value over from the previous position, and never collect a column top-down across the document.',
        'If a line does not show a value, that field is null for this position - do not fill the gap from a neighbouring line.',
        'Return the positions in the order they are printed, one entry per printed position, and never reorder them.',
        /* Die Übersetzung darf den Anker NICHT anfassen: er ist der Beleg
           selbst und die einzige Stelle, an der sich nachsehen lässt, woher
           ein Wert stammt. Übersetzt reicht er dafür nicht mehr. */
        `Write every text value in ${target}; translate names that are in another language. The one exception is "${exports.SOURCE_LINE_FIELD}": it is never translated, shortened or tidied - it is the document's own wording.`,
        'Keep article numbers, codes and units exactly as printed.',
        'Numbers: plain decimals with a dot, no thousand separators, no currency symbol, no percent sign.',
        'Percentages are numbers: 7.5 means 7.5%.',
        /* ── DIE PREISREGEL, MIT EINEM DURCHGERECHNETEN BEISPIEL ───────────
           Fehlerbild Samet (08.09.2026): «Das Modell bestimmt den Bruttopreis
           falsch. Der Bruttopreis IST der Materialpreis, also 78.10. Wenn der
           Rabatt -45.36 ist, dann ist der Preis der Nettopreis, 42.67, und die
           Zeilensumme rechnet ebenfalls mit dem Nettopreis. Die Mehrwertsteuer
           kommt ganz am Schluss auf die Zeilensummen.»

           Ein Beispiel mit echten Zahlen wirkt hier deutlich besser als eine
           weitere Regel in Worten: es legt zugleich fest, dass -45.36 ein
           PROZENTSATZ ist (78.10 × 0.5464 = 42.67) und kein Frankenbetrag —
           78.10 − 45.36 waere 42.74 und damit knapp daneben.

           Die Regel steht bewusst zweimal, hier und in ROLE_HINTS: das Modell
           fuellte sonst beide Preisfelder mit derselben Zahl, und eine
           Bestellung mit Brutto = Netto sieht plausibel aus, ist aber um den
           ganzen Rabatt falsch. */
        'Price logic of one position, in this order:',
        '(1) the gross price is the material list price of one unit, before discount;',
        '(2) the discount is a PERCENTAGE, positive even when printed with a minus sign;',
        '(3) the net price is the unit price after that discount: net = gross * (1 - discount/100);',
        '(4) the line total is quantity * net price, never quantity * gross price;',
        '(5) VAT is not part of any of these - it is applied at the very end, on the sum of the line totals, so never add it to a price or to a line total.',
        'Worked example: gross 78.10 with a printed discount of -45.36 gives discount 45.36, net 42.67 and, for quantity 1, a line total of 42.67.',
        'Gross and net are equal only when the line truly has no discount. Otherwise derive the missing one from the other - never copy the same number into both.',
        'Skip totals, subtotals, delivery terms, headers and footers - only real positions.',
        'A value that is not on the document is null. Never guess or invent.',
    ].join(' ');
};
/* ── Preisliste je Modell ────────────────────────────────────────────────
   Nur zur ANZEIGE. Sie ist eine Momentaufnahme (07.09.2026) und darf veralten;
   ein unbekanntes Modell bekommt darum keine geschätzten Kosten, sondern
   `null` — lieber keine Zahl als eine falsche. */
const PRICE_PER_MILLION = {
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'gpt-4o': { input: 2.5, output: 10 },
    'gpt-4.1-mini': { input: 0.4, output: 1.6 },
    'gpt-4.1-nano': { input: 0.1, output: 0.4 },
};
const usageOf = (raw, model) => {
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
/**
 * EINEN Textblock lesen lassen. Für lange Belege ruft die Route diese Funktion
 * mehrfach auf (ein Stück je Aufruf) und führt die Positionen zusammen.
 */
const extractWithGpt = async (input) => {
    const key = API_KEY();
    if (!key)
        throw new GptError('Die KI-Erkennung ist nicht eingerichtet.', 'GPT_NOT_CONFIGURED', 503);
    const model = MODEL();
    if (!input.image && !String(input.text || '').trim()) {
        throw new GptError('Der Beleg enthält keinen lesbaren Inhalt.', 'GPT_EMPTY_INPUT', 422);
    }
    const columns = (0, exports.normalizeColumns)(input.columns);
    if (columns.length < exports.TEMPLATE_MIN_COLUMNS) {
        throw new GptError(`Die Vorlage braucht mindestens ${exports.TEMPLATE_MIN_COLUMNS} Spalten.`, 'GPT_TOO_FEW_COLUMNS', 400);
    }
    const body = {
        model,
        // Ein Beleg ist kein Ort für Einfälle: dieselbe Seite muss zweimal
        // dasselbe ergeben.
        temperature: 0,
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'supplier_document',
                strict: true,
                schema: buildSchema(columns, Boolean(input.withTiers)),
            },
        },
        messages: [
            { role: 'system', content: systemPrompt(input.language) },
            /* Ein Bild reist als Inhaltsteil, Text als schlichte Zeichenkette.
               `detail: 'high'` ist hier nicht sparsam, sondern nötig: bei
               `low` schrumpft die Seite auf 512px und die Rappenstellen einer
               Preisspalte sind schlicht nicht mehr lesbar. */
            input.image
                ? {
                    role: 'user',
                    content: [
                        { type: 'text', text: IMAGE_TASK },
                        {
                            type: 'image_url',
                            image_url: {
                                url: `data:${input.image.mimeType};base64,${input.image.data}`,
                                detail: 'high',
                            },
                        },
                    ],
                }
                : { role: 'user', content: input.text },
        ],
    };
    let response;
    try {
        response = await fetch(ENDPOINT(), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${key}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    }
    catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        throw new GptError(timedOut ? 'Die KI-Erkennung hat zu lange gebraucht.' : 'Die KI-Erkennung ist nicht erreichbar.', timedOut ? 'GPT_TIMEOUT' : 'GPT_UNREACHABLE', 504);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const message = String(payload?.error?.message || '').slice(0, 400);
        console.error('[gptExtract] OpenAI antwortete', response.status, message || '(ohne Grund)');
        /* Die drei Fälle, die NICHT am Beleg liegen, sondern am Konto — sie
           müssen sich anders anfühlen als «der Beleg wurde abgelehnt», sonst
           sucht jemand den Fehler stundenlang bei seinem PDF. */
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
        throw new GptError('Der Beleg ist für einen Durchgang zu lang. Bitte weniger Seiten aufs Mal hochladen.', 'GPT_TRUNCATED', 422);
    }
    if (choice?.message?.refusal) {
        throw new GptError('Die KI-Erkennung hat den Beleg abgelehnt.', 'GPT_REFUSED', 422, String(choice.message.refusal).slice(0, 300));
    }
    let parsed;
    try {
        parsed = JSON.parse(String(choice?.message?.content ?? ''));
    }
    catch {
        throw new GptError('Die Antwort der KI war nicht lesbar.', 'GPT_BAD_JSON', 502);
    }
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
        usage: usageOf(payload?.usage, model),
    };
};
exports.extractWithGpt = extractWithGpt;
//# sourceMappingURL=gptExtract.js.map