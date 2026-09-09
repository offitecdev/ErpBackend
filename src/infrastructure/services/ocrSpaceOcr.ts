/**
 * OCR.SPACE — der Erkenner hinter der Lager-Schnellerfassung.
 *
 * Vorgabe Samet (08.09.2026): «Nimm OCR.space, Vision raus.» Der Dienst hat
 * ein kostenloses Kontingent (25'000 Anfragen im Monat), verlangt keinen
 * Google-Cloud-Vertrag, keine Abrechnung und keine Freischaltung eines
 * Projekts — genau die drei Dinge, an denen die Texterkennung zuletzt hing.
 *
 * Warum ÜBER DEN SERVER und nicht direkt aus dem Browser: der Schlüssel darf
 * nicht im Bündel liegen. Jeder, der die Seite öffnet, könnte ihn sonst lesen
 * und auf unsere Rechnung erkennen lassen. Die Anwendung schickt darum den
 * AUSSCHNITT an die eigene Route, und erst von hier geht er hinaus.
 *
 * Es reist immer nur der markierte Ausschnitt, nie das ganze Foto: das ist
 * schneller, schont das Kontingent und lässt am wenigsten Bildmaterial das
 * Haus verlassen.
 *
 * Konfiguration:
 *   OFFITEC_OCR_SPACE_API_KEY   der Schlüssel (kostenlos auf ocr.space)
 *   OFFITEC_OCR_SPACE_ENDPOINT  optional, sonst https://api.ocr.space/parse/image
 *   OFFITEC_OCR_SPACE_ENGINE    optional, «1» oder «2» (Vorgabe: 2)
 *
 * Fehlt der Schlüssel, meldet `ocrConfigured()` false und die Route antwortet
 * 503 mit `code: 'OCR_NOT_CONFIGURED'`; die Anwendung sagt dann sauber, dass
 * die Texterkennung nicht eingerichtet ist, statt still nichts zu tun.
 *
 * ⚠ ZWEI EIGENHEITEN DES DIENSTES, die man kennen muss:
 *   1. Das Bild reist als DATEN-URI (`data:image/png;base64,…`), nicht als
 *      nackter Base64-Inhalt — ohne den Kopf antwortet er mit einem Fehler,
 *      der nach einem kaputten Bild klingt.
 *   2. Er meldet Fehler mit HTTP 200 und `IsErroredOnProcessing: true`. Wer
 *      nur den Statuscode prüft, hält eine Absage für einen leeren Beleg.
 */

const ENDPOINT = () => (process.env.OFFITEC_OCR_SPACE_ENDPOINT
    || 'https://api.ocr.space/parse/image');
const API_KEY = () => (process.env.OFFITEC_OCR_SPACE_API_KEY || '').trim();
/**
 * Erkenner 2 ist der neuere und liest kurze Beschriftungen — Etiketten,
 * Verpackungen, ein Produktname im Ausschnitt — deutlich besser als Erkenner 1,
 * der auf ganze Seiten ausgelegt ist. Er erkennt die Sprache selbst, darum
 * reist auch kein Sprachhinweis mit.
 */
const ENGINE = () => (process.env.OFFITEC_OCR_SPACE_ENGINE === '1' ? '1' : '2');

/**
 * DAS KOSTENLOSE KONTINGENT ERLAUBT 1 MB je Bild — mehr lehnt der Dienst ab,
 * und zwar mit einer Meldung, die nach einem Serverfehler aussieht. Lieber
 * hier sauber absagen. (Vision durfte 4 MB; der Ausschnitt der
 * Schnellerfassung liegt weit darunter, das reicht also weiterhin.)
 */
export const OCR_MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 20_000;

export interface OcrLine {
    /** Text der Zeile, so wie der Dienst ihn liest (ungefiltert). */
    text: string;
    /**
     * 0–100, damit die Anwendung dieselbe Skala sieht wie bisher.
     *
     * ⚠ OCR.space liefert KEINE Zuverlässigkeit je Zeile. Hier steht darum
     * 100 — genau wie beim eingebauten `TextDetector` des Browsers, der auch
     * keine hat (siehe `lib/ocr/ocrEngine.ts`). Eine erfundene Zahl wäre
     * schlimmer als eine ehrliche Eins: die Anwendung filtert danach.
     */
    confidence: number;
    /** Rahmen in Pixeln des GESCHICKTEN Ausschnitts. */
    box: { x0: number; y0: number; x1: number; y1: number };
}

export interface OcrRead {
    text: string;
    lines: OcrLine[];
}

export class OcrError extends Error {
    /** Der Wortlaut des Dienstes, wenn es einen gibt — für die Einrichtung. */
    readonly detail: string | undefined;

    constructor(message: string, readonly code: string, readonly status: number, detail?: string) {
        super(message);
        this.detail = detail;
    }
}

export const ocrConfigured = (): boolean => API_KEY().length > 0;

/**
 * Gründe, die NICHT am Bild liegen, sondern am Zugang: falscher oder
 * abgelaufener Schlüssel. Sie müssen sich anders anfühlen als «der Ausschnitt
 * wurde abgelehnt» — sonst sucht jemand den Fehler stundenlang bei seinem Foto.
 */
const isKeyProblem = (message: string): boolean => /api\s*key|apikey|not\s*valid|invalid|unauthor/i.test(message);
/** Das Kontingent ist aufgebraucht oder die Anfragen kommen zu schnell. */
const isQuotaProblem = (message: string): boolean => /limit|quota|exceed|too many|upto maximum/i.test(message);

