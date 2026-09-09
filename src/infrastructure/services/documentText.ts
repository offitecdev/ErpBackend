/**
 * BELEG → TEXT — die billige Hälfte der Lieferantenbestellung per KI.
 *
 * Vorgabe Samet (07.09.2026): «Das Dokument — Foto oder PDF — geht als TEXT an
 * die Schnittstelle, zusammen mit der Vorlage. So wenig Token wie möglich.»
 *
 * Genau darum steht diese Datei VOR dem Sprachmodell: ein Bild an ein Modell zu
 * schicken kostet ein Vielfaches eines Textes derselben Seite. Der Weg ist
 * deshalb immer zweistufig:
 *
 *   PDF mit Textlage   → `unpdf` liest die Lage aus            (kostet nichts)
 *   Foto / Scan        → Google Cloud Vision liest die Zeichen (Bruchteil eines Rappens)
 *   Tabelle (xlsx/csv) → der Browser hat sie schon als Text geschickt
 *
 * Erst der so gewonnene Text geht ans Modell. Vorher wird er GESTAUCHT
 * (`compactText`): doppelte Leerzeichen, Wiederholungen aus Kopf- und Fusszeile,
 * Punktführungen. Das ist kein Schönheitsputz — es ist der grösste Hebel auf der
 * Rechnung, weil jedes gesparte Zeichen ein Viertel Token ist.
 */

import { readTextWithOcr, ocrConfigured, OcrError } from './ocrSpaceOcr';

/** Woher der Text stammt — die Antwort sagt es der Oberfläche. */
export type DocumentSource = 'pdf' | 'image' | 'text';

export interface DocumentRead {
    source: DocumentSource;
    /** Der gestauchte Text, so wie er ans Modell geht. */
    text: string;
    /** Zeichen VOR dem Stauchen — der Vergleich zeigt, was gespart wurde. */
    rawChars: number;
    /** Zeichen NACH dem Stauchen. */
    chars: number;
    /** Wurde am Ende abgeschnitten (Beleg länger als die Obergrenze)? */
    truncated: boolean;
    /** Welcher Leser gearbeitet hat — für die Anzeige und die Fehlersuche. */
    /**
     * Womit gelesen wurde. `gpt-vision` heisst: das Sprachmodell hat das Bild
     * SELBST gelesen — seit dem 08.09.2026 der Weg jedes Fotos, ohne fremden
     * Texterkenner dazwischen. `google-vision` bleibt für die
     * Lager-Schnellerfassung stehen, die weiter über Vision liest.
     */
    engine: 'pdf-text' | 'ocr-space' | 'gpt-vision' | 'client-text';
}

/** Ein Beleg ist eine Seite oder ein paar — alles darüber ist ein Versehen. */
/**
 * ⚠ DIE ZAHL HAENGT AN `express.json({ limit: '15mb' })` IN main.ts.
 * Ein Beleg reist als Base64, und Base64 ist ein Drittel groesser als die
 * Datei: 12 MB wurden auf dem Weg zu 16 MB und damit von Express
 * abgewiesen, BEVOR diese Pruefung ueberhaupt lief — der Anwender bekam
 * eine nackte 413-Seite statt des Satzes «Der Beleg ist zu gross».
 * 11 MB * 4/3 = 14.7 MB und passen darunter. Wer die Grenze hebt, muss
 * beide Zahlen heben.
 */
export const DOCUMENT_MAX_BYTES = 11 * 1024 * 1024;

/**
 * Obergrenze der Zeichen, die ans Modell gehen. 60'000 Zeichen sind grob
 * 15'000 Token. Wer eine dickere Preisliste hochlädt, bekommt sie in Stücken
 * gelesen (siehe `chunkText`), nicht stillschweigend halbiert.
 */
export const DOCUMENT_MAX_CHARS = Number(process.env.gptMaxChars || 60_000);

export class DocumentReadError extends Error {
    /**
     * `detail` ist die BEGRUeNDUNG der Gegenstelle — bei Google Vision enthaelt
     * sie die Adresse, unter der sich die Schnittstelle einschalten laesst.
     *
     * ⚠ Sie fehlte bis zum 08.09.2026: der Erkenner warf einen Fehler MIT
     * Begruendung, die Umwandlung hier liess sie fallen, und
     * am Bildschirm stand «Die Texterkennung ist nicht freigeschaltet.» ohne
     * ein Wort dazu, WO man sie freischaltet. Der Satz allein schickt jeden auf
     * die Suche im falschen Haus — der Fehler liegt nicht in der Anwendung,
     * sondern im Google-Projekt.
     */
    constructor(
        message: string,
        readonly code: string,
        readonly status: number,
        readonly detail?: string,
    ) {
        super(message);
    }
}

