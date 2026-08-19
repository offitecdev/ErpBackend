"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.brandWaveInline = exports.brandLogoInline = exports.BRAND_ICON_TASK_CID = exports.BRAND_ICON_APPOINTMENT_CID = exports.BRAND_TASK = exports.BRAND_RED = exports.BRAND_NAVY = exports.BRAND_WAVE_CID = exports.BRAND_LOGO_CID = void 0;
const mailWaveAsset_1 = require("./mailWaveAsset");
/**
 * MARKENZEICHEN FÜR SYSTEM-MAILS (18.08.2026).
 *
 * Das Offitec-Logo (der Stern aus `public/fav4.svg` im Frontend), als PNG
 * 128×128 mit transparentem Hintergrund. Es liegt HIER als Base64-Konstante,
 * weil eine Mail keinen Zugriff auf das Frontend hat und ein SVG in
 * Mailprogrammen nicht verlässlich dargestellt wird (Outlook zeigt gar keins).
 * Eingebettet wird es als Inline-Bild mit Content-ID (`cid:`), nicht als
 * Anhang — so erscheint es in der Nachricht selbst, ohne dass der Empfänger
 * externe Bilder freigeben muss.
 *
 * Neu erzeugen: fav4.svg mit Chrome (headless, 128×128, transparenter
 * Hintergrund) als PNG rendern und Base64 hier einsetzen.
 */
exports.BRAND_LOGO_CID = "offitec-brand-logo";
/** Die Welle aus dem Briefkopf — dasselbe Bild wie im Angebots-PDF. */
exports.BRAND_WAVE_CID = "offitec-brand-wave";
exports.BRAND_NAVY = "#1f2654";
exports.BRAND_RED = "#d30f15";
/**
 * DIE FARBE DER AUFGABENKARTE (19.08.2026, Vorgabe Samet: "wie die Terminkarte,
 * aber eine andere Farbe"). Dasselbe Gruen, das die Aufgabe im Kalender traegt
 * (`--ofi-cal-task`) — wer die Aufgabe dort kennt, erkennt die Mail sofort.
 */
exports.BRAND_TASK = "#0f766e";
/**
 * DIE ZEICHEN DER KARTE (19.08.2026). Ein Kalenderblatt fuer Termine und
 * Besprechungen, ein Haken im Kreis fuer Aufgaben. Beide liegen als weisses
 * PNG auf durchsichtigem Grund in `mailKindIcons.ts`; die Farbe kommt aus der
 * Zelle darunter.
 */
exports.BRAND_ICON_APPOINTMENT_CID = "offitec-kind-appointment";
exports.BRAND_ICON_TASK_CID = "offitec-kind-task";
const BRAND_LOGO_PNG_BASE64 = "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";
/** Inline-Bild für `SendMailInput.inlineImages`; im HTML per `cid:${BRAND_LOGO_CID}` referenzieren. */
const brandLogoInline = () => ({
    cid: exports.BRAND_LOGO_CID,
    contentType: "image/png",
    contentBase64: BRAND_LOGO_PNG_BASE64,
});
exports.brandLogoInline = brandLogoInline;
/**
 * Die Welle für den Briefkopf der Mail (`cid:${BRAND_WAVE_CID}`). Sie steht
 * rechts neben dem Logo — genau wie auf der ersten Seite des Angebots-PDF.
 */
const brandWaveInline = () => ({
    cid: exports.BRAND_WAVE_CID,
    contentType: "image/png",
    contentBase64: mailWaveAsset_1.BRAND_WAVE_PNG_BASE64,
});
exports.brandWaveInline = brandWaveInline;
//# sourceMappingURL=mailBrand.js.map