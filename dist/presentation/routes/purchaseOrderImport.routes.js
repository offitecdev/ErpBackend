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
exports.normalizeTemplateConfig = exports.purchaseOrderImportRouter = void 0;
const express_1 = require("express");
const nanoid_1 = require("nanoid");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const RateLimitMiddleware_1 = require("../middlewares/RateLimitMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const documentText_1 = require("../../infrastructure/services/documentText");
const gptExtract_1 = require("../../infrastructure/services/gptExtract");
const ResponseCacheMiddleware_1 = require("../middlewares/ResponseCacheMiddleware");
const standardOrderTemplate_1 = require("../../shared/standardOrderTemplate");
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
/* ── Die Vorlage: Gestalt und Prüfung ─────────────────────────────────────
   Die Vorlage kommt aus dem Browser und wird hier vollständig neu aufgebaut —
   nie durchgereicht. Was nicht in dieser Funktion steht, steht auch nicht in
   der Datenbank.

   ── STAND 11.09.2026 (Vorgabe Samet) ────────────────────────────────────
   «Es gibt einen Vorlagennamen, aber keinen Lieferanten und keine Rechenart
    mehr; auch keine Mehrwertsteuer, die steht schon in den Bestelldetails.
    Bis zu dreizehn Spalten (12+1): eine davon ist der ERP-Code — fest, in
    den Tabellen, aber nicht im PDF und nicht in der KI-Anfrage. Jede Spalte
    bekommt Name, Art und eine Zuordnung; Produktname und Menge sind
    Pflicht, die uebrigen Zuordnungen gibt es je einmal.»

   Die Vorlage ist damit NUR NOCH ihre Spaltenliste. Alles, was frueher
   daneben stand (Rechenart, Rabattstapel, Mengenstaffel, Steuersatz,
   Auge-Symbol), ist weg — eine alte Vorlage wird beim Lesen in die neue
   Gestalt uebersetzt (`legacyColumns`), damit nichts Gespeichertes
   verloren geht. */
const TEMPLATE_DOCUMENT_TYPES = new Set(['ORDER', 'PRICE_REQUEST', 'GOODS_RECEIPT']);
const templateDocumentType = (value) => TEMPLATE_DOCUMENT_TYPES.has(String(value).toUpperCase())
    ? String(value).toUpperCase()
    : 'ORDER';
const columnWidth = (value) => Math.round(Math.min(240, Math.max(80, Number(value) || 120)));
/**
 * Eine Vorlage der alten Gestalt (feste Felder + eigene Angaben + Auge) in
 * die Spaltenliste uebersetzen. Die festen Felder bekommen deutsche Namen —
 * die Sprache des Hauses — und ihre Zuordnung; ausgeblendete fallen weg;
 * die eigenen Angaben werden freie Spalten und behalten ihren Schluessel,
 * damit die Werte gespeicherter Bestellungen ihre Spalte wiederfinden.
 */
const legacyColumns = (raw, documentType) => {
    const hidden = new Set(Array.isArray(raw?.hiddenColumnKeys) ? raw.hiddenColumnKeys.map(String) : []);
    const fixed = [
        { key: 'name', name: 'Produktname', type: 'text', label: 'productName' },
        { key: 'quantity', name: 'Menge', type: 'number', label: 'quantity' },
        { key: 'priceGross', name: 'Einzelpreis', type: 'number', label: 'grossPrice' },
        { key: 'priceNet', name: 'Nettopreis', type: 'number', label: 'netPrice' },
        { key: 'discount', name: 'Rabatt', type: 'number', label: 'discount' },
        ...(raw?.discount2Enabled === false ? [] : [{ key: 'discount2', name: 'Rabatt 2', type: 'number', label: 'discount2' }]),
        { key: 'lineTotal', name: 'Zeilensumme', type: 'number', label: 'total' },
    ];
    const columns = fixed
        // Die Pflichtzuordnungen bleiben auch dann, wenn das Auge sie ausblendete.
        .filter((column) => !hidden.has(column.key) || column.label === 'productName' || column.label === 'quantity')
        // Eine Preisanfrage kannte nie Preise — sie bekommt auch jetzt keine.
        .filter((column) => documentType !== 'PRICE_REQUEST' || column.label === 'productName' || column.label === 'quantity')
        .map((column) => ({ ...column, width: 120 }));
    for (const extra of (0, gptExtract_1.normalizeColumns)(raw?.extraColumns)) {
        if (hidden.has(extra.key))
            continue;
        const source = (Array.isArray(raw?.extraColumns) ? raw.extraColumns : []).find((entry) => String(entry?.key ?? '') === extra.key);
        columns.push({ ...extra, label: null, width: columnWidth(source?.width) });
    }
    return columns.slice(0, gptExtract_1.TEMPLATE_MAX_COLUMNS);
};
/**
 * Eine alte Vorlage erkennt man an ihren alten Feldern — NICHT am Fehlen von
 * `columns`: der alte Server schrieb immer ein leeres `columns: []` mit, und
 * daran allein saehe die neue Gestalt wie «gespeichert, aber ohne Spalten»
 * aus (Fehlerbild Samet, 11.09.2026: «siparişte şablonlar görünmüyor»).
 */
const LEGACY_CONFIG_KEYS = ['calcMode', 'extraColumns', 'discount2Enabled', 'hiddenColumnKeys', 'qtyTiers', 'roles'];
const isLegacyConfig = (raw) => Boolean(raw) && typeof raw === 'object'
    && !(Array.isArray(raw.columns) && raw.columns.length > 0)
    && LEGACY_CONFIG_KEYS.some((key) => key in raw);
const normalizeTemplateConfig = (raw, documentType = 'ORDER') => {
    const source = Array.isArray(raw?.columns) && !isLegacyConfig(raw) ? raw.columns : null;
    if (!source)
        return { columns: legacyColumns(raw, documentType) };
    const columns = (0, gptExtract_1.normalizeColumns)(source).map((column) => ({
        ...column,
        width: columnWidth(source.find((entry) => String(entry?.key ?? '') === column.key)?.width),
    }));
    return { columns };
};
exports.normalizeTemplateConfig = normalizeTemplateConfig;
/**
 * Was eine Vorlage erfuellen muss, bevor sie gespeichert wird (Vorgabe
 * Samet: «wird eine Zuordnung nicht gewaehlt, zeigt das System einen
 * Fehler»). Eine Preisanfrage kennt keine Preise — dort werden die
 * Preiszuordnungen still abgelegt statt abgewiesen.
 */
const PRICE_REQUEST_LABELS = new Set(['productName', 'quantity']);
const validateTemplateConfig = (config, documentType) => {
    if (documentType === 'PRICE_REQUEST') {
        config.columns.forEach((column) => {
            if (column.label && !PRICE_REQUEST_LABELS.has(column.label))
                column.label = null;
        });
    }
    if (!config.columns.length)
        return 'Die Vorlage braucht mindestens eine Spalte.';
    const missing = (0, gptExtract_1.missingTemplateLabels)(config.columns);
    if (missing.length) {
        const names = {
            productName: 'Produktname', quantity: 'Menge', grossPrice: 'Einzelpreis', netPrice: 'Nettopreis',
            discount: 'Rabatt', discount2: 'Rabatt 2', total: 'Zeilensumme',
        };
        return `Die Zuordnung «${missing.map((label) => names[label]).join('» und «')}» fehlt.`;
    }
    return null;
};
/** Zeile der Datenbank → Antwort (die Einstellung reist als Objekt, nicht als Text). */
const parseTemplateRow = (row) => {
    let config;
    try {
        config = (0, exports.normalizeTemplateConfig)(JSON.parse(String(row?.config ?? '{}')), templateDocumentType(row?.documentType));
    }
    catch {
        // Eine unlesbare Einstellung darf die Liste nicht sprengen — sie kommt
        // leer zurück und lässt sich überschreiben.
        config = { columns: [] };
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
        labels: gptExtract_1.TEMPLATE_LABELS,
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
 *               columns:
 *                 type: array
 *                 description: "Die Spalten der Vorlage: {key, name, type, label}"
 *                 items: { type: object }
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
        /* Ohne Produktname und Menge laesst sich aus dem Gelesenen keine
           Bestellzeile machen — dann lieber gar nicht erst bezahlen. */
        if ((0, gptExtract_1.missingTemplateLabels)(columns).length) {
            return res.status(400).json({
                error: 'Der Vorlage fehlen die Zuordnungen «Produktname» und «Menge».',
                code: 'GPT_TEMPLATE_LABELS',
            });
        }
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
        const usage = emptyUsage();
        const addUsage = (part) => {
            usage.promptTokens += part.promptTokens;
            usage.completionTokens += part.completionTokens;
            usage.totalTokens += part.totalTokens;
            if (usage.estimatedUsd !== null && part.estimatedUsd !== null) {
                usage.estimatedUsd = Math.round((usage.estimatedUsd + part.estimatedUsd) * 1e6) / 1e6;
            }
            else {
                usage.estimatedUsd = null;
            }
            usage.chunks += 1;
        };
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
        /* ── DER BILDWEG: ERST DIE TABELLE (Samet, 11.09.2026, 2. Runde) ─
           «Sie muss erkennen, welche Werte unter welcher Spalte stehen
           und welche leer sind — eine Tabelle daraus machen.»

           Je Aufnahme zwei Blicke (`readImagePages`): die Spalten der
           Tabelle, dann das Raster Zeile fuer Zeile, jede Zelle unter
           ihrer Ueberschrift. Die Zuordnung zur Vorlage macht der
           Server. Die Aufnahmen bleiben in ihrer Reihenfolge. */
        if (images.length) {
            const pages = await (0, gptExtract_1.readImagePages)(images, columns);
            pages.forEach((page) => addUsage(page.usage));
            /* Gezaehlt wird das RASTER, nicht eine Ansage des Modells
               (am 11.09. zaehlte es 44 Zeilen auf einem Blatt mit 38). */
            const tableRows = pages.reduce((sum, page) => sum + page.grid.rows.length, 0);
            for (const page of pages) {
                for (const row of page.rows)
                    merged.push(row);
            }
            if (!merged.length) {
                return res.status(422).json({
                    error: 'Auf dem Beleg wurde keine Tabelle gefunden.',
                    code: 'GPT_NO_TABLE',
                });
            }
            const header = columns.map((column) => column.name).join('\t');
            const lineOf = (row) => columns
                .map((column) => (row[column.key] === null || row[column.key] === undefined ? '-' : String(row[column.key])))
                .join('\t');
            return res.status(200).json({
                source: 'image',
                engine: 'gpt-vision',
                model: (0, gptExtract_1.gptModelName)(),
                language,
                columns: columns.map((column) => column.key),
                document,
                rows: merged,
                /* Die Abrechnung der Zeilen: was das Modell gezaehlt hat,
                   gegen das, was als Zeile ankam. */
                rowCount: { returned: merged.length, table: tableRows, dropped: Math.max(0, tableRows - merged.length) },
                /* Die Abschrift zum Nachsehen: `lines` in den Spalten
                   der Vorlage, `pages` das Raster je Aufnahme — ALLE
                   gedruckten Spalten, null = leere Zelle, und welche
                   davon welcher Vorlagenspalte zugeordnet wurde (Index
                   in `headers`, null = auf dem Blatt nicht gefunden). */
                transcript: {
                    header,
                    lines: merged.map(lineOf),
                    pages: pages.map((page, index) => ({
                        index: index + 1,
                        headers: page.grid.headers,
                        rows: page.grid.rows,
                        mapping: page.mapping,
                    })),
                },
                /* Vorlagenspalten, die auf KEINER Aufnahme gefunden
                   wurden: die Oberflaeche sagt es, statt still eine
                   leere Spalte zu zeigen. */
                missingColumns: columns
                    .filter((column) => pages.every((page) => page.mapping[column.key] === null || page.mapping[column.key] === undefined))
                    .map((column) => column.key),
                usage,
                text: { rawChars: 0, chars: 0, approxTokens: 0, truncated: false, chunks: pages.length, chunksRead: pages.length },
            });
        }
        /* ── DER TEXTWEG: PDF-Textlage und Excel ────────────────────────
           Zeile fuer Zeile, mit dem Zeilenanker; lange Belege in
           Stuecken. */
        const read = await (0, documentText_1.readDocumentText)({
            data: req.body?.data,
            text: req.body?.text,
            fileName: req.body?.fileName,
            mimeType: req.body?.mimeType,
        });
        const chunks = (0, documentText_1.chunkText)(read.text, CHUNK_CHARS);
        const used = chunks.slice(0, MAX_CHUNKS);
        const passes = used.map((chunk) => ({ text: chunk }));
        for (const pass of passes) {
            const result = await (0, gptExtract_1.extractWithGpt)({
                ...pass,
                columns,
                language,
                includeDocumentHeader,
            });
            addUsage(result.usage);
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
                /* `table` bleibt null: Excel und PDF kommen schon als
                   Text und tragen Kopfzeilen, Summen und Anschriften
                   mit — deren Zeilen zu zaehlen ergaebe eine Zahl, die
                   nichts bedeutet. */
                table: null,
                dropped,
            },
            transcript: null,
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
exports.purchaseOrderImportRouter.get('/supplier-templates', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('inventory.view'), (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['catalog', 'settings'], ttlSec: 120 }), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const supplierId = String(req.query.supplierId ?? '').trim();
        const documentType = templateDocumentType(req.query.documentType);
        // STANDART ŞABLON (24.09.2026): sipariş ve fiyat talebinin sabit
        // şablonu yoksa burada kurulur — liste onu hep içerir.
        if (documentType !== 'GOODS_RECEIPT')
            await (0, standardOrderTemplate_1.ensureStandardTemplateOnce)(tenantId, documentType);
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
        const documentType = templateDocumentType(req.body?.documentType);
        const config = (0, exports.normalizeTemplateConfig)(req.body?.config, documentType);
        const problem = validateTemplateConfig(config, documentType);
        if (problem)
            return res.status(400).json({ error: problem, code: 'TEMPLATE_INVALID' });
        const isDefault = Boolean(req.body?.isDefault);
        /* Eine Vorlage gehoert keinem Lieferanten mehr (11.09.2026) —
           `supplierId` bleibt leer, und es gibt genau EINE Vorgabe je
           Dokumentart: die alte verliert das Häkchen, bevor die neue es
           bekommt. */
        if (isDefault) {
            await prisma_client_1.default.supplierOrderTemplate.updateMany({
                where: { tenantId, documentType, isDefault: true },
                data: { isDefault: false },
            });
        }
        const row = await prisma_client_1.default.supplierOrderTemplate.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId,
                supplierId: null,
                supplierName: '',
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
        if (req.body?.config !== undefined) {
            const config = (0, exports.normalizeTemplateConfig)(req.body.config, templateDocumentType(existing.documentType));
            const problem = validateTemplateConfig(config, templateDocumentType(existing.documentType));
            if (problem)
                return res.status(400).json({ error: problem, code: 'TEMPLATE_INVALID' });
            data.config = JSON.stringify(config);
        }
        if (req.body?.isDefault !== undefined) {
            data.isDefault = Boolean(req.body.isDefault);
            if (data.isDefault) {
                await prisma_client_1.default.supplierOrderTemplate.updateMany({
                    where: {
                        tenantId,
                        documentType: existing.documentType,
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