/* ── Stauchen ─────────────────────────────────────────────────────────────
   Vier Regeln, jede einzeln nachvollziehbar. Keine davon darf eine Zahl
   verlieren — deshalb fasst die Wiederholungsregel NUR Zeilen ohne Ziffern an. */

/** Kopf-/Fusszeilen wie «Seite 3 von 12», in den drei Sprachen des Hauses. */
const PAGE_MARKER = /^(seite|page|sayfa|blatt)\s*\d+(\s*(von|of|\/)\s*\d+)?$/i;

export const compactText = (raw: string): string => {
    const lines = String(raw ?? '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line
            /* ── DER LEERRAUM IST DIE SPALTE ────────────────────────────────
               Fehlerbild Samet (08.09.2026): «Alles ist durcheinander — ob
               Excel oder PNG, die Werte müssen zu ihren Spalten passen.
               Leerstellen dürfen die Angaben nicht verschieben.»

               Hier stand `.replace(/[^\S\n]+/g, ' ')`: JEDER Lauf von
               Leerraum wurde EIN Leerzeichen — auch der Tabulator, mit dem
               die Bestellseite eine Tabelle herschickt, und auch die
               Kolonnenabstände einer PDF-Textlage.

                   «LC1D09BD⇥TeSys Deca…⇥⇥⇥78.10»
                 → «LC1D09BD TeSys Deca… 78.10»

               Die beiden LEEREN Zellen waren damit spurlos fort, und das
               Modell konnte nicht mehr wissen, in welche Spalte 78.10
               gehört — es riet, und ab da stand alles eine Spalte zu weit
               links. Genau die Verschiebung, die gemeldet wurde.

               Jetzt trennt EIN Leerzeichen weiterhin zwei Wörter, aber
               jeder GRÖSSERE Abstand — zwei Leerzeichen oder ein Tabulator
               — wird ein Tabulator und bleibt als Spaltengrenze stehen.
               Eine leere Zelle ist dann zwei Tabulatoren hintereinander,
               und das lässt sich lesen. Gespart wird trotzdem: aus vierzig
               Ausrichtungszeichen wird ein einziges. */
            // Punktführungen («Artikel .......... 12.50») trennen Spalten —
            // sie tragen keinen Inhalt, aber sehr wohl eine Grenze.
            .replace(/[.·•]{4,}/g, '\t')
            .replace(/[-_=]{6,}/g, '\t')
            /* ⚠ ZWEI TABULATOREN HINTEREINANDER SIND EINE LEERE ZELLE und
               dürfen NICHT zu einem werden. Darum steht in den beiden
               Klassen hier KEIN `\t`: geputzt wird der Leerraum NEBEN jedem
               Tabulator, der Tabulator selbst bleibt jedes Mal stehen. */
            .replace(/[ \u00a0]*\t[ \u00a0]*/g, '\t')
            // Ein Abstand ab zwei Zeichen ist eine Spaltengrenze (PDF-Textlage).
            .replace(/[ \u00a0]{2,}/g, '\t')
            // Einzelne Leerzeichen bleiben, was sie sind: Worttrenner.
            .replace(/[ \u00a0]/g, ' ')
            /* ⚠ NUR RECHTS KÜRZEN. Ein Tabulator am ZEILENANFANG heisst,
               dass die erste Spalte leer ist — nähme man ihn weg, rückte
               die ganze Zeile eine Spalte nach links, und das ist genau
               die Verschiebung, die hier abgestellt wird. Rechts ist es
               gefahrlos: hinter der letzten Zelle steht nichts mehr. */
            .replace(/[\t ]+$/g, '')
            .replace(/^ +/, ''));

    /* WIEDERHOLUNGEN: Was auf jeder Seite gleich dasteht, ist der Briefkopf des
       Lieferanten — einmal reicht. Zeilen MIT Ziffern bleiben unangetastet:
       darunter stehen Preise, Mengen und Artikelnummern, und eine Preiszeile
       darf sich wiederholen (zwei Positionen zu 12.50 sind zwei Positionen). */
    const seen = new Map<string, number>();
    for (const line of lines) {
        if (!line || /\d/.test(line)) continue;
        seen.set(line, (seen.get(line) ?? 0) + 1);
    }
    const boilerplate = new Set(
        [...seen.entries()].filter(([line, count]) => count >= 3 && line.length <= 90).map(([line]) => line),
    );

    const kept: string[] = [];
    const printed = new Set<string>();
    for (const line of lines) {
        if (!line) {
            // Höchstens eine Leerzeile am Stück — sie trennt Blöcke, mehr braucht es nicht.
            if (kept.length && kept[kept.length - 1] !== '') kept.push('');
            continue;
        }
        if (PAGE_MARKER.test(line)) continue;
        if (boilerplate.has(line)) {
            if (printed.has(line)) continue;
            printed.add(line);
        }
        kept.push(line);
    }
    while (kept.length && kept[kept.length - 1] === '') kept.pop();
    return kept.join('\n');
};

