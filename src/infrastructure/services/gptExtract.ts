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
 * darin, eine Tabelle spaltentreu zu lesen — und genau daran hing das
 * Fehlerbild. Es kostet 0.40 $ / 1.60 $ je Million (gegen 0.15 $ / 0.60 $),
 * also rund das Zweieinhalbfache: bei einem Beleg mit 35 Positionen sind das
 * etwa 0.008 $ statt 0.003 $. Eine einzige Position, die in der falschen
 * Spalte landet, kostet mehr Zeit, als dieser Unterschied je Geld kostet.
 *
 * `gptModel` in der Umgebung schlägt diese Vorgabe weiterhin.
 */
const MODEL = (): string => String(process.env.gptModel ?? process.env.GPT_MODEL ?? 'gpt-4.1-mini').trim();

const ENDPOINT = (): string => String(
    process.env.gptEndpoint ?? process.env.GPT_ENDPOINT ?? 'https://api.openai.com/v1/chat/completions',
).trim();

/**
 * ── WIE LANGE EIN BELEG BRAUCHEN DARF ───────────────────────────────────
 * 90 s waren zu knapp, und zwar messbar: ein Beleg mit 35 Positionen ergibt
 * rund 2'900 Ausgabe-Token — bei den ueblichen 50-110 Token je Sekunde sind
 * das 26-58 s allein fuer das Schreiben, dazu kommt das Bild. Ein dichter
 * Beleg lag damit auf der Grenze, und was darueber ging, brach ab.
 *
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
   Vorgabe Samet (07.09.2026): «In der Vorlage muessen eigene Spaltennamen
   hinzugefuegt werden koennen — bis zu acht. Was an GPT geht, muessen die
   Spaltenueberschriften sein, mindestens vier, hoechstens acht.»

   Darum gibt es hier KEINEN festen Katalog mehr. Der Aufrufer schickt die
   Spalten seiner Vorlage, und aus ihnen wird das Antwortschema gebaut: der
   stabile Schluessel (`c1` …) wird der Feldname, der vom Anwender vergebene
   NAME wird die Beschreibung, an der das Modell die Spalte im Beleg erkennt.

   Zwei Wirkungen, und beide sind der Grund fuer diesen Aufbau:
     1. Das Modell KANN nichts anderes zurueckgeben als diese Spalten — es
        erfindet keine Felder, und wir muessen nichts nachparsen.
     2. Jede nicht angelegte Spalte kostet keine Ausgabe-Token. Die Vorlage ist
        also zugleich die Sparbremse. */

export type ColumnType = 'text' | 'number';

export interface TemplateColumn {
    /** Stabiler Bezug: c1 … c8. Er wird der Feldname im Schema. */
    key: string;
    /** Der Name, den der Anwender vergeben hat — die Beschreibung im Schema. */
    name: string;
    type: ColumnType;
}

export const TEMPLATE_MIN_COLUMNS = 1;
/**
 * Die feste Ausstattung sind sechs Spalten (Code, Bezeichnung, Menge, Preis,
 * Rabatt 1, Rabatt 2), dazu bis zu drei eigene — zwoelf laesst Luft nach oben,
 * ohne dass eine Anfrage ins Uferlose waechst.
 */
export const TEMPLATE_MAX_COLUMNS = 12;

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
export const normalizeColumns = (raw: unknown): TemplateColumn[] => {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set<string>();
    const columns: TemplateColumn[] = [];
    for (const entry of list) {
        const key = String((entry as any)?.key ?? '').trim();
        const name = String((entry as any)?.name ?? '').trim().slice(0, 60);
        if (!COLUMN_KEY.test(key) || !name || seen.has(key)) continue;
        seen.add(key);
        columns.push({ key, name, type: (entry as any)?.type === 'number' ? 'number' : 'text' });
        if (columns.length >= TEMPLATE_MAX_COLUMNS) break;
    }
    return columns;
};

/**
 * MENGENSTAFFEL. Vorgabe Samet: «Die Werte aendern sich je nach Menge, das
 * System muss den passenden nehmen, sobald die Menge gewaehlt ist.» Steht auf
 * dem Beleg eine Staffel («ab 10 Stk 17.50»), wandert sie als eigene Liste an
 * die Position. Kostet nur dort Token, wo sie angefordert wird.
 */
export const TIER_FIELD = 'priceTiers';

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
export const SOURCE_LINE_FIELD = 'sourceLine';

