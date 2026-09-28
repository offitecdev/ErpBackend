"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOM_PROCUREMENT_KINDS = exports.BOM_UNITS = exports.MAIN_BOM_PREFIX = exports.AREA_OF_CATEGORY = exports.CATEGORY_OF_AREA = exports.BOM_CATEGORIES = void 0;
exports.BOM_CATEGORIES = ['MACHINE', 'ELECTRICAL'];
/** Makine ↔ Mekanik, Elektrik ↔ Elektrik. */
exports.CATEGORY_OF_AREA = { MECHANICAL: 'MACHINE', ELECTRICAL: 'ELECTRICAL' };
exports.AREA_OF_CATEGORY = { MACHINE: 'MECHANICAL', ELECTRICAL: 'ELECTRICAL' };
/** «Ana BOM kod şudur: BOM-MEK-00001, BOM-ELK-00001.» */
exports.MAIN_BOM_PREFIX = { MECHANICAL: 'BOM-MEK', ELECTRICAL: 'BOM-ELK' };
/** Einheiten der Zeilen (Depo-Karten führen keine eigene Einheit). */
exports.BOM_UNITS = ['PCS', 'M', 'KG', 'SET', 'PACK'];
exports.BOM_PROCUREMENT_KINDS = ['PRICE', 'ORDER'];
//# sourceMappingURL=ProductionBom.js.map