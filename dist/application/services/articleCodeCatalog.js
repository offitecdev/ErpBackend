"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.newSchemeData = exports.issueTemporaryReceiptCodes = exports.TEMPORARY_RECEIPT_DIGITS = exports.TEMPORARY_RECEIPT_SCHEME = exports.TEMPORARY_RECEIPT_CATEGORY = exports.renumberSchemeArticles = exports.resetSchemeCounter = exports.migrateArticlePrefix = exports.issueCodes = exports.previewNextCode = exports.countArticlesByPrefix = exports.countArticlesUnderPrefix = exports.highestIssuedNumber = exports.listCodeCategories = exports.looksLikeErpCode = exports.codePrefix = exports.formatErpCode = exports.joinCells = exports.schemeCells = exports.normalizeCells = exports.isValidShortCode = exports.normalizeShortCode = exports.MAX_CODE_NAME_LENGTH = exports.MAX_SCHEME_CELLS = exports.MAX_CELLS = exports.MIN_CELLS = exports.MAX_DIGITS = exports.MIN_DIGITS = exports.CODE_DIGITS = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
/* ERP-CODES (Einstellungen → Module → Lager → Code-Einstellungen, 10.09.2026,
 * auf 2–4 Zellen erweitert am 22.09.2026)
 *
 * Jeder Artikel traegt genau EINEN ERP-Code. Er besteht aus ZELLEN, mit
 * Bindestrich verbunden, und einem Zaehler am Ende:
 *
 *      ELK-PLC-00001                (2 Zellen + Zaehler)
 *      ELK-PANO-PLC-H-00400         (4 Zellen + Zaehler)
 *
 * Die ERSTE Zelle stellt die KATEGORIE («Elektro» = ELK). Die uebrigen (1 bis
 * 3) stellt der NUMMERNKREIS; er haelt sie in `code` verbunden («PANO-PLC-H»).
 * Vorgabe Samet 22.09.2026: mindestens 2, hoechstens 4 Zellen, die fuenfte ist
 * der Zaehler. Wie breit der Zaehler laeuft, sagt `digits` (Vorgabe 5).
 *
 * Die IT BEREITET Nummernkreise vor (Zellen, Name, Startnummer, Breite). Erst
 * nach der FREIGABE ueber die IT-Schleuse (`isActive`) darf ein Kreis Codes
 * vergeben und erscheint in der Schnellerfassung.
 *
 * Die Laufnummer wird ATOMAR gezogen (`UPDATE … SET lastNumber = lastNumber+n`
 * in einem Zug ueber Prisma's `increment`), damit zwei gleichzeitige
 * Erfassungen nie dieselbe Nummer bekommen. Nummern, die schon auf einem
 * Artikel stehen (Import, Altbestand, oder eine Luecke nach dem Zuruecksetzen
 * des Zaehlers), werden uebersprungen.
 */
exports.CODE_DIGITS = 5;
/** So breit darf der Zaehler hoechstens laufen. */
exports.MIN_DIGITS = 1;
exports.MAX_DIGITS = 10;
/** Zellen INSGESAMT (Kategorie mitgezaehlt) — Vorgabe Samet 22.09.2026. */
exports.MIN_CELLS = 2;
exports.MAX_CELLS = 4;
/** Zellen, die der NUMMERNKREIS stellt (die Kategorie stellt die erste). */
exports.MAX_SCHEME_CELLS = exports.MAX_CELLS - 1;
/** Eine Zelle: 1–4 Grossbuchstaben oder Ziffern, keine Umlaute. */
const CELL = /^[A-Z0-9]{1,4}$/;
exports.MAX_CODE_NAME_LENGTH = 80;
/** Eine Zelle in Grossbuchstaben, Umlaute aufgeloest, Rest verworfen. */
const normalizeShortCode = (value) => String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß/g, 'SS')
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
exports.normalizeShortCode = normalizeShortCode;
const isValidShortCode = (value) => CELL.test(value);
exports.isValidShortCode = isValidShortCode;
/**
 * Die Zellen eines Nummernkreises aus einer Eingabe lesen — eine Liste
 * («["PANO","PLC","H"]») oder eine verbundene Zeichenkette («PANO-PLC-H»).
 * Leere Zellen fallen weg; jede einzelne wird normalisiert.
 */
