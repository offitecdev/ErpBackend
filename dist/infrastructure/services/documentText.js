"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.readDocumentText = exports.approxTokens = exports.chunkText = exports.compactText = exports.DocumentReadError = exports.DOCUMENT_MAX_CHARS = exports.DOCUMENT_MAX_BYTES = void 0;
const ocrSpaceOcr_1 = require("./ocrSpaceOcr");
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
exports.DOCUMENT_MAX_BYTES = 11 * 1024 * 1024;
/**
 * Obergrenze der Zeichen, die ans Modell gehen. 60'000 Zeichen sind grob
 * 15'000 Token. Wer eine dickere Preisliste hochlädt, bekommt sie in Stücken
 * gelesen (siehe `chunkText`), nicht stillschweigend halbiert.
 */
exports.DOCUMENT_MAX_CHARS = Number(process.env.gptMaxChars || 60_000);
class DocumentReadError extends Error {
    code;
    status;
    detail;
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
    constructor(message, code, status, detail) {
        super(message);
        this.code = code;
        this.status = status;
        this.detail = detail;
    }
}
exports.DocumentReadError = DocumentReadError;
/* ── Stauchen ─────────────────────────────────────────────────────────────
   Vier Regeln, jede einzeln nachvollziehbar. Keine davon darf eine Zahl
   verlieren — deshalb fasst die Wiederholungsregel NUR Zeilen ohne Ziffern an. */
/** Kopf-/Fusszeilen wie «Seite 3 von 12», in den drei Sprachen des Hauses. */
const PAGE_MARKER = /^(seite|page|sayfa|blatt)\s*\d+(\s*(von|of|\/)\s*\d+)?$/i;
const compactText = (raw) => {
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
    const seen = new Map();
    for (const line of lines) {
        if (!line || /\d/.test(line))
            continue;
        seen.set(line, (seen.get(line) ?? 0) + 1);
    }
    const boilerplate = new Set([...seen.entries()].filter(([line, count]) => count >= 3 && line.length <= 90).map(([line]) => line));
    const kept = [];
    const printed = new Set();
    for (const line of lines) {
        if (!line) {
            // Höchstens eine Leerzeile am Stück — sie trennt Blöcke, mehr braucht es nicht.
            if (kept.length && kept[kept.length - 1] !== '')
                kept.push('');
            continue;
        }
        if (PAGE_MARKER.test(line))
            continue;
        if (boilerplate.has(line)) {
            if (printed.has(line))
                continue;
            printed.add(line);
        }
        kept.push(line);
    }
    while (kept.length && kept[kept.length - 1] === '')
        kept.pop();
    return kept.join('\n');
};
exports.compactText = compactText;
/**
 * Text in Stücke schneiden, die einzeln ans Modell passen. Geschnitten wird an
 * ZEILENGRENZEN, mit zwei Zeilen Überlappung: eine Position steht im PDF-
 * Textlayer oft über mehrere Zeilen, und die letzte Zeile eines Stücks wäre
 * sonst ihr abgerissener Kopf. Doppelte Positionen fängt das Zusammenführen
 * hinterher wieder ab.
 */
const chunkText = (text, maxChars, overlapLines = 2) => {
    if (text.length <= maxChars)
        return [text];
    const lines = text.split('\n');
    const chunks = [];
    let current = [];
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
    if (current.length)
        chunks.push(current.join('\n'));
    return chunks;
};
exports.chunkText = chunkText;
/** Grobe Tokenschätzung: lateinischer Text ist rund vier Zeichen je Token. */
const approxTokens = (chars) => Math.ceil(chars / 4);
exports.approxTokens = approxTokens;
/* ── PDF ──────────────────────────────────────────────────────────────── */
const pdfToText = async (bytes) => {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const extracted = await extractText(pdf, { mergePages: true });
    return String(extracted?.text ?? '');
};
const stripDataUrl = (value) => (value.includes(',') ? value.slice(value.indexOf(',') + 1) : value);
const looksLikePdf = (bytes) => bytes.subarray(0, 5).toString('latin1') === '%PDF-';
/**
 * Einen Beleg lesen. Wirft `DocumentReadError` mit einem Code, den die Route in
 * eine Antwort übersetzt; der Aufrufer bekommt NIE eine halb gefüllte Antwort.
 */