/**
 * Text in Stücke schneiden, die einzeln ans Modell passen. Geschnitten wird an
 * ZEILENGRENZEN, mit zwei Zeilen Überlappung: eine Position steht im PDF-
 * Textlayer oft über mehrere Zeilen, und die letzte Zeile eines Stücks wäre
 * sonst ihr abgerissener Kopf. Doppelte Positionen fängt das Zusammenführen
 * hinterher wieder ab.
 */
export const chunkText = (text: string, maxChars: number, overlapLines = 2): string[] => {
    if (text.length <= maxChars) return [text];
    const lines = text.split('\n');
    const chunks: string[] = [];
    let current: string[] = [];
    let size = 0;
    for (const line of lines) {
        if (size + line.length + 1 > maxChars && current.length) {
            chunks.push(current.join('\n'));
            current = current.slice(Math.max(0, current.length - overlapLines));
            size = current.reduce((sum, entry) => sum + entry.length + 1, 0);
        }
        current.push(line);
        size += line.length + 1;
    }
    if (current.length) chunks.push(current.join('\n'));
    return chunks;
};

/** Grobe Tokenschätzung: lateinischer Text ist rund vier Zeichen je Token. */
export const approxTokens = (chars: number): number => Math.ceil(chars / 4);

/* ── PDF ──────────────────────────────────────────────────────────────── */

const pdfToText = async (bytes: Buffer): Promise<string> => {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const extracted = await extractText(pdf, { mergePages: true });
    return String(extracted?.text ?? '');
};

/* ── Eintrittspunkt ───────────────────────────────────────────────────── */

export interface ReadDocumentInput {
    /** Reiner Base64-Inhalt ODER `data:…;base64,…` — beides ist erlaubt. */
    data?: string | null;
    mimeType?: string | null;
    fileName?: string | null;
    /**
     * Fertiger Text. Den schickt der Browser für Tabellen: `xlsx` liegt dort
     * schon im Bündel, und eine Tabelle als TSV ist kürzer als jede erneute
     * Umwandlung auf dem Server.
     */
    text?: string | null;
}

const stripDataUrl = (value: string): string => (value.includes(',') ? value.slice(value.indexOf(',') + 1) : value);

const looksLikePdf = (bytes: Buffer): boolean => bytes.subarray(0, 5).toString('latin1') === '%PDF-';

/**
 * Einen Beleg lesen. Wirft `DocumentReadError` mit einem Code, den die Route in
 * eine Antwort übersetzt; der Aufrufer bekommt NIE eine halb gefüllte Antwort.
 */