const normalizeCells = (value) => {
    const raw = Array.isArray(value)
        ? value
        : String(value ?? '').split(/[^A-Za-z0-9ÄÖÜäöüß]+/);
    return raw.map((cell) => (0, exports.normalizeShortCode)(cell)).filter(Boolean).slice(0, exports.MAX_SCHEME_CELLS);
};
exports.normalizeCells = normalizeCells;
/** Die Zellen, die in `ArticleCodeScheme.code` stecken. */
const schemeCells = (code) => String(code || '').split('-').filter(Boolean);
exports.schemeCells = schemeCells;
/** Der gespeicherte `code` eines Nummernkreises aus seinen Zellen. */
const joinCells = (cells) => cells.join('-');
exports.joinCells = joinCells;
const formatErpCode = (categoryCode, schemeCode, n, digits = exports.CODE_DIGITS) => `${categoryCode}-${schemeCode}-${String(n).padStart(Math.min(Math.max(digits, exports.MIN_DIGITS), exports.MAX_DIGITS), '0')}`;
exports.formatErpCode = formatErpCode;
/** Das Praefix `KAT-ZELLEN-` eines Nummernkreises. */
const codePrefix = (categoryCode, schemeCode) => `${categoryCode}-${schemeCode}-`;
exports.codePrefix = codePrefix;
/** Traegt ein Code die Form ZELLE-…-NNNNN? (Nur zur Anzeige/Erkennung — der Altbestand darf abweichen.) */
const looksLikeErpCode = (code) => new RegExp(`^[A-Z0-9]{1,4}(?:-[A-Z0-9]{1,4}){1,${exports.MAX_CELLS - 1}}-\\d+$`).test(code);
exports.looksLikeErpCode = looksLikeErpCode;
/** Alle Kategorien des Mandanten mit ihren Nummernkreisen (auch unfreigegebene). */
const listCodeCategories = async (tenantId, options = {}) => {
    const rows = await prisma_client_1.default.articleCodeCategory.findMany({
        where: { tenantId },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        include: {
            schemes: {
                ...(options.activeOnly ? { where: { isActive: true } } : {}),
                orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
            },
        },
    });
    const categories = rows;
    // Fuer die Auswahl in der Schnellerfassung zaehlt nur, was Codes vergeben darf.
    return options.activeOnly ? categories.filter((row) => row.schemes.length > 0) : categories;
};
exports.listCodeCategories = listCodeCategories;
/**
 * Die hoechste Laufnummer, die unter diesem Praefix schon auf einem Artikel
 * steht (auch im Papierkorb — der eindeutige Schluessel kennt keinen
 * Papierkorb). 0 = noch keine.
 */
const highestIssuedNumber = async (tenantId, prefix) => {
    const pattern = '^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[0-9]+$';
    const rows = await prisma_client_1.default.$queryRaw `
        SELECT MAX(CAST(SUBSTRING(articleCode, ${prefix.length + 1}) AS UNSIGNED)) AS maxNo
        FROM Article
        WHERE tenantId = ${tenantId}
          AND articleCode REGEXP ${pattern}
    `;
    const value = rows[0]?.maxNo;
    return value === null || value === undefined ? 0 : Number(value);
};
exports.highestIssuedNumber = highestIssuedNumber;
/** Wie viele Artikel (Papierkorb eingeschlossen) einen Code unter diesem Praefix tragen. */
const countArticlesUnderPrefix = async (tenantId, prefix) => prisma_client_1.default.article.count({ where: { tenantId, articleCode: { startsWith: prefix } } });
exports.countArticlesUnderPrefix = countArticlesUnderPrefix;
/**
 * Die Artikelzahl zu MEHREREN Praefixen in EINER Abfrage — die Liste der
 * Code-Einstellungen zeigt sie in jeder Zeile, und ein Zaehler je Kreis waeren
 * sonst so viele Rundreisen wie Kreise.
 */
