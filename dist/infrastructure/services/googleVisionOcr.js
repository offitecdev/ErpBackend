"use strict";
/**
 * GOOGLE CLOUD VISION — der Erkenner hinter der Lager-Schnellerfassung.
 *
 * Warum ÜBER DEN SERVER und nicht direkt aus dem Browser: der Schlüssel darf
 * nicht im Bündel liegen. Jeder, der die Seite öffnet, könnte ihn sonst lesen
 * und auf unsere Rechnung erkennen lassen. Die Anwendung schickt darum den
 * AUSSCHNITT an diese Route, und erst von hier geht er zu Google.
 *
 * Es reist immer nur der markierte Ausschnitt, nie das ganze Foto: das ist
 * schneller, billiger (Vision rechnet je Bild ab) und lässt am wenigsten
 * Bildmaterial das Haus verlassen.
 *
 * Konfiguration — eine einzige Umgebungsvariable:
 *   OFFITEC_GOOGLE_VISION_API_KEY = der API-Schlüssel des Projekts
 *                                   (Cloud Vision API aktiviert)
 * Fehlt sie, meldet `visionConfigured()` false und die Route antwortet 503
 * mit `code: 'VISION_NOT_CONFIGURED'`; die Anwendung sagt dann sauber, dass
 * die Texterkennung nicht eingerichtet ist, statt still nichts zu tun.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.readTextWithVision = exports.visionConfigured = exports.VisionError = exports.VISION_MAX_BYTES = void 0;
const ENDPOINT = () => (process.env.OFFITEC_GOOGLE_VISION_ENDPOINT
    || 'https://vision.googleapis.com/v1/images:annotate');
const API_KEY = () => (process.env.OFFITEC_GOOGLE_VISION_API_KEY || '').trim();
/** Ein Ausschnitt ist klein; alles darüber ist ein Versehen oder ein Angriff. */
exports.VISION_MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
/* Etiketten sind deutsch oder englisch beschriftet. Der Hinweis kostet nichts
   und hält Vision davon ab, «Fön» als kyrillisch zu raten. */
const LANGUAGE_HINTS = ['de', 'en'];
class VisionError extends Error {
    code;
    status;
    /** Googles eigene Begruendung, wenn es eine gibt — fuer die Einrichtung. */
    detail;
    constructor(message, code, status, detail) {
        super(message);
        this.code = code;
        this.status = status;
        this.detail = detail;
    }
}
exports.VisionError = VisionError;
/* Gruende, die NICHT am Bild liegen, sondern am Google-Projekt: Abrechnung
   nicht eingeschaltet, Dienst nicht freigeschaltet, Schluessel gesperrt oder
   eingeschraenkt. Sie muessen sich anders anfuehlen als «der Ausschnitt wurde
   abgelehnt» — sonst sucht jemand den Fehler stundenlang bei seinem Foto.
   (Genau das ist am 02.09.2026 passiert: BILLING_DISABLED kam als
   VISION_REJECTED heraus.) */
