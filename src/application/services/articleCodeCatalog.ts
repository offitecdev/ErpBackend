import { nanoid } from 'nanoid';
import prisma from '../../infrastructure/database/prisma.client';

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

export const CODE_DIGITS = 5;
/** Kuerzel: 2–4 Grossbuchstaben oder Ziffern, keine Umlaute (Annahme 45 der Spezifikation). */
const SHORT_CODE = /^[A-Z0-9]{2,4}$/;
export const MAX_CODE_NAME_LENGTH = 80;

export interface CodeSchemeRow {
    id: string;
    tenantId: string;
    categoryId: string;
    code: string;
    name: string;
    startNumber: number;
    lastNumber: number;
    isActive: boolean;
    activatedById: string | null;
    activatedAt: Date | null;
    sortOrder: number;
}

export interface CodeCategoryRow {
    id: string;
    tenantId: string;
    code: string;
    name: string;
    sortOrder: number;
    schemes: CodeSchemeRow[];
}

/** Ein Kuerzel in Grossbuchstaben, Umlaute aufgeloest, Rest verworfen. */
export const normalizeShortCode = (value: unknown): string =>
    String(value ?? '')
        .trim()
        .toUpperCase()
        .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß/g, 'SS')
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 4);

export const isValidShortCode = (value: string): boolean => SHORT_CODE.test(value);

export const formatErpCode = (categoryCode: string, schemeCode: string, n: number): string =>
    `${categoryCode}-${schemeCode}-${String(n).padStart(CODE_DIGITS, '0')}`;

/** Das Praefix `KAT-UNTER-` eines Nummernkreises. */
export const codePrefix = (categoryCode: string, schemeCode: string): string => `${categoryCode}-${schemeCode}-`;

/** Traegt ein Code die Form KAT-UNTER-NNNNN? (Nur zur Anzeige/Erkennung — der Altbestand darf abweichen.) */
export const looksLikeErpCode = (code: string): boolean => /^[A-Z0-9]{2,4}-[A-Z0-9]{2,4}-\d{5,}$/.test(code);

/** Alle Kategorien des Mandanten mit ihren Nummernkreisen (auch unfreigegebene). */
export const listCodeCategories = async (tenantId: string, options: { activeOnly?: boolean } = {}): Promise<CodeCategoryRow[]> => {
    const rows = await prisma.articleCodeCategory.findMany({
        where: { tenantId },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        include: {
            schemes: {
                ...(options.activeOnly ? { where: { isActive: true } } : {}),
                orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
            },
        },
    });
    const categories = rows as unknown as CodeCategoryRow[];
    // Fuer die Auswahl in der Schnellerfassung zaehlt nur, was Codes vergeben darf.
    return options.activeOnly ? categories.filter((row) => row.schemes.length > 0) : categories;
};

/**
 * Die hoechste Laufnummer, die unter diesem Praefix schon auf einem Artikel
 * steht (auch im Papierkorb — der eindeutige Schluessel kennt keinen
 * Papierkorb). 0 = noch keine.
 */
export const highestIssuedNumber = async (tenantId: string, prefix: string): Promise<number> => {
    const pattern = '^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[0-9]+$';
    const rows: Array<{ maxNo: bigint | number | null }> = await prisma.$queryRaw`
        SELECT MAX(CAST(SUBSTRING(articleCode, ${prefix.length + 1}) AS UNSIGNED)) AS maxNo
        FROM Article
        WHERE tenantId = ${tenantId}
          AND articleCode REGEXP ${pattern}
    `;
    const value = rows[0]?.maxNo;
    return value === null || value === undefined ? 0 : Number(value);
};

/** Der Code, den der Kreis als NAECHSTES vergeben wuerde (Anzeige, nichts wird gezogen). */
export const previewNextCode = (category: { code: string }, scheme: { code: string; startNumber: number; lastNumber: number }): string =>
    formatErpCode(category.code, scheme.code, Math.max(scheme.startNumber, scheme.lastNumber + 1));

/**
 * `count` frische Codes aus einem FREIGEGEBENEN Nummernkreis ziehen. Jede
 * Nummer wird atomar reserviert; Nummern, die schon auf einem Artikel stehen
 * (Import, Altbestand), werden uebersprungen. Wirft, wenn der Kreis fehlt oder
 * nicht freigegeben ist.
 */
export const issueCodes = async (tenantId: string, schemeId: string, count: number): Promise<{ codes: string[]; scheme: CodeSchemeRow & { category: { code: string; name: string } } }> => {
    const scheme = await prisma.articleCodeScheme.findFirst({
        where: { id: schemeId, tenantId },
        include: { category: { select: { code: true, name: true } } },
    });
    if (!scheme) throw Object.assign(new Error('Nummernkreis nicht gefunden.'), { status: 404, code: 'SCHEME_NOT_FOUND' });
    if (!scheme.isActive) throw Object.assign(new Error('Dieser Nummernkreis ist noch nicht von der IT freigegeben.'), { status: 409, code: 'SCHEME_INACTIVE' });

    const prefix = codePrefix(scheme.category.code, scheme.code);
    // Der Zaehler darf nie hinter den Artikeln zurueckliegen, die den Kreis
    // schon tragen (ein Import kann Nummern vorweggenommen haben).
    const issued = await highestIssuedNumber(tenantId, prefix);
    const floor = Math.max(scheme.startNumber - 1, issued, scheme.lastNumber);
    if (floor > scheme.lastNumber) {
        await prisma.articleCodeScheme.updateMany({
            where: { id: scheme.id, lastNumber: { lt: floor } },
            data: { lastNumber: floor },
        });
    }

    const codes: string[] = [];
    // Atomar: jede Reservierung ist EIN UPDATE mit increment; gleichzeitige
    // Aufrufer bekommen verschiedene Nummern.
    let guard = 0;
    while (codes.length < count && guard < count + 50) {
        guard += 1;
        const updated = await prisma.articleCodeScheme.update({
            where: { id: scheme.id },
            data: { lastNumber: { increment: 1 } },
            select: { lastNumber: true },
        });
        codes.push(formatErpCode(scheme.category.code, scheme.code, updated.lastNumber));
    }
    return { codes, scheme: scheme as unknown as CodeSchemeRow & { category: { code: string; name: string } } };
};

/** Die Zeilen fuer einen neuen Nummernkreis — vom Aufrufer schon geprueft. */
export const newSchemeData = (tenantId: string, categoryId: string, code: string, name: string, startNumber: number, sortOrder: number) => ({
    id: nanoid(12),
    tenantId,
    categoryId,
    code,
    name: name || code,
    startNumber: Math.max(1, Math.floor(startNumber) || 1),
    lastNumber: 0,
    isActive: false,
    sortOrder,
});
