"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.variantRequiredReasons = exports.parsePanelModelNumber = exports.formatPanelModelNumber = exports.isValidVariantCode = exports.isValidFamilyCode = exports.normalizePanelCode = exports.PANEL_RATING_PAD = exports.ratingUnitLabel = exports.PANEL_RATING_UNITS = void 0;
exports.PANEL_RATING_UNITS = ['KW', 'A', 'KVAR', 'NONE'];
/** Anzeige der Einheit auf Schild und Liste. */
const ratingUnitLabel = (unit) => {
    switch (String(unit || '').toUpperCase()) {
        case 'KW': return 'kW';
        case 'A': return 'A';
        case 'KVAR': return 'kvar';
        default: return '';
    }
};
exports.ratingUnitLabel = ratingUnitLabel;
/**
 * Die Zahl wird auf DREI Stellen aufgefüllt (025, 250) und wächst darüber
 * hinaus natürlich (1000). So sind alle Schilder gleich breit und die Liste
 * sortiert richtig; Baris' Beispiel `OT-CP-250` bleibt unverändert.
 */
exports.PANEL_RATING_PAD = 3;
/** 2–4 Grossbuchstaben/Ziffern — dieselbe Form wie die Kürzel der ERP-Codes. */
const FAMILY_CODE = /^[A-Z0-9]{2,4}$/;
/** 1–8 Grossbuchstaben/Ziffern. */
const VARIANT_CODE = /^[A-Z0-9]{1,8}$/;
/** Grossbuchstaben, Umlaute aufgelöst, alles andere verworfen. */
const normalizePanelCode = (value, maxLength) => String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß/g, 'SS')
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, maxLength);
exports.normalizePanelCode = normalizePanelCode;
const isValidFamilyCode = (value) => FAMILY_CODE.test(value);
exports.isValidFamilyCode = isValidFamilyCode;
const isValidVariantCode = (value) => VARIANT_CODE.test(value);
exports.isValidVariantCode = isValidVariantCode;
/** `OT` + `CP` + `250` + (`I65`) → «OT-CP-250-I65». */
const formatPanelModelNumber = (parts) => {
    const prefix = (0, exports.normalizePanelCode)(parts.prefix || 'OT', 8) || 'OT';
    const typeCode = (0, exports.normalizePanelCode)(parts.typeCode, 4);
    const rating = Math.max(0, Math.trunc(Number(parts.ratingValue) || 0));
    const variant = parts.variantCode ? (0, exports.normalizePanelCode)(parts.variantCode, 8) : '';
    const body = `${prefix}-${typeCode}-${String(rating).padStart(exports.PANEL_RATING_PAD, '0')}`;
    return variant ? `${body}-${variant}` : body;
};
exports.formatPanelModelNumber = formatPanelModelNumber;
/** «OT-CP-250-I65» → seine Teile; passt die Form nicht, kommt null. */
const parsePanelModelNumber = (value) => {
    const match = String(value || '').trim().toUpperCase()
        .match(/^([A-Z0-9]{2,8})-([A-Z0-9]{2,4})-(\d{1,6})(?:-([A-Z0-9]{1,8}))?$/);
    if (!match)
        return null;
    return {
        prefix: String(match[1]),
        typeCode: String(match[2]),
        ratingValue: Number(match[3]),
        variantCode: match[4] || null,
    };
};
exports.parsePanelModelNumber = parsePanelModelNumber;
/**
 * Die Gründe, aus denen dieses Modell ein Variantenkürzel braucht. Leere Liste
 * = keines nötig. (Die Prüfung sagt nur, OB eines nötig ist — welches, bleibt
 * die Entscheidung des Bearbeiters.)
 */
const variantRequiredReasons = (rules, defaults, input) => {
    const active = rules || {};
    const reasons = [];
    if (active.ip) {
        const fallback = String(defaults.ipRating || '').trim().toUpperCase();
        const own = String(input.ipRating || '').trim().toUpperCase();
        // Ohne Voreinstellung gibt es nichts, wovon abgewichen werden könnte.
        if (fallback && own && own !== fallback)
            reasons.push('ip');
    }
    if (active.voltage) {
        const fallback = Number(defaults.ratedVoltage ?? 0);
        const own = Number(input.ratedVoltage ?? 0);
        if (fallback > 0 && own > 0 && Math.abs(own - fallback) > 0.001)
            reasons.push('voltage');
    }
    if (active.custom && input.hasCustomDeviation)
        reasons.push('custom');
    return reasons;
};
exports.variantRequiredReasons = variantRequiredReasons;
//# sourceMappingURL=panelModelNumber.js.map