const countArticlesByPrefix = async (tenantId, prefixes) => {
    const out = {};
    prefixes.forEach((prefix) => { out[prefix] = 0; });
    const wanted = prefixes.filter(Boolean).slice(0, 200);
    if (!wanted.length)
        return out;
    const sums = wanted.map((_, index) => `SUM(articleCode LIKE ?) AS c${index}`).join(', ');
    const rows = await prisma_client_1.default.$queryRawUnsafe(`SELECT ${sums} FROM Article WHERE tenantId = ?`, ...wanted.map((prefix) => `${prefix}%`), tenantId);
    const row = rows[0] ?? {};
    wanted.forEach((prefix, index) => {
        const value = row[`c${index}`];
        out[prefix] = value === null || value === undefined ? 0 : Number(value);
    });
    return out;
};
exports.countArticlesByPrefix = countArticlesByPrefix;
/** Der Code, den der Kreis als NAECHSTES vergeben wuerde (Anzeige, nichts wird gezogen). */
const previewNextCode = (category, scheme) => (0, exports.formatErpCode)(category.code, scheme.code, Math.max(scheme.startNumber, scheme.lastNumber + 1), scheme.digits ?? exports.CODE_DIGITS);
exports.previewNextCode = previewNextCode;
/** Welche dieser Codes stehen schon auf einem Artikel (Papierkorb eingeschlossen)? */
const takenCodes = async (tenantId, codes) => {
    if (!codes.length)
        return new Set();
    const rows = await prisma_client_1.default.article.findMany({
        where: { tenantId, articleCode: { in: codes } },
        select: { articleCode: true },
    });
    return new Set(rows.map((row) => row.articleCode));
};
/**
 * `count` frische Codes aus einem FREIGEGEBENEN Nummernkreis ziehen. Jede
 * Nummer wird atomar reserviert; Nummern, die schon auf einem Artikel stehen
 * (Import, Altbestand, oder eine Luecke, nachdem der Zaehler zurueckgesetzt
 * wurde), werden uebersprungen. Wirft, wenn der Kreis fehlt oder nicht
 * freigegeben ist.
 *
 * Steht eine GANZE Reservierung schon auf Artikeln, springt der Zaehler EINMAL
 * ueber alles Vergebene hinweg — sonst wuerde ein Import von tausend Codes
 * tausend Rundreisen kosten. Einzelne Luecken bleiben damit erreichbar, ein
 * geschlossener Block wird uebersprungen.
 */