export const readDocumentText = async (input: ReadDocumentInput): Promise<DocumentRead> => {
    /* Der kürzeste Weg: Der Browser hat den Text schon (Tabelle). */
    const given = String(input.text ?? '').trim();
    if (given) {
        const compact = compactText(given);
        return {
            source: 'text',
            text: compact.slice(0, DOCUMENT_MAX_CHARS),
            rawChars: given.length,
            chars: Math.min(compact.length, DOCUMENT_MAX_CHARS),
            truncated: compact.length > DOCUMENT_MAX_CHARS,
            engine: 'client-text',
        };
    }

    const base64 = stripDataUrl(String(input.data ?? ''));
    if (!base64) throw new DocumentReadError('Es wurde kein Beleg übermittelt.', 'NO_DOCUMENT', 400);
    // Base64 trägt vier Zeichen je drei Byte — so wird die Grösse geprüft, ohne
    // den Puffer dafür anzulegen.
    if ((base64.length * 3) / 4 > DOCUMENT_MAX_BYTES) {
        throw new DocumentReadError('Der Beleg ist zu gross (max. 12 MB).', 'DOCUMENT_TOO_LARGE', 413);
    }

    let bytes: Buffer;
    try {
        bytes = Buffer.from(base64, 'base64');
    } catch {
        throw new DocumentReadError('Der Beleg konnte nicht gelesen werden.', 'DOCUMENT_UNREADABLE', 400);
    }
    if (!bytes.length) throw new DocumentReadError('Der Beleg ist leer.', 'DOCUMENT_EMPTY', 400);

    const mime = String(input.mimeType ?? '').toLowerCase();
    const name = String(input.fileName ?? '').toLowerCase();
    const isPdf = looksLikePdf(bytes) || mime.includes('pdf') || name.endsWith('.pdf');

    if (isPdf) {
        let raw = '';
        try {
            raw = await pdfToText(bytes);
        } catch (error: any) {
            throw new DocumentReadError(
                `Das PDF konnte nicht gelesen werden: ${String(error?.message || error).slice(0, 200)}`,
                'PDF_UNREADABLE',
                422,
            );
        }
        const compact = compactText(raw);
        /* EIN GESCANNTES PDF hat keine Textlage — heraus kommen ein paar
           Steuerzeichen, nicht der Beleg. Das muss anders klingen als «leer»,
           sonst sucht jemand den Fehler bei der Schnittstelle: der Ausweg ist
           ein Foto der Seite, das über Vision läuft. */
        if (compact.replace(/\s/g, '').length < 40) {
            throw new DocumentReadError(
                'Dieses PDF enthält keinen auslesbaren Text (vermutlich ein Scan). '
                + 'Bitte ein Foto oder Bild der Seite hochladen — das wird über die Texterkennung gelesen.',
                'PDF_NO_TEXT_LAYER',
                422,
            );
        }
        return {
            source: 'pdf',
            text: compact.slice(0, DOCUMENT_MAX_CHARS),
            rawChars: raw.length,
            chars: Math.min(compact.length, DOCUMENT_MAX_CHARS),
            truncated: compact.length > DOCUMENT_MAX_CHARS,
            engine: 'pdf-text',
        };
    }

    /* Bild → OCR.space. Der Schlüssel steht schon für die Schnellerfassung im
       Lager; hier wird derselbe Dienst zweitverwendet.

       ⚠ Für den BELEG-IMPORT wird dieser Zweig seit dem 08.09.2026 gar nicht
       mehr betreten: dort liest das Sprachmodell das Bild selbst (siehe
       `purchaseOrderImport.routes.ts` → `pickImageInput`). Er bleibt für jeden
       anderen Aufrufer stehen, der `readDocumentText` mit einem Bild ruft. */
    if (!ocrConfigured()) {
        throw new DocumentReadError(
            'Für Fotos ist die Texterkennung nötig, sie ist aber nicht eingerichtet.',
            'OCR_NOT_CONFIGURED',
            503,
            'In der Serverkonfiguration fehlt «OFFITEC_OCR_SPACE_API_KEY».',
        );
    }
    let read: { text: string; lines: Array<{ text: string }> };
    try {
        read = await readTextWithOcr(base64, String(input.mimeType || '') || 'image/jpeg');
    } catch (error: any) {
        if (error instanceof OcrError) {
            throw new DocumentReadError(error.message, error.code, error.status, error.detail);
        }
        throw new DocumentReadError('Die Texterkennung ist fehlgeschlagen.', 'OCR_FAILED', 502);
    }
    /* Vision liefert den Fliesstext in EINER Zeile; die Zeilenliste ist die
       bessere Quelle, weil eine Position im Beleg eine Zeile ist. */
    const raw = read.lines.length
        ? read.lines.map((line) => line.text).join('\n')
        : String(read.text || '');
    const compact = compactText(raw);
    if (!compact.trim()) {
        throw new DocumentReadError('Auf dem Bild wurde kein Text erkannt.', 'IMAGE_NO_TEXT', 422);
    }
    return {
        source: 'image',
        text: compact.slice(0, DOCUMENT_MAX_CHARS),
        rawChars: raw.length,
        chars: Math.min(compact.length, DOCUMENT_MAX_CHARS),
        truncated: compact.length > DOCUMENT_MAX_CHARS,
        engine: 'ocr-space',
    };
};
