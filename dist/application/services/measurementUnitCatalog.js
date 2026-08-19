"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveUnit = exports.defaultUnitCode = exports.listUnits = exports.UNIT_ORDER_BY = void 0;
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const measurementUnits_1 = require("../../shared/measurementUnits");
exports.UNIT_ORDER_BY = [{ sortOrder: 'asc' }, { code: 'asc' }];
const listUnits = async (tenantId) => {
    const rows = await prisma_client_1.default.measurementUnit.findMany({ where: { tenantId }, orderBy: exports.UNIT_ORDER_BY });
    if (rows.length)
        return rows;
    await prisma_client_1.default.measurementUnit.createMany({
        data: measurementUnits_1.DEFAULT_UNITS.map((unit, index) => ({
            id: (0, nanoid_1.nanoid)(12),
            tenantId,
            code: unit.code,
            name: unit.name,
            sortOrder: (index + 1) * 10,
            isActive: true,
            isDefault: unit.isDefault === true,
        })),
        skipDuplicates: true,
    });
    return prisma_client_1.default.measurementUnit.findMany({ where: { tenantId }, orderBy: exports.UNIT_ORDER_BY });
};
exports.listUnits = listUnits;
/** Der Code, den ein Artikel ohne eigene Angabe bekommt. */
const defaultUnitCode = (units) => units.find((unit) => unit.isDefault)?.code
    ?? units.find((unit) => unit.isActive)?.code
    ?? measurementUnits_1.FALLBACK_UNIT_CODE;
exports.defaultUnitCode = defaultUnitCode;
/**
 * Einheit für einen Artikelschreibvorgang. Ein Wert, den die Liste kennt, wird
 * auf ihre Schreibweise gebracht ("stk" → "Stk"); ein unbekannter Wert bleibt
 * stehen (ein Import darf daran nicht scheitern, und die Einstellungsseite
 * zeigt ihn später als eigene Einheit); nichts eingegeben = Vorgabe.
 */
const resolveUnit = (value, units) => (0, measurementUnits_1.normalizeUnitCode)(value, units) ?? (0, exports.defaultUnitCode)(units);
exports.resolveUnit = resolveUnit;
//# sourceMappingURL=measurementUnitCatalog.js.map