const issueCodes = async (tenantId, schemeId, count) => {
    const scheme = await prisma_client_1.default.articleCodeScheme.findFirst({
        where: { id: schemeId, tenantId },
        include: { category: { select: { code: true, name: true } } },
    });
    if (!scheme)
        throw Object.assign(new Error('Nummernkreis nicht gefunden.'), { status: 404, code: 'SCHEME_NOT_FOUND' });
    if (!scheme.isActive)
        throw Object.assign(new Error('Dieser Nummernkreis ist noch nicht von der IT freigegeben.'), { status: 409, code: 'SCHEME_INACTIVE' });
    const digits = scheme.digits ?? exports.CODE_DIGITS;
    const prefix = (0, exports.codePrefix)(scheme.category.code, scheme.code);
    // Der Zaehler darf nie hinter die Startnummer zurueckfallen.
    if (scheme.startNumber - 1 > scheme.lastNumber) {
        await prisma_client_1.default.articleCodeScheme.updateMany({
            where: { id: scheme.id, lastNumber: { lt: scheme.startNumber - 1 } },
            data: { lastNumber: scheme.startNumber - 1 },
        });
    }
    const codes = [];
    let jumped = false;
    let guard = 0;
    while (codes.length < count && guard < 24) {
        guard += 1;
        const need = count - codes.length;
        // Atomar: EIN UPDATE reserviert den ganzen Block; gleichzeitige
        // Aufrufer bekommen verschiedene Nummern.
        const updated = await prisma_client_1.default.articleCodeScheme.update({
            where: { id: scheme.id },
            data: { lastNumber: { increment: need } },
            select: { lastNumber: true },
        });
        const from = updated.lastNumber - need + 1;
        const candidates = [];
        for (let n = from; n <= updated.lastNumber; n += 1)
            candidates.push((0, exports.formatErpCode)(scheme.category.code, scheme.code, n, digits));
        const taken = await takenCodes(tenantId, candidates);
        const free = candidates.filter((code) => !taken.has(code));
        codes.push(...free);
        if (!free.length && !jumped) {
            // Ein geschlossener Block Vergebenes: einmal darueber hinweg.
            jumped = true;
            const high = await (0, exports.highestIssuedNumber)(tenantId, prefix);
            if (high > updated.lastNumber) {
                await prisma_client_1.default.articleCodeScheme.updateMany({
                    where: { id: scheme.id, lastNumber: { lt: high } },
                    data: { lastNumber: high },
                });
            }
        }
    }
    return { codes, scheme: scheme };
};
exports.issueCodes = issueCodes;
const migrateArticlePrefix = async (tenantId, oldPrefix, newPrefix) => {
    if (oldPrefix === newPrefix)
        return { movedArticles: 0 };
    const blocking = await (0, exports.countArticlesUnderPrefix)(tenantId, newPrefix);
    if (blocking > 0) {
        throw Object.assign(new Error(`Unter «${newPrefix}» tragen schon ${blocking} Artikel einen Code — die alten Codes liessen sich nicht eindeutig umschreiben.`), { status: 409, code: 'TARGET_PREFIX_IN_USE' });
    }
    // Ein einziger Satz: das Praefix tauschen, die Laufnummer stehen lassen.
    const moved = await prisma_client_1.default.$executeRawUnsafe('UPDATE Article SET articleCode = CONCAT(?, SUBSTRING(articleCode, ?)) WHERE tenantId = ? AND articleCode LIKE ?', newPrefix, oldPrefix.length + 1, tenantId, `${oldPrefix}%`);
    // Die Produktion fuehrt eine Kopie des Codes auf ihren Zeilen.
    await prisma_client_1.default.$executeRawUnsafe('UPDATE ProductionProjectItem SET articleCode = CONCAT(?, SUBSTRING(articleCode, ?)) WHERE tenantId = ? AND articleCode LIKE ?', newPrefix, oldPrefix.length + 1, tenantId, `${oldPrefix}%`);
    return { movedArticles: Number(moved) };
};
exports.migrateArticlePrefix = migrateArticlePrefix;
/* ── ZAEHLER ZURUECKSETZEN / NEU DURCHNUMMERIEREN ─────────────────────────
 *
 * Vorgabe Samet 22.09.2026: «es soll Moeglichkeiten geben, die Nummerierung
 * zurueckzusetzen». Zwei davon — beide hinter der IT-Schleuse:
 *
 *   counter  — der Zaehler faengt wieder bei der Startnummer (oder einer
 *              gewuenschten Nummer) an. Vergebene Nummern werden dabei nicht
 *              angetastet: die naechste FREIE Nummer wird gesucht, sodass der
 *              Kreis in Luecken hineinvergibt, statt Codes doppelt zu machen.
 *   renumber — die Artikel des Kreises bekommen IHRE Codes neu, lueckenlos ab
 *              der Startnummer, in der Reihenfolge ihres Entstehens.
 */
