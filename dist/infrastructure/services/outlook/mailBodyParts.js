"use strict";
/**
 * EINE ANTWORT IST NICHT EINE NACHRICHT (19.08.2026).
 *
 * Ein "RE:" bringt den ganzen bisherigen Verlauf mit: unter der eigentlichen
 * Antwort hängen die zitierten Vorgänger, oft mehrfach geschachtelt, dazu die
 * Signatur und die Platzhalter der Bilder. Bis hierher landete das als EIN
 * Block in `bodyText` — und in der Vorschau der Liste stand dann nicht, was
 * jemand geschrieben hat, sondern der Anfang eines drei Wochen alten Zitats.
 *
 * Dieses Modul zerlegt den Text in seine Teile:
 *
 *     bodyText  ─┬─ die NEUE Nachricht          → Vorschau + oberer Block
 *                ├─ zitierter Vorgänger 1       ┐ aufklappbar, je mit seiner
 *                ├─ zitierter Vorgänger 2       ┘ Kopfzeile ("Von: …")
 *                └─ Signatur / Bildplatzhalter  → fallen weg
 *
 * Es wird NICHTS am gespeicherten Text geändert: die Zerlegung geschieht beim
 * Lesen. Gespeichert bleibt der volle Text — wer im Zweifel nachsehen will,
 * soll das können; nur die VORSCHAU wird aus dem neuen Teil gebildet.
 *
 * Die Erkennung ist bewusst konservativ. Findet sie keine Grenze, bleibt alles
 * die neue Nachricht — lieber ein Zitat zu viel gezeigt als eine echte Antwort
 * verschluckt.
 *
 * DIESE DATEI IST DOPPELT VORHANDEN (Server + Browser, wie `formFields.ts`):
 * `ErpFront/offitec-frontend/src/pages/crm/mail/mailBodyParts.ts`. Änderungen
 * gehören in beide.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mainBodyOf = exports.splitMailBody = exports.stripImagePlaceholders = void 0;
/* Woran eine zitierte Vorgängernachricht beginnt. Jede Sprache der Häuser, mit
   denen gearbeitet wird, plus die Trennlinie, die Outlook selbst setzt. */
const QUOTE_STARTERS = [
    // Outlooks eigene Trennlinie (eine Reihe Unterstriche auf eigener Zeile)
    /^_{10,}\s*$/,
    // "-----Original Message-----" / "-----Ursprüngliche Nachricht-----"
    /^\s*-{2,}\s*(original message|ursprüngliche nachricht|urspruengliche nachricht|orijinal ileti|weitergeleitete nachricht|forwarded message)\s*-{2,}\s*$/i,
    // Outlook-Kopfblock: "Von: …" / "From: …" / "Kimden: …" am Zeilenanfang
    /^\s*(von|from|kimden|gönderen|gonderen|de)\s*:\s*.+$/i,
    // "Am 12.08.2026 um 09:14 schrieb Max Muster:" / "On … wrote:" / "… şunu yazdı:"
    /^\s*(am|on)\b.{0,120}\b(schrieb|wrote)\b.{0,120}:\s*$/i,
    /^\s*.{0,160}\bşunu yazdı\s*:\s*$/i,
    /^\s*.{0,160}\bsunu yazdi\s*:\s*$/i,
];
/** Die Signaturgrenze nach RFC 3676: eine Zeile aus genau "-- ". */
const SIGNATURE_LINE = /^--\s?$/;
/* Die WENIGSTEN Signaturen tragen diese Zeile — Outlook setzt sie nicht. Was
   sie stattdessen alle haben: eine Grussformel, und darunter eine Visitenkarte
   aus Name, Funktion, Adresse, Telefon, Web.

   Darum wird die Grussformel allein NICHT geschnitten: «Gruss / Alessio» ist
   die Unterschrift unter dem Text und gehört zur Nachricht. Geschnitten wird
   erst, wenn hinter der Formel eine Visitenkarte steht — gemessen an harten
   Merkmalen (Telefonnummer, Postleitzahl, Web, Adresse, Rechtsform). Das
   trennt die getippte Verabschiedung vom angehängten Briefkopf. */
const GREETINGS = [
    /^\s*(mit\s+)?(freundliche[nrm]?\s+)?gr(ü|ue|u)(ss|ß)e?n?\b/i,
    /^\s*(beste|viele|liebe|herzliche|schöne)\s+gr(ü|ue|u)(ss|ß)e?n?\b/i,
    /^\s*(best|kind|warm)\s+regards\b/i,
    /^\s*(sincerely|regards|cheers)\b/i,
    /^\s*sayg(ı|i)lar(ı|i)m(ı|i)zla\b/i,
    /^\s*iyi\s+(çal(ı|i)şmalar|günler|gunler|akşamlar)\b/i,
];
const CONTACT_MARKERS = [
    /\b(tel|fon|phone|mobil|mobile|fax|gsm|direkt)\b\s*[.:+]/i,
    /\+\d{2,3}[\s\d/().-]{6,}/,
    /\b[A-Z]{2}-\d{4,5}\b/,
    /https?:\/\//i,
    /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/,
    /\b(AG|GmbH|SA|SARL|Ltd|Inc)\b/,
];
/** Wie viele Zeilen eine Visitenkarte höchstens hat — darüber ist es Text. */
const MAX_SIGNATURE_LINES = 30;
/** So viele harte Merkmale muss der Block tragen, um als Briefkopf zu gelten. */
const MIN_CONTACT_MARKERS = 2;
/**
 * Findet die Zeile, ab der die angehängte Signatur beginnt — oder -1.
 * Gesucht wird von HINTEN: die letzte Grussformel, hinter der eine
 * Visitenkarte steht.
 */