/* ── Antwortschema bauen ──────────────────────────────────────────────────
   `strict: true` verlangt, dass JEDE Eigenschaft in `required` steht und
   `additionalProperties: false` gesetzt ist. «Nicht gefunden» wird deshalb
   nicht durch Weglassen ausgedrueckt, sondern durch `null` — darum traegt jedes
   Feld seinen Typ UND `null`. */

const buildSchema = (columns: TemplateColumn[], withTiers: boolean, includeDocumentHeader = true) => {
    const properties: Record<string, unknown> = {};
    /* ZUERST der Anker, dann die Spalten — die Reihenfolge IST die Wirkung
       (siehe `SOURCE_LINE_FIELD`): erst abschreiben, dann zerlegen. */
    properties[SOURCE_LINE_FIELD] = {
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
        properties[TIER_FIELD] = {
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
    const documentProperties = includeDocumentHeader ? {
        /* Kopfdaten des Belegs. Sie kosten zusammen ein paar Dutzend Token
           und ersparen der Anwendung das Raten, welcher Lieferant, welche
           Waehrung und welcher Steuersatz gemeint sind. */
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

/* ── WAS DIE FESTEN FELDER BEDEUTEN ───────────────────────────────────────
   Die Anwendung schickt nur Spaltennamen; die Bedeutung steht hier. Ohne sie
   raet das Modell — und riet bei zwei Preisspalten zweimal dieselbe Zahl. */
const ROLE_HINTS: Record<string, string> = {
    code: 'The item identifier of this row - the article number, product code, type number, type reference or catalogue number are ALL this one field; whichever of them the document prints, it goes here. Copied EXACTLY as printed and in full. It is not necessarily a number: it may be a catalogue number, a type reference containing letters, dots, slashes or dashes, or even a complete URL. Copy the whole string - never shorten it, never drop a prefix or a suffix, never tidy it',
    name: 'The item description of this row, copied EXACTLY as printed, in full and character for character. Never translate it, never abbreviate a word, never shorten or summarise it: "TeSys Deca contactor - 3P(3 NO)" stays "TeSys Deca contactor - 3P(3 NO)" and never becomes "TeSys D contactor"',
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

const LANGUAGE_NAMES: Record<string, string> = {
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
    + 'Work down the position table one printed row at a time and stay inside the row you are on. '
    /* Eine Aufnahme wird von oben nach unten abgearbeitet, und die letzte
       Zeile ist die, die am ehesten fehlt: das Modell hoert auf, wenn die
       Liste "vollstaendig genug" aussieht. Darum steht die Zaehlung VOR
       der Ausgabe und der Schlusssatz noch einmal daneben. */
    + 'First count the position rows printed in the table, then transcribe every single one of them - '
    + 'including the very last row and any row whose cells are partly empty. Do not stop early.';

const systemPrompt = (language: string): string => {
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
        `For each position, first copy its whole printed line verbatim into "${SOURCE_LINE_FIELD}" (including any continuation line that belongs to it), and only then split THAT line into the fields.`,
        'Every value of a row must come from that row\'s own line. Never take a value from the line above or below, never carry a value over from the previous position, and never collect a column top-down across the document.',
        'If a line does not show a value, that field is null for this position - do not fill the gap from a neighbouring line.',
        /* ── DIE SPALTENGRENZE ─────────────────────────────────────────
           `compactText` liefert die Zeile jetzt mit Tabulatoren als
           Spaltengrenzen (Excel bringt sie schon so mit). Ohne diesen Satz
           weiss das Modell nicht, dass zwei Tabulatoren hintereinander eine
           LEERE Zelle sind — und schiebt den nächsten Wert nach links, um
           die Lücke zu füllen. Das ist die gemeldete Verschiebung. */
        'In the text form of the document a TAB separates two columns.',
        'Two tabs in a row mean the cell between them is EMPTY: that field is null, and the value after the gap keeps'
        + ' its own column. Never slide a value left into an empty cell, and never let an empty cell shift the rest of the row.',
        'Count the columns of every line from the left, gap by gap, and match them against the header line of the table.',
        'Return the positions in the order they are printed, one entry per printed position, and never reorder them.',
        /* ── EINE ZEILE DES BLATTES IST EINE ZEILE DER ANTWORT ─────────
           Die Zahl wird NICHT mehr gezaehlt und NICHT mehr angesagt
           (Vorgabe Samet, 08.09.2026: «so etwas wie 35 gibt es nicht, nimm
           das weg»). Sie ergibt sich: die Abschrift hat so viele Zeilen,
           wie sie hat, und die Zuordnung muss genau so viele liefern. Wer
           zaehlen will, zaehlt beide und vergleicht — dafuer braucht es
           keine Angabe von aussen. */
        'Return one entry per line of the table - no more, no fewer.',
        'A row belongs in the answer even when most of its cells are empty: an empty cell is null, an empty row is still a row.',
        'Never merge two printed rows into one entry, never split one printed row into two, and never leave out a row because it looks unimportant, repeats the row above, or continues it.',
        'The last printed row of the table matters as much as the first - do not stop before you reach it.',
        /* Die Übersetzung darf den Anker NICHT anfassen: er ist der Beleg
           selbst und die einzige Stelle, an der sich nachsehen lässt, woher
           ein Wert stammt. Übersetzt reicht er dafür nicht mehr. */
        /* ── ABSCHREIBEN, NICHT UEBERSETZEN ────────────────────────────
           Fehlerbild Samet (08.09.2026): «Wenn dort "TeSys Deca contactor
           - 3P(3 NO) - AC-3 - <= 440 V 9 A - 24 V DC coil" steht, dann
           muss genau das dastehen; es darf nicht "D" statt "Deca"
           schreiben und nichts abkuerzen.»

           Hier stand bis dahin das Gegenteil: «Write every text value in
           German; translate names that are in another language.» Damit war
           das Umschreiben der Artikelbezeichnung ausdruecklich VERLANGT —
           und ein Modell, das uebersetzen soll, kuerzt beim Uebersetzen.
           Eine Belegzeile ist kein Text, den man uebertraegt, sondern eine
           Angabe, die der Lieferant genau so bestellt haben will. Sie wird
           abgeschrieben. */
        'Every text value is a TRANSCRIPTION of what is printed, not a translation: copy it character for character,'
        + ' with its own wording, spelling, punctuation, spacing, capitalisation and units.',
        'Never translate, abbreviate, expand, shorten, summarise, correct or tidy any value you take from the document -'
        + ' not the identifier, not the description, not the unit. "TeSys Deca contactor - 3P(3 NO) - AC-3 - <= 440 V 9 A'
        + ' - 24 V DC coil" must come back exactly like that, never as "TeSys D contactor" or any other shortened form.',
        `This holds for "${SOURCE_LINE_FIELD}" as well: it is never translated, shortened or tidied - it is the document's own wording.`,
        `You may use ${target} only for a word you have to invent yourself, and there is none in this task.`,
        'Item identifiers are not always numbers: a code may contain letters, dots, slashes or dashes, or be a complete URL.'
        + ' Copy the whole string, however long it is, and never cut a URL short.',
        'Numbers: plain decimals with a dot, no thousand separators, no currency symbol, no percent sign.',
        'Keep every decimal place that is printed - 9.50 stays 9.50 and 0.125 stays 0.125 - and never round a value.',
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
        /* Der Satz stand frueher ohne Grenze da («skip totals, subtotals,
           delivery terms, headers and footers») und war damit ein
           Freibrief: was das Modell fuer unwichtig hielt, fiel weg. Er
           gilt jetzt nur noch fuer das, was AUSSERHALB der Positions-
           tabelle steht. Innerhalb der Tabelle wird nicht ausgewaehlt. */
        'Leave out only what is printed OUTSIDE the position table: page headers and footers, the address block,'
        + ' delivery and payment terms, and the closing total block of the document.',
        'Inside the position table nothing is left out. Do not judge whether a row is important - transcribe it.',
        'The same holds column by column: an empty cell stays empty. Read each value from the column it is printed under,'
        + ' never from the nearest column that happens to have a number in it.',
        'A value that is not on the document is null. Never guess or invent.',
    ].join(' ');
};

/* ── Preisliste je Modell ────────────────────────────────────────────────
   Nur zur ANZEIGE. Sie ist eine Momentaufnahme (07.09.2026) und darf veralten;
   ein unbekanntes Modell bekommt darum keine geschätzten Kosten, sondern
   `null` — lieber keine Zahl als eine falsche. */
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

/* ═══════════════════════════════════════════════════════════════════════
   ERSTE STUFE — DAS BILD WIRD EINE ORDENTLICHE TABELLE
   ═══════════════════════════════════════════════════════════════════════

   Vorgabe Samet (08.09.2026): «Nein, es muss zuerst eine Umwandlung geben,
   eine ORDENTLICHE Umwandlung, und danach geht es an das Modell — nicht
   direkt an das Modell.»

   Das ist ausdruecklich NICHT die Rueckkehr zur Texterkennung, die am
   08.09.2026 aus diesem Weg flog. Die gab die Tabelle als flache
   Zeilenfolge zurueck — Spalten weg, Zuordnung weg. Hier liest DASSELBE
   sehende Modell die Seite, aber es tut in diesem Durchgang nur EINES:
   abschreiben. Zeile fuer Zeile, Zelle fuer Zelle, mit Tabulatoren
   dazwischen und einer leeren Zelle da, wo auf dem Blatt nichts steht.

   Warum das besser ist als ein einziger Durchgang:
     · ABSCHREIBEN und ZUORDNEN sind zwei verschiedene Aufgaben. Zusammen
       in einem Durchgang muss das Modell beides gleichzeitig richtig
       machen; getrennt kann jede fuer sich stimmen.
     · Die Zwischenstufe ist LESBAR. Was das Modell gesehen hat, steht als
       Tabelle da und laesst sich mit dem Blatt vergleichen — vorher war
       zwischen Aufnahme und fertiger Bestellung nichts zu sehen.
     · Die zweite Stufe ist ein reiner Textaufruf und damit billig; sie
       sieht die Kopfzeile und ordnet daran aus.

   Die Antwort ist eine LISTE VON ZEILEN, nicht ein Textblock: so kann das
   Modell keine Zeilen zusammenziehen, und wir koennen sie zaehlen. */

export interface GptTranscript {
    /** Die Kopfzeile des Blattes, wenn es eine hat. */
    header: string | null;
    /** Je gedruckte Zeile ein Eintrag, Zellen mit Tabulator getrennt. */
    lines: string[];
    usage: GptUsage;
}

const TRANSCRIBE_PROMPT = [
    'You are transcribing a table from an image. You do NOT interpret it, you do not summarise it, you do not translate it.',
    'Return the table exactly as it is printed, line by line, from top to bottom.',
    'Put the column header row into "header" and every other printed row into "lines", one entry per printed row.',
    'Inside a line, separate the cells with a TAB character. Keep the columns in their printed left-to-right order.',
    'Every line must contain the SAME number of tabs as the header, so that column 3 of one line is column 3 of every line.',
    'A cell that is empty on the page stays empty: write nothing between the two tabs. Never leave a tab out to close a gap,'
    + ' and never move a value into a neighbouring column.',
    'Copy every value character for character - identifiers, descriptions, units, URLs and numbers alike.'
    + ' Do not shorten, abbreviate, translate, round or tidy anything, and keep the decimal separator that is printed.',
    'A cell whose text wraps onto several printed lines is still ONE cell: join it with a single space, do not start a new line.',
    'Transcribe every row of the table including the last one, and nothing that stands outside the table.',
].join(' ');

const TRANSCRIBE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        header: { type: ['string', 'null'], description: 'The column header row, cells separated by TAB' },
        lines: {
            type: 'array',
            description: 'One entry per printed table row, cells separated by TAB',
            items: { type: 'string' },
        },
    },
    required: ['header', 'lines'],
};

/**
 * Eine Aufnahme in eine Tabelle verwandeln — und sonst nichts. Das Ergebnis
 * geht danach als TEXT durch `extractWithGpt`, genau wie eine Excel-Datei.
 */
export const transcribeImage = async (
    image: { data: string; mimeType: string },
): Promise<GptTranscript> => {
    const key = API_KEY();
    if (!key) throw new GptError('Die KI-Erkennung ist nicht eingerichtet.', 'GPT_NOT_CONFIGURED', 503);
    const model = MODEL();

    const body = {
        model,
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: {
            type: 'json_schema',
            json_schema: { name: 'document_table', strict: true, schema: TRANSCRIBE_SCHEMA },
        },
        messages: [
            { role: 'system', content: TRANSCRIBE_PROMPT },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Transcribe the table in this image.' },
                    {
                        type: 'image_url',
                        image_url: { url: `data:${image.mimeType};base64,${image.data}`, detail: 'high' },
                    },
                ],
            },
        ],
    };

    let response: Response;
    try {
        response = await fetch(ENDPOINT(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
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
        console.error('[gptExtract/transcribe] OpenAI antwortete', response.status, message || '(ohne Grund)');
        throw new GptError('Die KI-Erkennung hat den Beleg abgelehnt.', 'GPT_REJECTED', 502, message);
    }
    const choice = payload?.choices?.[0];
    if (choice?.finish_reason === 'length') {
        throw new GptError(
            'Der Beleg ist für einen Durchgang zu lang. Bitte weniger Seiten aufs Mal hochladen.',
            'GPT_TRUNCATED',
            422,
            `Die Abschrift riss nach ${MAX_OUTPUT_TOKENS} Token ab.`,
        );
    }

    let parsed: any;
    try {
        parsed = JSON.parse(String(choice?.message?.content ?? ''));
    } catch {
        throw new GptError('Die Antwort der KI war nicht lesbar.', 'GPT_BAD_JSON', 502);
    }

    const lines = Array.isArray(parsed?.lines)
        ? parsed.lines.map((line: unknown) => String(line ?? '')).filter((line: string) => line.trim())
        : [];
    return {
        header: parsed?.header ? String(parsed.header) : null,
        lines,
        usage: usageOf(payload?.usage, model),
    };
};

export interface GptExtractInput {
    /**
     * Der Text des Belegs. Leer, wenn stattdessen ein BILD mitgeschickt wird —
     * dann liest das Modell selbst (siehe `image`).
     */
    text: string;
    /**
     * ── DER BELEG ALS BILD (08.09.2026) ────────────────────────────────────
     * Vorgabe Samet: «Lass uns Google Cloud weglassen.»
     *
     * Die Modelle der 4o-Reihe SEHEN — ein Foto oder ein eingescannter Beleg
     * geht direkt an sie, ohne Texterkennung dazwischen. Damit fällt der
     * fremde Dienst samt Schlüssel, Kontingent und Freischaltung weg, und
     * nebenbei liest es besser: das Modell sieht die SPALTEN des Belegs, statt
     * einen flachgeklopften Textauszug, in dem Listenpreis und Nettopreis
     * nebeneinander stehen und nicht mehr zu unterscheiden sind.
     *
     * `data` ist der reine Base64-Inhalt ohne `data:`-Kopf.
     */
    image?: { data: string; mimeType: string };
    /** DIE SPALTEN DER VORLAGE — sie werden zum Antwortschema. */
    columns: TemplateColumn[];
    /** Zielsprache der Textwerte: 'de' | 'en' | 'tr'. */
    language: string;
    /** Mengenstaffel mitlesen (kostet Ausgabe-Token, darum abschaltbar). */
    withTiers?: boolean;
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
    const key = API_KEY();
    if (!key) throw new GptError('Die KI-Erkennung ist nicht eingerichtet.', 'GPT_NOT_CONFIGURED', 503);

    const model = MODEL();
    if (!input.image && !String(input.text || '').trim()) {
        throw new GptError('Der Beleg enthält keinen lesbaren Inhalt.', 'GPT_EMPTY_INPUT', 422);
    }
    const columns = normalizeColumns(input.columns);
    if (columns.length < TEMPLATE_MIN_COLUMNS) {
        throw new GptError(
            `Die Vorlage braucht mindestens ${TEMPLATE_MIN_COLUMNS} Spalten.`,
            'GPT_TOO_FEW_COLUMNS',
            400,
        );
    }

    const body = {
        model,
        // Ein Beleg ist kein Ort für Einfälle: dieselbe Seite muss zweimal
        // dasselbe ergeben.
        temperature: 0,
        /* ── PLATZ FUER ALLE ZEILEN ──────────────────────────────────────
           Eine Position mit ihrem Zeilenanker kostet grob 80 Ausgabe-Token;
           35 davon sind rund 3'000. Ohne ausdrueckliche Grenze setzt die
           Gegenseite ihre eigene, und wo sie greift, bricht die Antwort
           mitten im JSON ab — die Bestellung ist dann nicht kuerzer,
           sondern gar nicht da (`finish_reason: 'length'`). Lieber die
           Obergrenze des Modells ausschoepfen: ungenutzte Token kosten
           nichts, nur ausgegebene. */
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'supplier_document',
                strict: true,
                schema: buildSchema(columns, Boolean(input.withTiers), input.includeDocumentHeader !== false),
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

    let response: Response;
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
