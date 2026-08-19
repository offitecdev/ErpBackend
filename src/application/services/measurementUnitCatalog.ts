import { nanoid } from 'nanoid';
import prisma from '../../infrastructure/database/prisma.client';
import { DEFAULT_UNITS, FALLBACK_UNIT_CODE, normalizeUnitCode } from '../../shared/measurementUnits';

/**
 * Die Mengeneinheiten EINES Mandanten — gelesen von der Einstellungsseite
 * (Einstellungen → Module → Lager → Einheiten) und von jedem Weg, der eine
 * Einheit auf einen Artikel schreibt.
 *
 * Zwei Aufgaben:
 *   `listUnits`     — die Liste; ist sie leer, wird der Erstbestand angelegt.
 *                     (Die Migration hat das für bestehende Mandanten schon
 *                     getan; ein NEU angelegter Mandant bekommt sie hier.)
 *   `resolveUnit`   — bringt einen getippten oder importierten Wert auf die
 *                     Schreibweise der Liste und setzt, wo nichts kam, die
 *                     Vorgabe des Mandanten ein.
 */

export interface UnitRow {
    id: string;
    code: string;
    name: string;
    sortOrder: number;
    isActive: boolean;
    isDefault: boolean;
}

export const UNIT_ORDER_BY = [{ sortOrder: 'asc' as const }, { code: 'asc' as const }];

export const listUnits = async (tenantId: string): Promise<UnitRow[]> => {
    const rows = await prisma.measurementUnit.findMany({ where: { tenantId }, orderBy: UNIT_ORDER_BY });
    if (rows.length) return rows;

    await prisma.measurementUnit.createMany({
        data: DEFAULT_UNITS.map((unit, index) => ({
            id: nanoid(12),
            tenantId,
            code: unit.code,
            name: unit.name,
            sortOrder: (index + 1) * 10,
            isActive: true,
            isDefault: unit.isDefault === true,
        })),
        skipDuplicates: true,
    });
    return prisma.measurementUnit.findMany({ where: { tenantId }, orderBy: UNIT_ORDER_BY });
};

/** Der Code, den ein Artikel ohne eigene Angabe bekommt. */
export const defaultUnitCode = (units: ReadonlyArray<UnitRow>): string =>
    units.find((unit) => unit.isDefault)?.code
    ?? units.find((unit) => unit.isActive)?.code
    ?? FALLBACK_UNIT_CODE;

/**
 * Einheit für einen Artikelschreibvorgang. Ein Wert, den die Liste kennt, wird
 * auf ihre Schreibweise gebracht ("stk" → "Stk"); ein unbekannter Wert bleibt
 * stehen (ein Import darf daran nicht scheitern, und die Einstellungsseite
 * zeigt ihn später als eigene Einheit); nichts eingegeben = Vorgabe.
 */
export const resolveUnit = (value: unknown, units: ReadonlyArray<UnitRow>): string =>
    normalizeUnitCode(value, units) ?? defaultUnitCode(units);