const readDocumentText = async (input) => {
    /* Der kürzeste Weg: Der Browser hat den Text schon (Tabelle). */
    const given = String(input.text ?? '').trim();
    if (given) {
        const compact = (0, exports.compactText)(given);
        return {
            source: 'text',
            text: compact.slice(0, exports.DOCUMENT_MAX_CHARS),
            rawChars: given.length,
            chars: Math.min(compact.length, exports.DOCUMENT_MAX_CHARS),
            truncated: compact.length > exports.DOCUMENT_MAX_CHARS,
            engine: 'client-text',
        };
    }
    const base64 = stripDataUrl(String(input.data ?? ''));
    if (!base64)
        throw new DocumentReadError('Es wurde kein Beleg übermittelt.', 'NO_DOCUMENT', 400);
    // Base64 trägt vier Zeichen je drei Byte — so wird die Grösse geprüft, ohne
    // den Puffer dafür anzulegen.
    if ((base64.length * 3) / 4 > exports.DOCUMENT_MAX_BYTES) {
        throw new DocumentReadError('Der Beleg ist zu gross (max. 12 MB).', 'DOCUMENT_TOO_LARGE', 413);
    }
    let bytes;
    try {
        bytes = Buffer.from(base64, 'base64');
    }
    catch {
        throw new DocumentReadError('Der Beleg konnte nicht gelesen werden.', 'DOCUMENT_UNREADABLE', 400);
    }
    if (!bytes.length)
        throw new DocumentReadError('Der Beleg ist leer.', 'DOCUMENT_EMPTY', 400);
    const mime = String(input.mimeType ?? '').toLowerCase();
    const name = String(input.fileName ?? '').toLowerCase();
    const isPdf = looksLikePdf(bytes) || mime.includes('pdf') || name.endsWith('.pdf');
    if (isPdf) {
        let raw = '';
        try {
            raw = await pdfToText(bytes);
        }
        catch (error) {
            throw new DocumentReadError(`Das PDF konnte nicht gelesen werden: ${String(error?.message || error).slice(0, 200)}`, 'PDF_UNREADABLE', 422);
        }
        const compact = (0, exports.compactText)(raw);
        /* EIN GESCANNTES PDF hat keine Textlage — heraus kommen ein paar
           Steuerzeichen, nicht der Beleg. Das muss anders klingen als «leer»,
           sonst sucht jemand den Fehler bei der Schnittstelle: der Ausweg ist
           ein Foto der Seite, das über Vision läuft. */
        if (compact.replace(/\s/g, '').length < 40) {
            throw new DocumentReadError('Dieses PDF enthält keinen auslesbaren Text (vermutlich ein Scan). '
                + 'Bitte ein Foto oder Bild der Seite hochladen — das wird über die Texterkennung gelesen.', 'PDF_NO_TEXT_LAYER', 422);
        }
        return {
            source: 'pdf',
            text: compact.slice(0, exports.DOCUMENT_MAX_CHARS),
            rawChars: raw.length,
            chars: Math.min(compact.length, exports.DOCUMENT_MAX_CHARS),
            truncated: compact.length > exports.DOCUMENT_MAX_CHARS,
            engine: 'pdf-text',
        };
    }
    /* Bild → OCR.space. Der Schlüssel steht schon für die Schnellerfassung im
       Lager; hier wird derselbe Dienst zweitverwendet.

       ⚠ Für den BELEG-IMPORT wird dieser Zweig seit dem 08.09.2026 gar nicht
       mehr betreten: dort liest das Sprachmodell das Bild selbst (siehe
       `purchaseOrderImport.routes.ts` → `pickImageInput`). Er bleibt für jeden
       anderen Aufrufer stehen, der `readDocumentText` mit einem Bild ruft. */
    if (!(0, ocrSpaceOcr_1.ocrConfigured)()) {
        throw new DocumentReadError('Für Fotos ist die Texterkennung nötig, sie ist aber nicht eingerichtet.', 'OCR_NOT_CONFIGURED', 503, 'In der Serverkonfiguration fehlt «OFFITEC_OCR_SPACE_API_KEY».');
    }
    let read;
    try {
        read = await (0, ocrSpaceOcr_1.readTextWithOcr)(base64, String(input.mimeType || '') || 'image/jpeg');
    }
    catch (error) {
        if (error instanceof ocrSpaceOcr_1.OcrError) {
            throw new DocumentReadError(error.message, error.code, error.status, error.detail);
        }
        throw new DocumentReadError('Die Texterkennung ist fehlgeschlagen.', 'OCR_FAILED', 502);
    }
    /* Vision liefert den Fliesstext in EINER Zeile; die Zeilenliste ist die
       bessere Quelle, weil eine Position im Beleg eine Zeile ist. */
    const raw = read.lines.length
        ? read.lines.map((line) => line.text).join('\n')
        : String(read.text || '');
    const compact = (0, exports.compactText)(raw);
    if (!compact.trim()) {
        throw new DocumentReadError('Auf dem Bild wurde kein Text erkannt.', 'IMAGE_NO_TEXT', 422);
    }
    return {
        source: 'image',
        text: compact.slice(0, exports.DOCUMENT_MAX_CHARS),
        rawChars: raw.length,
        chars: Math.min(compact.length, exports.DOCUMENT_MAX_CHARS),
        truncated: compact.length > exports.DOCUMENT_MAX_CHARS,
        engine: 'ocr-space',
    };
};
exports.readDocumentText = readDocumentText;
//# sourceMappingURL=documentText.js.map