/** Die erste freie Nummer ab `from` (hoechstens `limit` Nummern weit gesucht). */
const firstFreeNumber = async (tenantId, category, scheme, from, limit = 5_000) => {
    const digits = scheme.digits ?? exports.CODE_DIGITS;
    let n = Math.max(1, from);
    const end = n + limit;
    while (n < end) {
        const block = [];
        for (let i = 0; i < 500 && n + i < end; i += 1)
            block.push((0, exports.formatErpCode)(category.code, scheme.code, n + i, digits));
        const taken = await takenCodes(tenantId, block);
        const free = block.findIndex((code) => !taken.has(code));
        if (free >= 0)
            return n + free;
        n += block.length;
    }
    // Weiter als die Suche reicht: hinter allem Vergebenen weitermachen.
    return (await (0, exports.highestIssuedNumber)(tenantId, (0, exports.codePrefix)(category.code, scheme.code))) + 1;
};
const resetSchemeCounter = async (tenantId, schemeId, options = {}) => {
    const scheme = await prisma_client_1.default.articleCodeScheme.findFirst({ where: { id: schemeId, tenantId }, include: { category: true } });
    if (!scheme)
        throw Object.assign(new Error('Nummernkreis nicht gefunden.'), { status: 404, code: 'SCHEME_NOT_FOUND' });
    const wanted = Math.max(1, Math.floor(Number(options.value ?? scheme.startNumber)) || scheme.startNumber);
    const next = await firstFreeNumber(tenantId, scheme.category, scheme, wanted);
    await prisma_client_1.default.articleCodeScheme.update({ where: { id: scheme.id }, data: { lastNumber: Math.max(0, next - 1) } });
    return { nextNumber: next, nextCode: (0, exports.formatErpCode)(scheme.category.code, scheme.code, next, scheme.digits ?? exports.CODE_DIGITS) };
};
exports.resetSchemeCounter = resetSchemeCounter;
/**
 * Die Artikel eines Kreises neu beschriften.
 *
 *   ohne `keepNumbers` — lueckenlos ab der Startnummer, in der Reihenfolge
 *       ihres Entstehens. Das ist das «Zurücksetzen» aus den Einstellungen.
 *   mit `keepNumbers`  — jeder Artikel behaelt SEINE Nummer und bekommt sie nur
 *       in der neuen Zaehlerbreite: ELK-PLC-00042 → ELK-PLC-042. Das laeuft,
 *       wenn jemand die Breite aendert und die bestehenden Codes mitnehmen
 *       will; sonst stuenden alte und neue Codes in verschiedenen Breiten
 *       nebeneinander und dieselbe Nummer gaebe es zweimal.
 */
