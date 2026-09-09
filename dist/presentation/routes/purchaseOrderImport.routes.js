"use strict";
/**
 * BELEG-IMPORT DER LIEFERANTENBESTELLUNG (07.09.2026, Vorgabe Samet)
 *
 * «Beim Bestellen nehmen wir ein PDF oder ein Bild, wandeln es in Text und
 *  geben es dem Modell — GPT-4o mini oder 4o, ich will die günstige
 *  Möglichkeit. Zurück kommt JSON nach unserer Vorlage. Es soll NUR das
 *  herausziehen, was in der Vorlage steht. Danach eine eigene Rechenstufe:
 *  Lieferant, Rabatte, Steuersatz, Mengenstaffel.»
 *
 * Dieser Router trägt beide Hälften und NUR sie — er hängt unter
 * `/inventory/purchase-orders` und rührt an keiner anderen Stelle des Lagers:
 *
 *   POST /ai-extract          Beleg → Modell → Positionen (+ Nutzung).
 *                             PDF und Tabelle gehen als TEXT, ein Foto geht als
 *                             BILD — dort sieht das Modell die Spalten selbst.
 *   GET  /ai-status           Steht der Schlüssel? Welches Modell? Welche Spalten?
 *   …    /supplier-templates  Die Rechenvorlage je Lieferant (Liste/anlegen/…)
 *
 * Der lange Weg über den Server hat einen einzigen Grund: der Schlüssel darf
 * nicht im Browser-Bündel liegen. Wer die Seite öffnet, könnte ihn sonst lesen
 * und auf unsere Rechnung rechnen lassen.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.purchaseOrderImportRouter = void 0;
const express_1 = require("express");
const nanoid_1 = require("nanoid");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const RateLimitMiddleware_1 = require("../middlewares/RateLimitMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const documentText_1 = require("../../infrastructure/services/documentText");
const gptExtract_1 = require("../../infrastructure/services/gptExtract");
exports.purchaseOrderImportRouter = (0, express_1.Router)();
/* ── Grenzen ──────────────────────────────────────────────────────────────
   Ein Beleg ist eine Handvoll Seiten. Die Stückgrösse ist bewusst kleiner als
   die Obergrenze des Textes: ein zu langes Stück lässt die Antwort mitten im
   JSON abreissen, und eine halb gelesene Bestellung ist schlimmer als eine
   abgelehnte, weil sie glaubwürdig aussieht. */
const CHUNK_CHARS = Number(process.env.gptChunkChars || 18_000);
/** Höchstens so viele Durchgänge je Beleg — die Obergrenze der Rechnung. */
const MAX_CHUNKS = Number(process.env.gptMaxChunks || 6);
/**
 * Die Erkennung kostet Geld, also zählt sie je BENUTZER, nicht je Anschluss:
 * ein ganzes Büro sitzt hinter einer Adresse, und eine Grenze je Adresse
 * sperrte dort alle aus, während sie das einzelne Konto gar nicht schützte.
 */
const extractRateLimiter = (0, RateLimitMiddleware_1.rateLimit)({
    windowMs: 60 * 60 * 1000,
    max: Number(process.env.gptHourlyLimit || 60),
    message: 'Zu viele Belege in kurzer Zeit. Bitte später erneut versuchen.',
    keyBy: (req) => (req.user?.id ? `gpt:${req.user.id}` : null),
});
/* ── Rechenvorlage: Gestalt und Prüfung ───────────────────────────────────
   Die Vorlage kommt aus dem Browser und wird hier vollständig neu aufgebaut —
   nie durchgereicht. Was nicht in dieser Funktion steht, steht auch nicht in
   der Datenbank. */
/** Die drei Berechnungsarten des Hauses — mehr gibt es nicht. */
const CALC_MODES = new Set(['AUTO', 'DIRECT', 'SUPPLIER']);
const TEMPLATE_DOCUMENT_TYPES = new Set(['ORDER', 'PRICE_REQUEST', 'GOODS_RECEIPT']);
const templateDocumentType = (value) => TEMPLATE_DOCUMENT_TYPES.has(String(value).toUpperCase())
    ? String(value).toUpperCase()
    : 'ORDER';