/** Die Fehlermeldung des Dienstes als EIN Satz — sie kommt mal als Text, mal als Liste. */
const errorTextOf = (payload: any): string => {
    const raw = payload?.ErrorMessage ?? payload?.ErrorDetails ?? '';
    const text = Array.isArray(raw) ? raw.filter(Boolean).join(' · ') : String(raw ?? '');
    return text.trim().slice(0, 400);
};

/**
 * Aus den Wörtern einer Zeile ihren Rahmen rechnen. OCR.space gibt je Wort
 * `Left/Top/Width/Height` in Pixeln des geschickten Bildes — dieselbe Skala,
 * in der Vision seine Ecken lieferte, die Anwendung rechnet also unverändert
 * weiter.
 */
const boxOfWords = (words: any[]): OcrLine['box'] => {
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = 0;
    let y1 = 0;
    for (const word of words) {
        const left = Number(word?.Left) || 0;
        const top = Number(word?.Top) || 0;
        const width = Number(word?.Width) || 0;
        const height = Number(word?.Height) || 0;
        x0 = Math.min(x0, left);
        y0 = Math.min(y0, top);
        x1 = Math.max(x1, left + width);
        y1 = Math.max(y1, top + height);
    }
    if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
    return { x0, y0, x1, y1 };
};

/**
 * Einen Bildausschnitt lesen lassen. `base64` ist der reine Inhalt ohne
 * `data:`-Kopf; `mimeType` sagt, was es ist (fehlt er, ist JPEG die
 * verträglichste Annahme — jedes Telefonfoto ist eines).
 *
 * Wirft `OcrError` mit einem Code, den die Route in eine Antwort übersetzt.
 */
export const readTextWithOcr = async (base64: string, mimeType = 'image/jpeg'): Promise<OcrRead> => {
    const key = API_KEY();
    if (!key) throw new OcrError('Die Texterkennung ist nicht eingerichtet.', 'OCR_NOT_CONFIGURED', 503);

    const form = new URLSearchParams();
    form.set('apikey', key);
    // ⚠ MIT Kopf — siehe die Eigenheiten oben.
    form.set('base64Image', `data:${mimeType};base64,${base64}`);
    form.set('OCREngine', ENGINE());
    // Der Rahmen je Wort ist das, woraus die Zeilenkästen entstehen; ohne ihn
    // käme nur ein Textklumpen zurück und die Anwendung könnte nichts antippen.
    form.set('isOverlayRequired', 'true');
    // Kleine Ausschnitte werden hochgerechnet, schief gehaltene aufgerichtet.
    form.set('scale', 'true');
    form.set('detectOrientation', 'true');

    let response: Response;
    try {
        response = await fetch(ENDPOINT(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (error: any) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        throw new OcrError(
            timedOut ? 'Die Texterkennung hat zu lange gebraucht.' : 'Die Texterkennung ist nicht erreichbar.',
            timedOut ? 'OCR_TIMEOUT' : 'OCR_UNREACHABLE',
            504,
        );
    }

    /* Der Dienst antwortet bei Fehlern mal mit JSON, mal mit einem nackten
       Satz (etwa bei zu schnellen Anfragen). Beides muss hier ankommen. */
    const bodyText = await response.text().catch(() => '');
    let payload: any = null;
    try { payload = JSON.parse(bodyText); } catch { payload = null; }

    if (!response.ok) {
        const message = (payload ? errorTextOf(payload) : bodyText.slice(0, 400)).trim();
        console.error('[ocrSpace] antwortete', response.status, message || '(ohne Grund)');
        if (response.status === 401 || response.status === 403 || isKeyProblem(message)) {
            throw new OcrError(
                'Die Texterkennung ist nicht freigeschaltet.',
                'OCR_NOT_ENABLED',
                503,
                message || undefined,
            );
        }
        if (response.status === 429 || isQuotaProblem(message)) {
            throw new OcrError('Die Texterkennung ist derzeit ausgelastet.', 'OCR_QUOTA', 429, message || undefined);
        }
        throw new OcrError('Die Texterkennung hat den Ausschnitt abgelehnt.', 'OCR_REJECTED', 502, message || undefined);
    }

    /* ⚠ HTTP 200 UND TROTZDEM EIN FEHLER — die zweite Eigenheit. */
    if (!payload || payload.IsErroredOnProcessing || Number(payload.OCRExitCode) >= 3) {
        const message = errorTextOf(payload);
        console.error('[ocrSpace] meldete', message || '(ohne Grund)');
        if (isKeyProblem(message)) {
            throw new OcrError('Die Texterkennung ist nicht freigeschaltet.', 'OCR_NOT_ENABLED', 503, message || undefined);
        }
        if (isQuotaProblem(message)) {
            throw new OcrError('Die Texterkennung ist derzeit ausgelastet.', 'OCR_QUOTA', 429, message || undefined);
        }
        throw new OcrError('Die Texterkennung hat den Ausschnitt abgelehnt.', 'OCR_REJECTED', 502, message || undefined);
    }

    const first = payload?.ParsedResults?.[0];
    const overlayLines: any[] = Array.isArray(first?.TextOverlay?.Lines) ? first.TextOverlay.Lines : [];

    const lines: OcrLine[] = overlayLines
        .map((line) => {
            const words = Array.isArray(line?.Words) ? line.Words : [];
            const text = String(line?.LineText ?? words.map((w: any) => w?.WordText ?? '').join(' ')).trim();
            return { text, confidence: 100, box: boxOfWords(words) };
        })
        .filter((line) => line.text.length > 0);

    /* Der Fliesstext kommt fertig zurück; fehlt er (kein Overlay), wird er aus
       den Zeilen gebaut, damit der Aufrufer nie mit leeren Händen dasteht. */
    const text = String(first?.ParsedText ?? '').replace(/\s+/g, ' ').trim()
        || lines.map((line) => line.text).join(' ');

    return { text, lines };
};
