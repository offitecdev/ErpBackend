"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOM_PROCUREMENT_KINDS = exports.BOM_UNITS = exports.mainBomPrefixOf = exports.MAIN_BOM_PREFIX = exports.BUILT_IN_CATEGORY_CODE = exports.areaOfCategory = exports.categoryOfArea = exports.isCustomBomCategory = exports.CUSTOM_BOM_CATEGORY = exports.BOM_CATEGORIES = void 0;
exports.BOM_CATEGORIES = ['MACHINE', 'ELECTRICAL'];
/**
 * Eigene Kategorien (02.10.2026, «add category button to create categories
 * like Mechanical and Electric»): ihre Kennung «c-xxxxxxxx» ist zugleich
 * Bereich der BOM und Kategorie der Vorlage — Tabelle `uretim_bom_kategorileri`.
 */
exports.CUSTOM_BOM_CATEGORY = /^c-[a-z0-9]{8}$/;
const isCustomBomCategory = (value) => typeof value === 'string' && exports.CUSTOM_BOM_CATEGORY.test(value);
exports.isCustomBomCategory = isCustomBomCategory;
/** Makine ↔ Mekanik, Elektrik ↔ Elektrik; eine eigene Kategorie ist beides zugleich. */
const categoryOfArea = (area) => (area === 'MECHANICAL' ? 'MACHINE' : area);
exports.categoryOfArea = categoryOfArea;
const areaOfCategory = (category) => (category === 'MACHINE' ? 'MECHANICAL' : category);
exports.areaOfCategory = areaOfCategory;
/** «Mekanik MEK-00001, Elektrik ELK-00001 — automatisch.» */
exports.BUILT_IN_CATEGORY_CODE = { MECHANICAL: 'MEK', ELECTRICAL: 'ELK' };
/** «Ana BOM kod şudur: BOM-MEK-00001, BOM-ELK-00001.» */
exports.MAIN_BOM_PREFIX = { MECHANICAL: 'BOM-MEK', ELECTRICAL: 'BOM-ELK' };
/** Der Vorsatz der Haupt-BOM aus dem Kod der Kategorie (MEK → BOM-MEK). */
const mainBomPrefixOf = (categoryCode) => `BOM-${categoryCode}`;
exports.mainBomPrefixOf = mainBomPrefixOf;
/** Einheiten der Zeilen (Depo-Karten führen keine eigene Einheit). */
exports.BOM_UNITS = ['PCS', 'M', 'KG', 'SET', 'PACK'];
exports.BOM_PROCUREMENT_KINDS = ['PRICE', 'ORDER'];
//# sourceMappingURL=ProductionBom.js.map