const clampPercent = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return 0;
    return Math.round(Math.min(100, Math.max(0, parsed)) * 100) / 100;
};
const positiveNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1e6) / 1e6 : 0;
};
/**
 * DIE SCHLÜSSELZUORDNUNG: welche SPALTE welche Rolle in der Bestellzeile
 * spielt. Die Werte sind Spaltenschlüssel der Vorlage; ein Wert, den es dort
 * nicht gibt, wird zu «nicht besetzt» — sonst zeigte eine Zuordnung ins Leere,
 * nachdem jemand die Spalte gelöscht hat.
 */
const ROLE_KEYS = ['code', 'name', 'quantity', 'unit', 'price', 'discount', 'discount2', 'total', 'totalGross'];
const normalizeConfig = (raw) => {
    const columns = (0, gptExtract_1.normalizeColumns)(raw?.columns);
    const known = new Set(columns.map((column) => column.key));
    const discounts = (Array.isArray(raw?.discounts) ? raw.discounts : [])
        .map(clampPercent)
        .filter((value) => value > 0)
        // Die Bestelltabelle trägt Rabatt + EINEN Zusatzrabatt. Mehr anzunehmen
        // hiesse, den dritten still fallen zu lassen.
        .slice(0, 2);
    const qtyTiers = (Array.isArray(raw?.qtyTiers) ? raw.qtyTiers : [])
        .map((tier) => ({
        minQuantity: positiveNumber(tier?.minQuantity),
        discount: clampPercent(tier?.discount),
        unitPrice: positiveNumber(tier?.unitPrice),
    }))
        .filter((tier) => tier.minQuantity > 0 && (tier.discount > 0 || tier.unitPrice > 0))
        .sort((a, b) => a.minQuantity - b.minQuantity)
        .slice(0, 12);
    const roles = {};
    for (const role of ROLE_KEYS) {
        const value = String(raw?.roles?.[role] ?? '').trim();
        roles[role] = known.has(value) ? value : '';
    }
    return {
        // Vorgabe ist die manuelle Eingabe: sie rechnet nichts und ist damit
        // die einzige Art, die ohne weitere Angaben richtig liegt.
        calcMode: CALC_MODES.has(String(raw?.calcMode)) ? String(raw.calcMode) : 'DIRECT',
        columns,
        discount2Enabled: raw?.discount2Enabled !== false,
        extraColumns: (0, gptExtract_1.normalizeColumns)(raw?.extraColumns).map((column, index) => ({
            ...column,
            width: Math.round(Math.min(240, Math.max(80, Number(raw?.extraColumns?.[index]?.width) || 120))),
        })),
        hiddenColumnKeys: (Array.isArray(raw?.hiddenColumnKeys) ? raw.hiddenColumnKeys : [])
            .map((key) => String(key).trim())
            .filter((key, index, list) => /^[a-zA-Z][a-zA-Z0-9]{0,15}$/.test(key) && list.indexOf(key) === index)
            .slice(0, gptExtract_1.TEMPLATE_MAX_COLUMNS),
        withTiers: Boolean(raw?.withTiers),
        roles,
        discounts,
        vatRate: clampPercent(raw?.vatRate),
        vatCountry: String(raw?.vatCountry ?? '').trim().slice(0, 80),
        currency: String(raw?.currency ?? 'CHF').trim().slice(0, 8).toUpperCase() || 'CHF',
        qtyTiers,
    };
};
/** Zeile der Datenbank → Antwort (die Einstellung reist als Objekt, nicht als Text). */
const parseTemplateRow = (row) => {
    let config;
    try {
        config = normalizeConfig(JSON.parse(String(row?.config ?? '{}')));
    }
    catch {
        // Eine unlesbare Einstellung darf die Liste nicht sprengen — sie kommt
        // als Vorgabe zurück und lässt sich überschreiben.
        config = normalizeConfig({});
    }
    return {
        id: row.id,
        supplierId: row.supplierId ?? null,
        supplierName: row.supplierName ?? '',
        title: row.title ?? '',
        documentType: templateDocumentType(row.documentType),
        isDefault: Boolean(row.isDefault),
        usageCount: Number(row.usageCount) || 0,
        config,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
};
/* ═══════════════════════════════════════════════════════════════════════════
   1) ZUSTAND — steht die Erkennung überhaupt bereit?
   ═════════════════════════════════════════════════════════════════════════ */
/**
 * @swagger
 * /inventory/purchase-orders/ai-status:
 *   get:
 *     tags: [Inventory]
 *     summary: Beleg-Erkennung — Bereitschaft, Modell und Spaltenkatalog
 *     description: >
 *       Sagt der Oberfläche VOR dem Hochladen, ob ein Schlüssel steht
 *       (`gptApi`), welches Modell arbeitet und welche Spalten eine Vorlage
 *       enthalten darf. Ohne diesen Aufruf müsste die Anwendung den Anwender
 *       erst eine Datei wählen lassen, um ihm dann zu sagen, dass nichts
 *       eingerichtet ist.
 *     security:
 *       - bearerAuth: []
 */
exports.purchaseOrderImportRouter.get('/ai-status', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (_req, res) => {
    res.status(200).json({
        configured: (0, gptExtract_1.gptConfigured)(),
        model: (0, gptExtract_1.gptModelName)(),
        maxChars: documentText_1.DOCUMENT_MAX_CHARS,
        chunkChars: CHUNK_CHARS,
        maxChunks: MAX_CHUNKS,
        minColumns: gptExtract_1.TEMPLATE_MIN_COLUMNS,
        maxColumns: gptExtract_1.TEMPLATE_MAX_COLUMNS,
    });
});
/* ═══════════════════════════════════════════════════════════════════════════
   2) DIE ERKENNUNG
   ═════════════════════════════════════════════════════════════════════════ */
/**
 * Zwei Positionen sind dieselbe, wenn ALLE gelesenen Spalten übereinstimmen.
 * Welche das sind, weiss erst die Vorlage — darum wird der Schlüssel aus den
 * Spalten gebaut und nicht aus festen Feldnamen. Gebraucht wird er nur für die
 * zwei Zeilen Überlappung zwischen den Stücken (siehe `chunkText`).
 */
const rowKey = (row, columns) => {
    /* Der Zeilenanker schlägt die Spaltenwerte: zwei Stücke, die DIESELBE
       gedruckte Zeile gelesen haben, schreiben denselben Satz ab — während
       zwei verschiedene Positionen sehr wohl in allen Spalten gleich aussehen
       dürfen (dieselbe Verschraubung für zwei Stellen). Nur wo der Anker fehlt,
       entscheiden wie bisher die Werte. */
    const anchor = String(row[gptExtract_1.SOURCE_LINE_FIELD] ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (anchor)
        return `line:${anchor}`;
    return columns
        .map((column) => String(row[column.key] ?? '').trim().toLowerCase().replace(/\s+/g, ' '))
        .join('|');
};
const emptyUsage = () => ({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedUsd: 0,
    chunks: 0,
});
/**
 * ── IST DIE LADUNG EIN BILD? ────────────────────────────────────────────────
 * Nur dann nimmt der Beleg den kurzen Weg direkt ans Modell. Entschieden wird
 * nach MIME-Typ und Dateiendung — dieselbe Frage, die die Bestellseite schon
 * beim Auswaehlen stellt (`isImageFile`).
 *
 * Ein PDF ist bewusst NICHT dabei: seine Textlage ist exakt und kostet fast
 * nichts. Ein eingescanntes PDF ohne Textlage bleibt der eine Fall, fuer den
 * `readDocumentText` weiterhin um ein Foto der Seite bittet.
 */
const IMAGE_MIME = /^image\//i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|heic|heif)$/i;
const MAX_IMAGE_COUNT = 6;
const parseImageInput = (body) => {
    const raw = typeof body?.data === 'string' ? body.data.trim() : '';
    if (!raw)
        return undefined;
    const declared = String(body?.mimeType || '').trim();
    const fileName = String(body?.fileName || '').trim();
    /* Die Route nimmt BEIDE Formen an (so steht es auch in der Beschreibung):
       den reinen Base64-Inhalt, den die Bestellseite schickt, und einen
       vollen `data:`-Kopf. Der Kopf muss hier weg — das Modell bekommt gleich
       einen eigenen, und zwei davon ergeben ein unlesbares Bild. */
    const header = /^data:([^;,]+)?[^,]*,/i.exec(raw);
    const data = header ? raw.slice(header[0].length) : raw;
    if (!data)
        return undefined;
    const mimeType = [header?.[1] ?? '', declared].find((value) => IMAGE_MIME.test(value.trim()))?.trim();
    const isImage = Boolean(mimeType) || IMAGE_EXT.test(fileName);
    if (!isImage)
        return undefined;
    /* Das Modell braucht einen echten Typ im `data:`-Kopf; fehlt er, ist JPEG
       die vertraeglichste Annahme (jedes Telefonfoto ist eines). */
    return { data, mimeType: mimeType || 'image/jpeg' };
};
/** Legacy single-image bodies and the new ordered multi-image body share one path. */
const pickImageInputs = (body) => {
    if (!Array.isArray(body?.images)) {
        const single = parseImageInput(body);
        return single ? [single] : [];
    }
    return body.images
        .slice(0, MAX_IMAGE_COUNT)
        .map((entry) => parseImageInput(entry))
        .filter((entry) => Boolean(entry));
};
/**
 * @swagger
 * /inventory/purchase-orders/ai-extract:
 *   post:
 *     tags: [Inventory]
 *     summary: Beleg (PDF / Foto / Tabelle) in Bestellpositionen lesen
 *     description: >
 *       PDF und Tabelle werden ZUERST in Text gewandelt — das PDF über seine
 *       Textlage, die Tabelle bringt der Browser schon als Text mit — und erst
 *       dieser Text geht an das Sprachmodell. Ein FOTO geht seit dem 08.09.2026
 *       direkt an das Modell: es sieht selbst, und damit entfällt der fremde
 *       Texterkenner samt Schlüssel und Freischaltung. Ein Bild kostet mehr
 *       Token als dieselbe Seite als Text — dafür sieht das Modell die Spalten
 *       des Belegs statt einer flachgeklopften Zeilenfolge.
 *       Zurück kommen die Positionen genau in den Spalten der übergebenen
 *       Vorlage, in der Sprache der Anwendung, samt der tatsächlichen
 *       Tokennutzung.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               data: { type: string, description: "data:…;base64,… oder reiner Base64-Inhalt (max. 11 MB)" }
 *               text: { type: string, description: "Fertiger Text — der Weg für xlsx/csv, die der Browser bereits liest" }
 *               fileName: { type: string }
 *               mimeType: { type: string }
 *               images:
 *                 type: array
 *                 maxItems: 6
 *                 description: "Ordered photos; each is transcribed separately and all transcripts share one extraction request"
 *                 items:
 *                   type: object
 *                   required: [data]
 *                   properties:
 *                     data: { type: string }
 *                     fileName: { type: string }
 *                     mimeType: { type: string }
 *               documentType:
 *                 type: string
 *                 enum: [ORDER, PRICE_REQUEST, GOODS_RECEIPT]
 *               language: { type: string, description: "de | en | tr — die Sprache, in der die Textwerte zurückkommen" }
 *               fields:
 *                 type: array
 *                 items: { type: string }
 *                 description: "Die Vorlage: Spaltenschlüssel aus /ai-status"
 *               withTiers: { type: boolean, description: "Mengenstaffel des Belegs mitlesen" }
 */
exports.purchaseOrderImportRouter.post('/ai-extract', AuthMiddleware_1.requireAuth, 
// Lesen darf, wer damit auch bestellen kann — sonst wäre die Route ein
// offener Übersetzer auf unsere Rechnung.
(0, RbacMiddleware_1.requirePermission)('inventory.transfer'), extractRateLimiter, async (req, res) => {
    try {
        if (!(0, gptExtract_1.gptConfigured)()) {
            return res.status(503).json({
                error: 'Die KI-Erkennung ist nicht eingerichtet (gptApi fehlt).',
                code: 'GPT_NOT_CONFIGURED',
            });
        }
        const language = ['de', 'en', 'tr'].includes(String(req.body?.language))
            ? String(req.body.language)
            : 'de';
        const columns = (0, gptExtract_1.normalizeColumns)(req.body?.columns);
        if (columns.length < gptExtract_1.TEMPLATE_MIN_COLUMNS) {
            return res.status(400).json({
                error: `Die Vorlage braucht mindestens ${gptExtract_1.TEMPLATE_MIN_COLUMNS} Spalten.`,
                code: 'GPT_TOO_FEW_COLUMNS',
            });
        }
        const withTiers = Boolean(req.body?.withTiers);
        const documentType = templateDocumentType(req.body?.documentType);
        const includeDocumentHeader = documentType !== 'GOODS_RECEIPT';
        /* ── Schritt 1: WORAUS gelesen wird ─────────────────────────────
           EIN FOTO GEHT UNGELESEN WEITER. Genau das stand seit dem
           08.09.2026 in den Beschreibungen dieses Moduls, war aber nie
           angeschlossen: `pickImageInput` wurde geschrieben und nie
           gerufen, und jedes Bild lief weiter durch den Texterkenner.

           Das ist der Grund für das Fehlerbild Samet («im Bild ordnet es
           vieles falsch zu»): OCR gibt eine Tabelle als flache Zeilenfolge
           zurück, `compactText` staucht danach jeden Leerraum auf EIN
           Leerzeichen — und damit ist die Spaltenflucht, an der Menge,
           Listenpreis und Nettopreis auseinanderzuhalten wären, endgültig
           fort. Das Modell bekam einen Text, in dem die Zuordnung gar
           nicht mehr steht, und riet sie.

           Jetzt sieht es die Seite selbst, mit ihren Spalten. */
        if (Array.isArray(req.body?.images) && req.body.images.length > MAX_IMAGE_COUNT) {
            return res.status(400).json({
                error: `Es koennen hoechstens ${MAX_IMAGE_COUNT} Bilder gemeinsam gelesen werden.`,
                code: 'DOCUMENT_TOO_MANY_IMAGES',
            });
        }
        const images = pickImageInputs(req.body);
        const imageBytes = images.reduce((sum, image) => sum + (image.data.length * 3) / 4, 0);
        if (images.length && imageBytes > documentText_1.DOCUMENT_MAX_BYTES) {
            return res.status(413).json({
                error: 'Die Bilder sind zusammen zu gross (max. 11 MB).',
                code: 'DOCUMENT_TOO_LARGE',
            });
        }
        /* ── ZUERST ABSCHREIBEN, DANN ZUORDNEN ──────────────────────────
           Vorgabe Samet (08.09.2026): «Es muss zuerst eine ORDENTLICHE
           Umwandlung geben, und danach geht es an das Modell — nicht
           direkt an das Modell.»

           Eine Aufnahme wird darum in zwei Schritten gelesen:
             1. `transcribeImage` — dasselbe sehende Modell schreibt die
                Tabelle ab, Zeile fuer Zeile, Zellen mit Tabulator,
                leere Zelle bleibt leer. Mehr tut es nicht.
             2. Diese Abschrift geht als TEXT durch denselben Weg wie
                eine Excel-Datei — mit der Kopfzeile davor, an der sich
                die Zuordnung ausrichtet.

           Der Gewinn ist nicht nur die Genauigkeit: die Zwischenstufe
           ist LESBAR. Was das Modell gesehen hat, steht als Tabelle in
           der Antwort (`transcript`) und laesst sich mit dem Blatt
           vergleichen. Vorher war zwischen Aufnahme und fertiger
           Bestellung nichts zu sehen. */
        /* Each photo is transcribed independently, preserving page boundaries.
           Only after that are the page texts assembled into ONE structured
           extraction prompt, in capture order. */
        const transcripts = images.length
            ? await Promise.all(images.map((image) => (0, gptExtract_1.transcribeImage)(image)))
            : [];
        const transcriptText = transcripts.length
            ? [
                'The following sections are consecutive images of ONE document.',
                'Each image was transcribed independently. Process every section in image order; do not merge neighbouring rows.',
                ...transcripts.map((transcript, index) => [
                    `=== IMAGE ${index + 1} OF ${transcripts.length} ===`,
                    transcript.header ? `HEADER\t${transcript.header}` : 'HEADER\t',
                    ...transcript.lines,
                    `=== END IMAGE ${index + 1} ===`,
                ].join('\n')),
            ].join('\n')
            : '';
        if (transcripts.length && transcripts.every((transcript) => transcript.lines.length === 0)) {
            return res.status(422).json({
                error: 'Auf dem Beleg wurde keine Tabelle gefunden.',
                code: 'GPT_NO_TABLE',
            });
        }
        const read = images.length
            ? {
                source: 'image',
                engine: 'gpt-vision',
                text: transcriptText,
                rawChars: transcriptText.length,
                chars: transcriptText.length,
                truncated: false,
            }
            : await (0, documentText_1.readDocumentText)({
                data: req.body?.data,
                text: req.body?.text,
                fileName: req.body?.fileName,
                mimeType: req.body?.mimeType,
            });
        /* ── Schritt 2: Tabelle → Positionen ────────────────────────────
           Ab hier gibt es nur noch EINEN Weg: Text. Die Abschrift einer
           Aufnahme wird genauso behandelt wie eine Excel-Tabelle, nur
           dass sie in einem Stueck bleibt — eine halbe Tabelle ans
           Modell zu schicken hiesse, sie mitten in der Zeile zu
           zerteilen. */
        const chunks = images.length ? [] : (0, documentText_1.chunkText)(read.text, CHUNK_CHARS);
        const used = chunks.slice(0, MAX_CHUNKS);
        const passes = images.length
            ? [{ text: transcriptText }]
            : used.map((chunk) => ({ text: chunk }));
        const usage = emptyUsage();
        /* Die erste Stufe kostet auch — sie gehoert in die Rechnung. */
        if (transcripts.length) {
            for (const transcript of transcripts) {
                usage.promptTokens += transcript.usage.promptTokens;
                usage.completionTokens += transcript.usage.completionTokens;
                usage.totalTokens += transcript.usage.totalTokens;
                if (usage.estimatedUsd !== null && transcript.usage.estimatedUsd !== null) {
                    usage.estimatedUsd = Math.round((usage.estimatedUsd + transcript.usage.estimatedUsd) * 1e6) / 1e6;
                }
                else {
                    usage.estimatedUsd = null;
                }
                usage.chunks += 1;
            }
        }
        const merged = [];
        const seen = new Set();
        let document = {
            supplierName: null, documentNumber: null, documentDate: null,
            currency: null, vatRate: null, totalNet: null,
        };
        /* Was auf dem Weg hierher WEGFIEL. Frueher fiel es still weg;
           jetzt steht die Zahl in der Antwort, damit die Oberflaeche
           sagen kann, dass die Liste kuerzer ist als der Beleg. */
        let dropped = 0;
        for (const pass of passes) {
            const result = await (0, gptExtract_1.extractWithGpt)({
                ...pass,
                columns,
                language,
                withTiers,
                includeDocumentHeader,
            });
            usage.promptTokens += result.usage.promptTokens;
            usage.completionTokens += result.usage.completionTokens;
            usage.totalTokens += result.usage.totalTokens;
            if (usage.estimatedUsd !== null && result.usage.estimatedUsd !== null) {
                usage.estimatedUsd = Math.round((usage.estimatedUsd + result.usage.estimatedUsd) * 1e6) / 1e6;
            }
            else {
                usage.estimatedUsd = null;
            }
            usage.chunks += 1;
            /* Kopfdaten stehen auf der ERSTEN Seite. Ein späteres Stück
               darf sie ergänzen, aber nicht überschreiben — sonst gewinnt
               die Fusszeile der letzten Seite über den Briefkopf. */
            document = {
                supplierName: document.supplierName ?? result.supplierName,
                documentNumber: document.documentNumber ?? result.documentNumber,
                documentDate: document.documentDate ?? result.documentDate,
                currency: document.currency ?? result.currency,
                vatRate: document.vatRate ?? result.vatRate,
                totalNet: document.totalNet ?? result.totalNet,
            };
            for (const row of result.rows) {
                if (!row || typeof row !== 'object')
                    continue;
                /* ── EINE LEERE ZELLE IST KEINE LEERE ZEILE ──────────
                   Fehlerbild Samet (08.09.2026): «Es koennen leere
                   Zellen dabei sein oder Zeilen, die trotzdem mit
                   muessen.»

                   Hier stand die Pruefung ueber die SPALTEN allein: eine
                   Zeile, deren Zellen das Modell nicht zuordnen konnte,
                   fiel weg — und mit ihr rutschte alles darunter um eine
                   Zeile herauf. Genau das Fehlerbild, das die Anzahl
                   nicht mehr stimmen liess.

                   Der Zeilenanker zaehlt jetzt mit. Er traegt die
                   gedruckte Zeile im Wortlaut: steht er, gab es die
                   Zeile, und sie bleibt — auch wenn keine einzige Spalte
                   zugeordnet werden konnte. Weg faellt nur, was
                   ueberhaupt nichts traegt. */
                const cellValue = (key) => {
                    const value = row[key];
                    // 0 ist ein Wert. `String(0)` ist «0» und damit gefuellt;
                    // null/undefined werden zur leeren Zeichenkette.
                    return value === null || value === undefined ? '' : String(value).trim();
                };
                const hasContent = Boolean(cellValue(gptExtract_1.SOURCE_LINE_FIELD))
                    || columns.some((column) => cellValue(column.key));
                if (!hasContent) {
                    dropped += 1;
                    continue;
                }
                /* Die zwei Zeilen Überlappung zwischen den Stücken (siehe
                   `chunkText`) dürfen keine Position verdoppeln — aber NUR
                   dort. Bei einem einzigen Durchgang gibt es keine
                   Überlappung, und dann darf auch nichts wegfallen: zwei
                   Positionen dürfen einander gleichen, und wer die zweite
                   streicht, schiebt alles darunter um eine Zeile herauf —
                   genau das Fehlerbild, das hier abgestellt wird. */
                if (passes.length > 1) {
                    const key = rowKey(row, columns);
                    if (seen.has(key)) {
                        dropped += 1;
                        continue;
                    }
                    seen.add(key);
                }
                merged.push(row);
            }
        }
        return res.status(200).json({
            source: read.source,
            engine: read.engine,
            model: (0, gptExtract_1.gptModelName)(),
            language,
            columns: columns.map((column) => column.key),
            document,
            rows: merged,
            /* ── DIE ABRECHNUNG DER ZEILEN ──────────────────────────
               Die Zahl wird nicht mehr angesagt und nicht mehr
               geschaetzt, sie wird GEZAEHLT: die Abschrift hat so viele
               Zeilen, wie sie hat, und dagegen steht, was die Zuordnung
               daraus gemacht hat. Stimmen die beiden nicht ueberein,
               ist unterwegs etwas verloren gegangen — und das steht dann
               auf dem Bildschirm.

               `table` bleibt null, wo es keine Abschrift gibt (Excel und
               PDF kommen schon als Text und tragen Kopfzeilen, Summen
               und Anschriften mit — deren Zeilen zu zaehlen ergaebe eine
               Zahl, die nichts bedeutet). */
            rowCount: {
                returned: merged.length,
                table: transcripts.length
                    ? transcripts.reduce((sum, transcript) => sum + transcript.lines.length, 0)
                    : null,
                dropped,
            },
            /* DIE ORDENTLICHE UMWANDLUNG, zum Nachsehen. */
            transcript: transcripts.length
                ? {
                    header: transcripts[0]?.header ?? null,
                    lines: transcripts.flatMap((transcript) => transcript.lines),
                    pages: transcripts.map((transcript, index) => ({
                        index: index + 1,
                        header: transcript.header,
                        lines: transcript.lines,
                    })),
                }
                : null,
            usage,
            text: {
                rawChars: read.rawChars,
                chars: read.chars,
                approxTokens: (0, documentText_1.approxTokens)(read.chars),
                truncated: read.truncated || chunks.length > used.length,
                chunks: chunks.length,
                chunksRead: used.length,
            },
        });
    }
    catch (error) {
        if (error instanceof documentText_1.DocumentReadError || error instanceof gptExtract_1.GptError) {
            /* Die Begruendung reist mit — bei einer abgeschalteten
               Texterkennung steht darin Googles eigener Satz samt der
               Adresse, unter der sie sich einschalten laesst. Bis zum
               08.09.2026 kannte nur `GptError` ein `detail`, und die
               Auskunft ging genau dort verloren, wo sie gebraucht wurde. */
            const detail = error.detail;
            return res.status(error.status).json({
                error: error.message,
                code: error.code,
                ...(detail ? { detail } : {}),
            });
        }
        console.error('[purchase-orders/ai-extract] unerwarteter Fehler:', error);
        return res.status(500).json({ error: 'Der Beleg konnte nicht gelesen werden.' });
    }
});
/* ═══════════════════════════════════════════════════════════════════════════
   3) DIE RECHENVORLAGE JE LIEFERANT
   ═════════════════════════════════════════════════════════════════════════ */
/**
 * @swagger
 * /inventory/purchase-orders/supplier-templates:
 *   get:
 *     tags: [Inventory]
 *     summary: Rechenvorlagen — alle oder die eines Lieferanten
 *     security:
 *       - bearerAuth: []
 */
exports.purchaseOrderImportRouter.get('/supplier-templates', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const supplierId = String(req.query.supplierId ?? '').trim();
        const documentType = templateDocumentType(req.query.documentType);
        /* Mit Lieferant: SEINE Vorlagen und die allgemeinen (supplierId
           NULL). Ohne: alles — die Vorlagenliste im Fenster. */
        const where = supplierId
            ? { tenantId, documentType, OR: [{ supplierId }, { supplierId: null }] }
            : { tenantId, documentType };
        const rows = await prisma_client_1.default.supplierOrderTemplate.findMany({
            where,
            orderBy: [{ isDefault: 'desc' }, { usageCount: 'desc' }, { updatedAt: 'desc' }],
            take: 100,
        });
        res.status(200).json({ items: rows.map(parseTemplateRow) });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/supplier-templates:
 *   post:
 *     tags: [Inventory]
 *     summary: Rechenvorlage anlegen
 *     security:
 *       - bearerAuth: []
 */
exports.purchaseOrderImportRouter.post('/supplier-templates', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const title = String(req.body?.title ?? '').trim().slice(0, 191);
        if (!title)
            return res.status(400).json({ error: 'Der Vorlagenname fehlt.' });
        const supplierId = String(req.body?.supplierId ?? '').trim() || null;
        const supplierName = String(req.body?.supplierName ?? '').trim().slice(0, 191);
        const documentType = templateDocumentType(req.body?.documentType);
        const config = normalizeConfig(req.body?.config);
        const isDefault = Boolean(req.body?.isDefault);
        /* Genau EINE Standardvorlage je Lieferant: die alte verliert das
           Häkchen, bevor die neue es bekommt. */
        if (isDefault) {
            await prisma_client_1.default.supplierOrderTemplate.updateMany({
                where: { tenantId, supplierId, documentType, isDefault: true },
                data: { isDefault: false },
            });
        }
        const row = await prisma_client_1.default.supplierOrderTemplate.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId,
                supplierId,
                supplierName,
                title,
                documentType,
                isDefault,
                config: JSON.stringify(config),
                createdBy: req.user.id || null,
            },
        });
        res.status(201).json(parseTemplateRow(row));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/supplier-templates/{templateId}:
 *   patch:
 *     tags: [Inventory]
 *     summary: "Rechenvorlage ändern (auch: Verwendung zählen)"
 *     security:
 *       - bearerAuth: []
 */
exports.purchaseOrderImportRouter.patch('/supplier-templates/:templateId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const templateId = String(req.params.templateId);
        const existing = await prisma_client_1.default.supplierOrderTemplate.findFirst({
            where: { id: templateId, tenantId },
            select: { id: true, supplierId: true, documentType: true },
        });
        if (!existing)
            return res.status(404).json({ error: 'Vorlage nicht gefunden.' });
        const data = {};
        if (req.body?.title !== undefined) {
            const title = String(req.body.title ?? '').trim().slice(0, 191);
            if (!title)
                return res.status(400).json({ error: 'Der Vorlagenname fehlt.' });
            data.title = title;
        }
        if (req.body?.supplierId !== undefined)
            data.supplierId = String(req.body.supplierId ?? '').trim() || null;
        if (req.body?.supplierName !== undefined)
            data.supplierName = String(req.body.supplierName ?? '').trim().slice(0, 191);
        if (req.body?.config !== undefined)
            data.config = JSON.stringify(normalizeConfig(req.body.config));
        if (req.body?.isDefault !== undefined) {
            data.isDefault = Boolean(req.body.isDefault);
            if (data.isDefault) {
                await prisma_client_1.default.supplierOrderTemplate.updateMany({
                    where: {
                        tenantId,
                        documentType: existing.documentType,
                        supplierId: data.supplierId !== undefined ? data.supplierId : existing.supplierId,
                        isDefault: true,
                        NOT: { id: templateId },
                    },
                    data: { isDefault: false },
                });
            }
        }
        /* «Angewendet» ist kein Feld, sondern ein Zähler: die Liste sortiert
           danach, damit die Vorlage, die wirklich benutzt wird, oben steht. */
        if (req.body?.used)
            data.usageCount = { increment: 1 };
        if (!Object.keys(data).length)
            return res.status(400).json({ error: 'Es gibt nichts zu ändern.' });
        const row = await prisma_client_1.default.supplierOrderTemplate.update({ where: { id: templateId }, data });
        res.status(200).json(parseTemplateRow(row));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * @swagger
 * /inventory/purchase-orders/supplier-templates/{templateId}:
 *   delete:
 *     tags: [Inventory]
 *     summary: Rechenvorlage löschen
 *     security:
 *       - bearerAuth: []
 */
exports.purchaseOrderImportRouter.delete('/supplier-templates/:templateId', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.transfer'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const templateId = String(req.params.templateId);
        const existing = await prisma_client_1.default.supplierOrderTemplate.findFirst({
            where: { id: templateId, tenantId },
            select: { id: true },
        });
        if (!existing)
            return res.status(404).json({ error: 'Vorlage nicht gefunden.' });
        await prisma_client_1.default.supplierOrderTemplate.delete({ where: { id: templateId } });
        res.status(200).json({ message: 'Vorlage gelöscht.', templateId });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
//# sourceMappingURL=purchaseOrderImport.routes.js.map