const signatureStart = (lines) => {
    for (let index = lines.length - 1; index > 0; index -= 1) {
        if (!GREETINGS.some((pattern) => pattern.test(lines[index])))
            continue;
        const trailing = lines.slice(index + 1);
        if (!trailing.length || trailing.length > MAX_SIGNATURE_LINES)
            continue;
        const block = trailing.join("\n");
        const markers = CONTACT_MARKERS.filter((pattern) => pattern.test(block)).length;
        if (markers < MIN_CONTACT_MARKERS)
            continue;
        // Vor der Formel muss noch eine Nachricht stehen; sonst wäre alles Signatur.
        if (!lines.slice(0, index).some((line) => line.trim()))
            continue;
        return index;
    }
    return -1;
};
/* Platzhalter, die beim Umwandeln von HTML in Text von Bildern übrig bleiben.
   Sie sagen nichts und stehen sonst mitten im Satz. */
const IMAGE_PLACEHOLDERS = [
    /\[cid:[^\]]*\]/gi,
    /\[image:[^\]]*\]/gi,
    /\[bild:[^\]]*\]/gi,
    /\[resim:[^\]]*\]/gi,
    /<https?:\/\/[^>]*\.(?:png|jpe?g|gif|bmp|webp|svg)(?:\?[^>]*)?>/gi,
];
const isQuoteStart = (line) => QUOTE_STARTERS.some((pattern) => pattern.test(line));
/** Bildplatzhalter raus, Leerraum aufräumen. */
const stripImagePlaceholders = (text) => {
    let out = text;
    for (const pattern of IMAGE_PLACEHOLDERS)
        out = out.replace(pattern, "");
    return out
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
};
exports.stripImagePlaceholders = stripImagePlaceholders;
/**
 * Zerlegt einen Nachrichtentext. `>`-Zeilen zählen erst als Zitat, wenn sie
 * einen Block bilden — ein einzelnes ">" mitten im Satz ist keines.
 */
const splitMailBody = (raw) => {
    const text = String(raw || "").replace(/\r\n?/g, "\n");
    if (!text.trim())
        return { body: "", quoted: [], signature: null };
    const lines = text.split("\n");
    const parts = [];
    let current = { header: null, text: "" };
    let buffer = [];
    const flush = () => {
        current.text = buffer.join("\n").trim();
        if (current.text || current.header)
            parts.push(current);
        buffer = [];
    };
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        // Eine Kopfzeile öffnet einen neuen Abschnitt; sie selbst wandert in
        // den Titel, damit der Block im Lesebereich benannt ist.
        if (isQuoteStart(line)) {
            flush();
            current = { header: line.trim().replace(/^_+$/, "").trim() || null, text: "" };
            continue;
        }
        // Ein Block aus ">"-Zeilen: der ganze Rest ist zitiert.
        if (/^\s*>/.test(line) && parts.length === 0 && buffer.some((entry) => entry.trim())) {
            flush();
            current = { header: null, text: "" };
            buffer = lines.slice(index).map((entry) => entry.replace(/^\s*>\s?/, ""));
            break;
        }
        buffer.push(line);
    }
    flush();
    const [first, ...rest] = parts;
    let body = first?.text || "";
    // Ein Zitat ganz ohne eigenen Text davor ist keine Antwort, sondern eine
    // Weiterleitung — dann ist der erste Block die Nachricht.
    const quoted = rest.filter((part) => part.text || part.header);
    // Signatur abtrennen: die RFC-Zeile "-- " ist die einzige verlässliche
    // Grenze. Alles danach ist Anhang der Person, nicht der Nachricht.
    let signature = null;
    const bodyLines = body.split("\n");
    // Zuerst die harte Grenze, dann die Visitenkarten-Erkennung.
    let cut = bodyLines.findIndex((line) => SIGNATURE_LINE.test(line));
    // Ohne "-- " ist die Grussformel selbst schon Teil der Signatur.
    const dropDelimiter = cut >= 0;
    if (cut < 0)
        cut = signatureStart(bodyLines);
    if (cut >= 0) {
        signature = bodyLines.slice(dropDelimiter ? cut + 1 : cut).join("\n").trim() || null;
        body = bodyLines.slice(0, cut).join("\n");
    }
    return {
        body: (0, exports.stripImagePlaceholders)(body),
        quoted: quoted.map((part) => ({ header: part.header, text: (0, exports.stripImagePlaceholders)(part.text) })),
        signature,
    };
};
exports.splitMailBody = splitMailBody;
/** Nur der neue Teil — die Grundlage der Vorschau in der Liste. */
const mainBodyOf = (raw) => (0, exports.splitMailBody)(raw).body;
exports.mainBodyOf = mainBodyOf;
//# sourceMappingURL=mailBodyParts.js.map