"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.newSchemeData = exports.issueCodes = exports.previewNextCode = exports.highestIssuedNumber = exports.listCodeCategories = exports.looksLikeErpCode = exports.codePrefix = exports.formatErpCode = exports.isValidShortCode = exports.normalizeShortCode = exports.MAX_CODE_NAME_LENGTH = exports.CODE_DIGITS = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
/* ERP-CODES (Einstellungen → Module → Lager → Code-Einstellungen, 10.09.2026)
 *
 * Jeder Artikel traegt genau EINEN ERP-Code im Format `KAT-UNTER-NNNNN`:
 * Kategorie («Elektro» = ELK), Unterkategorie/Nummernkreis («PLC» = PLC) und
 * eine fuenfstellige Laufnummer, die je Nummernkreis hochlaeuft —
 * ELK-PLC-00001, ELK-PLC-00002 …
 *
 * Die IT BEREITET Nummernkreise vor (Kuerzel, Name, Startnummer). Erst nach
 * der FREIGABE ueber die IT-Schleuse (`isActive`) darf ein Kreis Codes
 * vergeben und erscheint in der Schnellerfassung.
 *
 * Die Laufnummer wird ATOMAR gezogen (`UPDATE … SET lastNumber = lastNumber+1`
 * in einem Zug ueber Prisma's `increment`), damit zwei gleichzeitige
 * Erfassungen nie dieselbe Nummer bekommen. Trifft die Nummer dennoch auf einen
 * vorhandenen Code (Altbestand, Import), zieht der Aufrufer die naechste.
 */
exports.CODE_DIGITS = 5;
/** Kuerzel: 2–4 Grossbuchstaben oder Ziffern, keine Umlaute (Annahme 45 der Spezifikation). */
const SHORT_CODE = /^[A-Z0-9]{2,4}$/;
exports.MAX_CODE_NAME_LENGTH = 80;
/** Ein Kuerzel in Grossbuchstaben, Umlaute aufgeloest, Rest verworfen. */
const normalizeShortCode = (value) => String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß/g, 'SS')
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
exports.normalizeShortCode = normalizeShortCode;
const isValidShortCode = (value) => SHORT_CODE.test(value);
exports.isValidShortCode = isValidShortCode;
const formatErpCode = (categoryCode, schemeCode, n) => `${categoryCode}-${schemeCode}-${String(n).padStart(exports.CODE_DIGITS, '0')}`;
exports.formatErpCode = formatErpCode;
/** Das Praefix `KAT-UNTER-` eines Nummernkreises. */
const codePrefix = (categoryCode, schemeCode) => `${categoryCode}-${schemeCode}-`;
exports.codePrefix = codePrefix;
/** Traegt ein Code die Form KAT-UNTER-NNNNN? (Nur zur Anzeige/Erkennung — der Altbestand darf abweichen.) */
const looksLikeErpCode = (code) => /^[A-Z0-9]{2,4}-[A-Z0-9]{2,4}-\d{5,}$/.test(code);
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
/** Der Code, den der Kreis als NAECHSTES vergeben wuerde (Anzeige, nichts wird gezogen). */
const previewNextCode = (category, scheme) => (0, exports.formatErpCode)(category.code, scheme.code, Math.max(scheme.startNumber, scheme.lastNumber + 1));
exports.previewNextCode = previewNextCode;
/**
 * `count` frische Codes aus einem FREIGEGEBENEN Nummernkreis ziehen. Jede
 * Nummer wird atomar reserviert; Nummern, die schon auf einem Artikel stehen
 * (Import, Altbestand), werden uebersprungen. Wirft, wenn der Kreis fehlt oder
 * nicht freigegeben ist.
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
    const prefix = (0, exports.codePrefix)(scheme.category.code, scheme.code);
    // Der Zaehler darf nie hinter den Artikeln zurueckliegen, die den Kreis
    // schon tragen (ein Import kann Nummern vorweggenommen haben).
    const issued = await (0, exports.highestIssuedNumber)(tenantId, prefix);
    const floor = Math.max(scheme.startNumber - 1, issued, scheme.lastNumber);
    if (floor > scheme.lastNumber) {
        await prisma_client_1.default.articleCodeScheme.updateMany({
            where: { id: scheme.id, lastNumber: { lt: floor } },
            data: { lastNumber: floor },
        });
    }
    const codes = [];
    // Atomar: jede Reservierung ist EIN UPDATE mit increment; gleichzeitige
    // Aufrufer bekommen verschiedene Nummern.
    let guard = 0;
    while (codes.length < count && guard < count + 50) {
        guard += 1;
        const updated = await prisma_client_1.default.articleCodeScheme.update({
            where: { id: scheme.id },
            data: { lastNumber: { increment: 1 } },
            select: { lastNumber: true },
        });
        codes.push((0, exports.formatErpCode)(scheme.category.code, scheme.code, updated.lastNumber));
    }
    return { codes, scheme: scheme };
};
exports.issueCodes = issueCodes;
/** Die Zeilen fuer einen neuen Nummernkreis — vom Aufrufer schon geprueft. */
const newSchemeData = (tenantId, categoryId, code, name, startNumber, sortOrder) => ({
    id: (0, nanoid_1.nanoid)(12),
    tenantId,
    categoryId,
    code,
    name: name || code,
    startNumber: Math.max(1, Math.floor(startNumber) || 1),
    lastNumber: 0,
    isActive: false,
    sortOrder,
});
exports.newSchemeData = newSchemeData;
//# sourceMappingURL=articleCodeCatalog.js.map