const SETUP_REASONS = new Set([
    'BILLING_DISABLED',
    'SERVICE_DISABLED',
    'API_KEY_INVALID',
    'API_KEY_SERVICE_BLOCKED',
    'API_KEY_HTTP_REFERRER_BLOCKED',
    'API_KEY_IP_ADDRESS_BLOCKED',
    'API_KEY_ANDROID_APP_BLOCKED',
    'API_KEY_IOS_APP_BLOCKED',
    'ACCOUNT_STATE_INVALID',
]);
/** Den Grund aus `error.details[].reason` ziehen (dort steht er maschinenlesbar). */
const reasonOf = (error) => {
    for (const detail of error?.details ?? []) {
        if (typeof detail?.reason === 'string')
            return detail.reason;
    }
    return '';
};
/** Steht der Schlüssel? Ohne ihn hat die Route nichts zu tun. */
const visionConfigured = () => API_KEY().length > 0;
exports.visionConfigured = visionConfigured;
const boxOf = (polygons) => {
    const xs = [];
    const ys = [];
    for (const polygon of polygons) {
        for (const vertex of polygon?.vertices ?? []) {
            xs.push(Number(vertex.x) || 0);
            ys.push(Number(vertex.y) || 0);
        }
    }
    if (!xs.length)
        return { x0: 0, y0: 0, x1: 0, y1: 0 };
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};
const LINE_BREAKS = new Set(['LINE_BREAK', 'EOL_SURE_SPACE']);
const linesFromAnnotation = (annotation) => {
    const lines = [];
    let words = [];
    let polygons = [];
    let confidences = [];
    const flush = () => {
        const text = words.join(' ').replace(/\s+/g, ' ').trim();
        if (text) {
            const confidence = confidences.length
                ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
                : 0.9;
            lines.push({ text, confidence: Math.round(confidence * 100), box: boxOf(polygons) });
        }
        words = [];
        polygons = [];
        confidences = [];
    };
    for (const page of annotation?.pages ?? []) {
        for (const block of page?.blocks ?? []) {
            for (const paragraph of block?.paragraphs ?? []) {
                for (const word of paragraph?.words ?? []) {
                    const symbols = word?.symbols ?? [];
                    words.push(symbols.map((symbol) => String(symbol?.text ?? '')).join(''));
                    polygons.push(word?.boundingBox);
                    if (typeof word?.confidence === 'number')
                        confidences.push(word.confidence);
                    const lastBreak = symbols[symbols.length - 1]?.property?.detectedBreak?.type;
                    if (lastBreak && LINE_BREAKS.has(String(lastBreak)))
                        flush();
                }
                // Ein Absatz endet spätestens hier, auch ohne gemeldeten Umbruch.
                flush();
            }
        }
    }
    flush();
    return lines;
};
/**
 * Einen Bildausschnitt lesen lassen. `base64` ist der reine Inhalt ohne
 * `data:`-Kopf. Wirft `VisionError` mit einem Code, den die Route in eine
 * Antwort übersetzt.
 */
const readTextWithVision = async (base64) => {
    const key = API_KEY();
    if (!key)
        throw new VisionError('Texterkennung ist nicht eingerichtet.', 'VISION_NOT_CONFIGURED', 503);
    let response;
    try {
        response = await fetch(`${ENDPOINT()}?key=${encodeURIComponent(key)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                requests: [{
                        image: { content: base64 },
                        // TEXT_DETECTION ist der Modus für Fotos von Etiketten und
                        // Verpackungen; DOCUMENT_TEXT_DETECTION erwartet eine
                        // beschriebene Seite und liest Verpackungen schlechter.
                        features: [{ type: 'TEXT_DETECTION' }],
                        imageContext: { languageHints: LANGUAGE_HINTS },
                    }],
            }),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    }
    catch (error) {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        throw new VisionError(timedOut ? 'Die Texterkennung hat zu lange gebraucht.' : 'Die Texterkennung ist nicht erreichbar.', timedOut ? 'VISION_TIMEOUT' : 'VISION_UNREACHABLE', 504);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        const message = String(payload?.error?.message || '').slice(0, 400);
        const reason = reasonOf(payload?.error);
        console.error('[googleVisionOcr] Vision antwortete', response.status, reason || '(ohne Grund)', message);
        if (SETUP_REASONS.has(reason)) {
            // Nicht das Bild ist schuld, sondern das Google-Projekt. Der Satz
            // sagt das, und Googles Begruendung reist als `detail` mit — sie
            // enthaelt die Adresse, unter der es sich einschalten laesst.
            throw new VisionError('Die Texterkennung ist nicht freigeschaltet.', 'VISION_NOT_ENABLED', 503, message);
        }
        if (response.status === 429) {
            throw new VisionError('Die Texterkennung ist derzeit ausgelastet.', 'VISION_QUOTA', 429, message);
        }
        throw new VisionError('Die Texterkennung hat den Ausschnitt abgelehnt.', 'VISION_REJECTED', 502, message);
    }
    const first = payload?.responses?.[0];
    if (first?.error?.message) {
        console.error('[googleVisionOcr] Vision meldete', first.error.message);
        throw new VisionError('Die Texterkennung hat den Ausschnitt abgelehnt.', 'VISION_REJECTED', 502, String(first.error.message).slice(0, 400));
    }
    const annotation = first?.fullTextAnnotation;
    const lines = linesFromAnnotation(annotation);
    const text = String(annotation?.text ?? '').replace(/\s+/g, ' ').trim();
    return { text, lines };
};
exports.readTextWithVision = readTextWithVision;
//# sourceMappingURL=googleVisionOcr.js.map