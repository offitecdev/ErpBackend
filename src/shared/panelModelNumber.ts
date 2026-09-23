/**
 * MODELLNUMMER EINES SCHALTSCHRANKS — `OT-CP-250` (Vorgabe Baris, 20.09.2026).
 *
 *   OT   Hersteller-Präfix (Einstellung `PanelSettings.modelPrefix`)
 *   CP   TYPENFAMILIE aus dem Katalog (`uretim_pano_tipleri`) — FRAGE 1
 *   250  LEISTUNGSKLASSE; was die Zahl bedeutet, sagt die Familie: kW, A oder
 *        kvar (`ratingUnit`) — FRAGE 2
 *   -I65 VARIANTE, nur wenn sich zwei Schränke derselben Klasse technisch
 *        unterscheiden — FRAGE 5
 *
 * ── Die eine Regel ──────────────────────────────────────────────────────────
 * Die Nummer wird GEBILDET, nie getippt. Gleiche Technik = gleiches Modell;
 * weicht ein Schildwert ab (Ue, InA, Phasen/Frequenz, Icw, IP, Norm), ist es
 * ein ANDERES Modell und braucht eine eigene Nummer. Darum kennt die
 * Oberfläche kein Eingabefeld für `modelNumber`, sondern Auswahlfelder — und
 * `uretim_pano_modelleri` hat den eindeutigen Schlüssel (tenantId, modelNumber).
 *
 * Die Seriennummer steht bewusst NICHT hier: sie gehört nicht zum Typ, sondern
 * zum einzelnen Schrank (shared/panelSerial.ts).
 */

/** Die Einheit, in der die Zahl der Modellnummer gemessen wird. */
export type PanelRatingUnit = 'KW' | 'A' | 'KVAR' | 'NONE';

export const PANEL_RATING_UNITS: PanelRatingUnit[] = ['KW', 'A', 'KVAR', 'NONE'];

/** Anzeige der Einheit auf Schild und Liste. */
export const ratingUnitLabel = (unit: string | null | undefined): string => {
    switch (String(unit || '').toUpperCase()) {
        case 'KW': return 'kW';
        case 'A': return 'A';
        case 'KVAR': return 'kvar';
        default: return '';
    }
};

/**
 * Die Zahl wird auf DREI Stellen aufgefüllt (025, 250) und wächst darüber
 * hinaus natürlich (1000). So sind alle Schilder gleich breit und die Liste
 * sortiert richtig; Baris' Beispiel `OT-CP-250` bleibt unverändert.
 */
export const PANEL_RATING_PAD = 3;

/** 2–4 Grossbuchstaben/Ziffern — dieselbe Form wie die Kürzel der ERP-Codes. */
const FAMILY_CODE = /^[A-Z0-9]{2,4}$/;
/** 1–8 Grossbuchstaben/Ziffern. */
const VARIANT_CODE = /^[A-Z0-9]{1,8}$/;

/** Grossbuchstaben, Umlaute aufgelöst, alles andere verworfen. */
export const normalizePanelCode = (value: unknown, maxLength: number): string =>
    String(value ?? '')
        .trim()
        .toUpperCase()
        .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß/g, 'SS')
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, maxLength);

export const isValidFamilyCode = (value: string): boolean => FAMILY_CODE.test(value);
export const isValidVariantCode = (value: string): boolean => VARIANT_CODE.test(value);

export interface PanelModelNumberParts {
    prefix: string;
    typeCode: string;
    ratingValue: number;
    variantCode?: string | null;
}

/** `OT` + `CP` + `250` + (`I65`) → «OT-CP-250-I65». */
export const formatPanelModelNumber = (parts: PanelModelNumberParts): string => {
    const prefix = normalizePanelCode(parts.prefix || 'OT', 8) || 'OT';
    const typeCode = normalizePanelCode(parts.typeCode, 4);
    const rating = Math.max(0, Math.trunc(Number(parts.ratingValue) || 0));
    const variant = parts.variantCode ? normalizePanelCode(parts.variantCode, 8) : '';
    const body = `${prefix}-${typeCode}-${String(rating).padStart(PANEL_RATING_PAD, '0')}`;
    return variant ? `${body}-${variant}` : body;
};

/** «OT-CP-250-I65» → seine Teile; passt die Form nicht, kommt null. */
export const parsePanelModelNumber = (value: string | null | undefined): PanelModelNumberParts | null => {
    const match = String(value || '').trim().toUpperCase()
        .match(/^([A-Z0-9]{2,8})-([A-Z0-9]{2,4})-(\d{1,6})(?:-([A-Z0-9]{1,8}))?$/);
    if (!match) return null;
    return {
        prefix: String(match[1]),
        typeCode: String(match[2]),
        ratingValue: Number(match[3]),
        variantCode: match[4] || null,
    };
};

/* ── FRAGE 5: WANN IST EIN VARIANTENKÜRZEL PFLICHT? ──────────────────────────
 *
 * Nicht im Code entschieden, sondern in `PanelSettings.variantRules`:
 *
 *   { "ip": true, "voltage": true, "custom": false }
 *
 *   ip       das Modell weicht von der IP-Voreinstellung der Firma ab
 *   voltage  seine Bemessungsspannung weicht von der Voreinstellung ab
 *   custom   jede Abweichung, die der Bearbeiter selbst meldet
 *
 * Trifft eine eingeschaltete Regel zu und fehlt das Kürzel, lehnt das Anlegen
 * mit `VARIANT_REQUIRED` ab und nennt den GRUND — damit niemand raten muss.
 */
export interface PanelVariantRules {
    ip?: boolean;
    voltage?: boolean;
    custom?: boolean;
}

export interface PanelVariantCheckInput {
    ipRating?: string | null | undefined;
    ratedVoltage?: number | null | undefined;
    /** Der Bearbeiter hat eine eigene Abweichung angegeben. */
    hasCustomDeviation?: boolean | undefined;
    variantCode?: string | null | undefined;
}

export interface PanelVariantDefaults {
    ipRating?: string | null | undefined;
    ratedVoltage?: number | null | undefined;
}

/**
 * Die Gründe, aus denen dieses Modell ein Variantenkürzel braucht. Leere Liste
 * = keines nötig. (Die Prüfung sagt nur, OB eines nötig ist — welches, bleibt
 * die Entscheidung des Bearbeiters.)
 */
export const variantRequiredReasons = (
    rules: PanelVariantRules | null | undefined,
    defaults: PanelVariantDefaults,
    input: PanelVariantCheckInput,
): Array<'ip' | 'voltage' | 'custom'> => {
    const active = rules || {};
    const reasons: Array<'ip' | 'voltage' | 'custom'> = [];

    if (active.ip) {
        const fallback = String(defaults.ipRating || '').trim().toUpperCase();
        const own = String(input.ipRating || '').trim().toUpperCase();
        // Ohne Voreinstellung gibt es nichts, wovon abgewichen werden könnte.
        if (fallback && own && own !== fallback) reasons.push('ip');
    }
    if (active.voltage) {
        const fallback = Number(defaults.ratedVoltage ?? 0);
        const own = Number(input.ratedVoltage ?? 0);
        if (fallback > 0 && own > 0 && Math.abs(own - fallback) > 0.001) reasons.push('voltage');
    }
    if (active.custom && input.hasCustomDeviation) reasons.push('custom');

    return reasons;
};