const renumberSchemeArticles = async (tenantId, schemeId, options = {}) => {
    const scheme = await prisma_client_1.default.articleCodeScheme.findFirst({ where: { id: schemeId, tenantId }, include: { category: true } });
    if (!scheme)
        throw Object.assign(new Error('Nummernkreis nicht gefunden.'), { status: 404, code: 'SCHEME_NOT_FOUND' });
    const digits = scheme.digits ?? exports.CODE_DIGITS;
    const prefix = (0, exports.codePrefix)(scheme.category.code, scheme.code);
    // Papierkorb eingeschlossen — der eindeutige Schluessel kennt keinen.
    const rows = await prisma_client_1.default.article.findMany({
        where: { tenantId, articleCode: { startsWith: prefix } },
        select: { id: true, articleCode: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!rows.length) {
        if (options.keepNumbers)
            return { renumbered: 0, lastNumber: scheme.lastNumber };
        await prisma_client_1.default.articleCodeScheme.update({ where: { id: scheme.id }, data: { lastNumber: Math.max(0, scheme.startNumber - 1) } });
        return { renumbered: 0, lastNumber: Math.max(0, scheme.startNumber - 1) };
    }
    const repad = (row) => {
        const tail = row.articleCode.slice(prefix.length);
        // Nur was wirklich eine Laufnummer ist — Altbestand darf abweichen.
        if (!/^\d+$/.test(tail))
            return null;
        return { id: row.id, code: (0, exports.formatErpCode)(scheme.category.code, scheme.code, Number(tail), digits) };
    };
    const target = options.keepNumbers
        ? rows.map(repad).filter((row) => row !== null)
        : rows.map((row, index) => ({
            id: row.id,
            code: (0, exports.formatErpCode)(scheme.category.code, scheme.code, scheme.startNumber + index, digits),
        }));
    if (!target.length)
        return { renumbered: 0, lastNumber: scheme.lastNumber };
    // ZWEI SCHRITTE: erst jeden betroffenen Code auf einen unmoeglichen
    // Zwischenwert («~<id>») parken, dann den endgueltigen setzen. Sonst
    // stolperte das Umschreiben ueber den eindeutigen Schluessel, sobald sich
    // zwei Artikel ihre Nummern tauschen. Geparkt wird NUR, was auch neu
    // beschriftet wird — sonst bliebe eine uebersprungene Zeile geparkt.
    const lastNumber = options.keepNumbers ? scheme.lastNumber : scheme.startNumber + target.length - 1;
    const chunk = 400;
    await prisma_client_1.default.$transaction(async (tx) => {
        for (let index = 0; index < target.length; index += chunk) {
            const slice = target.slice(index, index + chunk);
            const holes = slice.map(() => '?').join(',');
            await tx.$executeRawUnsafe(`UPDATE Article SET articleCode = CONCAT('~', id) WHERE tenantId = ? AND id IN (${holes})`, tenantId, ...slice.map((row) => row.id));
        }
        for (let index = 0; index < target.length; index += chunk) {
            const slice = target.slice(index, index + chunk);
            const cases = slice.map(() => 'WHEN ? THEN ?').join(' ');
            const holes = slice.map(() => '?').join(',');
            await tx.$executeRawUnsafe(`UPDATE Article SET articleCode = CASE id ${cases} END WHERE tenantId = ? AND id IN (${holes})`, ...slice.flatMap((row) => [row.id, row.code]), tenantId, ...slice.map((row) => row.id));
            // Die Produktion fuehrt eine Kopie des Codes auf ihren Zeilen.
            await tx.$executeRawUnsafe(`UPDATE ProductionProjectItem SET articleCode = CASE articleId ${cases} END WHERE tenantId = ? AND articleId IN (${holes})`, ...slice.flatMap((row) => [row.id, row.code]), tenantId, ...slice.map((row) => row.id));
        }
        if (!options.keepNumbers) {
            await tx.articleCodeScheme.update({ where: { id: scheme.id }, data: { lastNumber } });
        }
    }, { timeout: 120_000, maxWait: 20_000 });
    return { renumbered: target.length, lastNumber };
};
exports.renumberSchemeArticles = renumberSchemeArticles;
/* ── VORLÄUFIGE CODES IM WARENEINGANG (19.09.2026, Vorgabe Samet) ──────────
 *
 * «ERP-Codes entstehen nicht mehr in Preisanfrage und Bestellung, nur noch im
 *  Wareneingang — für ALLE Bestellungen, automatisch. Bis das Codesystem
 *  steht, beginnen sie dort vorläufig mit AA-BB-000001 und laufen fortlaufend
 *  weiter.» (Die erste Fassung vom selben Tag, AAA-BBB-00001, hat nie einen
 *  Code vergeben.)
 *
 * Der Kreis ist ein gewöhnlicher Nummernkreis (Kategorie AA, Unterkategorie
 * BB, sechsstellig) — derselbe atomare Zähler, dieselbe Sperre gegen schon
 * vergebene Nummern. Er legt sich beim ersten Bedarf selbst an und ist dann in
 * den Code-Einstellungen sichtbar. Er braucht keine Freigabe durch die IT: er
 * ist die Vorgabe selbst, nicht eine Wahl. */
exports.TEMPORARY_RECEIPT_CATEGORY = 'AA';
exports.TEMPORARY_RECEIPT_SCHEME = 'BB';
exports.TEMPORARY_RECEIPT_DIGITS = 6;
const ensureTemporaryReceiptScheme = async (tenantId) => {
    let category = await prisma_client_1.default.articleCodeCategory.findFirst({ where: { tenantId, code: exports.TEMPORARY_RECEIPT_CATEGORY } });
    if (!category) {
        try {
            category = await prisma_client_1.default.articleCodeCategory.create({
                data: { id: (0, nanoid_1.nanoid)(12), tenantId, code: exports.TEMPORARY_RECEIPT_CATEGORY, name: 'Wareneingang (vorläufig)', sortOrder: 9_999 },
            });
        }
        catch (error) {
            // Zwei Wareneingänge gleichzeitig: der andere war schneller.
            if (error?.code !== 'P2002')
                throw error;
            category = await prisma_client_1.default.articleCodeCategory.findFirst({ where: { tenantId, code: exports.TEMPORARY_RECEIPT_CATEGORY } });
        }
    }
    if (!category)
        throw new Error('Vorläufiger Nummernkreis konnte nicht angelegt werden.');
    let scheme = await prisma_client_1.default.articleCodeScheme.findFirst({
        where: { tenantId, categoryId: category.id, code: exports.TEMPORARY_RECEIPT_SCHEME },
    });
    if (!scheme) {
        try {
            scheme = await prisma_client_1.default.articleCodeScheme.create({
                data: {
                    ...(0, exports.newSchemeData)(tenantId, category.id, exports.TEMPORARY_RECEIPT_SCHEME, 'Vorläufige Codes', 1, 0, exports.TEMPORARY_RECEIPT_DIGITS),
                    isActive: true,
                    activatedAt: new Date(),
                },
            });
        }
        catch (error) {
            if (error?.code !== 'P2002')
                throw error;
            scheme = await prisma_client_1.default.articleCodeScheme.findFirst({
                where: { tenantId, categoryId: category.id, code: exports.TEMPORARY_RECEIPT_SCHEME },
            });
        }
    }
    if (!scheme)
        throw new Error('Vorläufiger Nummernkreis konnte nicht angelegt werden.');
    if (!scheme.isActive) {
        await prisma_client_1.default.articleCodeScheme.update({ where: { id: scheme.id }, data: { isActive: true, activatedAt: new Date() } });
    }
    return scheme.id;
};
/** `count` fortlaufende vorläufige Codes AA-BB-NNNNNN für den Wareneingang. */
const issueTemporaryReceiptCodes = async (tenantId, count) => {
    const schemeId = await ensureTemporaryReceiptScheme(tenantId);
    return (await (0, exports.issueCodes)(tenantId, schemeId, count)).codes;
};
exports.issueTemporaryReceiptCodes = issueTemporaryReceiptCodes;
/** Die Zeilen fuer einen neuen Nummernkreis — vom Aufrufer schon geprueft. */
const newSchemeData = (tenantId, categoryId, code, name, startNumber, sortOrder, digits = exports.CODE_DIGITS) => ({
    id: (0, nanoid_1.nanoid)(12),
    tenantId,
    categoryId,
    code,
    name: name || code,
    startNumber: Math.max(1, Math.floor(startNumber) || 1),
    lastNumber: 0,
    digits: Math.min(Math.max(Math.floor(digits) || exports.CODE_DIGITS, exports.MIN_DIGITS), exports.MAX_DIGITS),
    isActive: false,
    sortOrder,
});
exports.newSchemeData = newSchemeData;
//# sourceMappingURL=articleCodeCatalog.js.map