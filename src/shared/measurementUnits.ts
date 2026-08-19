/**
 * MENGENEINHEITEN — die Liste, aus der im Lager gewählt wird (Stück, Meter,
 * Kilogramm, Liter, Set, Packung …). Sie ist KEINE feste Aufzählung im Code:
 * jeder Mandant hat seine eigene Liste in der Tabelle `MeasurementUnit` und
 * pflegt sie unter Einstellungen → Module → Lager → Einheiten. Was hier steht,
 * ist nur der ERSTBESTAND, der einem Mandanten angelegt wird, solange er noch
 * keine eigene Liste hat.
 *
 * Eine Einheit sind zwei Angaben:
 *   `code` — das kurze Zeichen, das in Listen, Belegen und PDFs neben der Menge
 *            steht ("Stk", "m", "kg"). Genau DAS wird auf dem Artikel
 *            gespeichert (`Article.unit`), damit alles Bestehende weiterläuft.
 *   `name` — der ausgeschriebene Name, den das Auswahlfeld anzeigt ("Stück").
 *
 * Der `code` ist je Mandant eindeutig — ohne Rücksicht auf Gross-/Kleinschrift
 * ("STK" und "Stk" wären dieselbe Einheit). `normalizeUnitCode` bringt einen
 * getippten oder importierten Wert deshalb auf die Schreibweise der Liste.
 */

export const MAX_UNIT_CODE_LENGTH = 24;
export const MAX_UNIT_NAME_LENGTH = 60;

export interface UnitSeed {
    code: string;
    name: string;
    /** Vorgabe für neue Artikel — genau EINE Einheit trägt sie. */
    isDefault?: boolean;
}

/**
 * Erstbestand. Reihenfolge = Anzeigereihenfolge; Stück steht vorn, weil es die
 * überwiegende Mehrheit der Artikel trägt, danach Längen, Flächen, Gewichte,
 * Volumen und zuletzt die Gebinde- und Zeiteinheiten.
 */
export const DEFAULT_UNITS: ReadonlyArray<UnitSeed> = [
    { code: 'Stk', name: 'Stück', isDefault: true },
    { code: 'm', name: 'Meter' },
    { code: 'lfm', name: 'Laufmeter' },
    { code: 'm²', name: 'Quadratmeter' },
    { code: 'm³', name: 'Kubikmeter' },
    { code: 'mm', name: 'Millimeter' },
    { code: 'cm', name: 'Zentimeter' },
    { code: 'kg', name: 'Kilogramm' },
    { code: 'g', name: 'Gramm' },
    { code: 't', name: 'Tonne' },
    { code: 'l', name: 'Liter' },
    { code: 'ml', name: 'Milliliter' },
    { code: 'Set', name: 'Set' },
    { code: 'Pkg', name: 'Packung' },
    { code: 'Ktn', name: 'Karton' },
    { code: 'Pal', name: 'Palette' },
    { code: 'Rolle', name: 'Rolle' },
    { code: 'Paar', name: 'Paar' },
    { code: 'Std', name: 'Stunde' },
    { code: 'Tag', name: 'Tag' },
    { code: 'Psch', name: 'Pauschal' },
];

/** Die Einheit, die ein Artikel ohne eigene Angabe bekommt. */
export const FALLBACK_UNIT_CODE = DEFAULT_UNITS.find((unit) => unit.isDefault)?.code ?? 'Stk';

/** Vergleichsform eines Zeichens: Leerraum weg, Gross-/Kleinschrift egal. */
export const unitKey = (code: unknown): string => String(code ?? '').trim().toLowerCase();

/**
 * Bringt einen getippten/importierten Wert auf die Schreibweise der Liste.
 * Kennt die Liste ihn nicht, bleibt der getrimmte Text stehen (ein Import darf
 * an einer unbekannten Einheit nicht scheitern) — leer ergibt null.
 */
export const normalizeUnitCode = (
    value: unknown,
    known: ReadonlyArray<{ code: string }>,
): string | null => {
    const text = String(value ?? '').trim();
    if (!text) return null;
    const match = known.find((unit) => unitKey(unit.code) === unitKey(text));
    return match ? match.code : text.slice(0, MAX_UNIT_CODE_LENGTH);
};
