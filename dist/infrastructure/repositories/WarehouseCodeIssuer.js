"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reserveBarcodes = exports.reserveErpCodes = exports.CARD_TX_OPTIONS = exports.CODE_TX_OPTIONS = void 0;
const client_1 = require("@prisma/client");
const warehouse_1 = require("../../domain/services/warehouse");
const warehouseCodes_1 = require("../../domain/services/warehouseCodes");
/** Zeitstempel für rohe Anweisungen — UTC wie jeder Prisma-Zeitstempel. */
const sqlNow = () => new Date().toISOString().slice(0, 23).replace('T', ' ');
const range = (from, to) => {
    const out = [];
    for (let n = from; n <= to; n += 1)
        out.push(n);
    return out;
};
/** Vorgänge mit Nummern: ein Aktarım von zweitausend Zeilen braucht Zeit. */
exports.CODE_TX_OPTIONS = { timeout: 180_000, maxWait: 20_000 };
exports.CARD_TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 };
/**
 * `count` ERP-Codes der Gruppe, in aufsteigender Reihenfolge.
 * Fehler: GROUP_NOT_FOUND (Gruppe weg), GROUP_CODE_MISSING (Gruppe ohne Kürzel).
 */
const reserveErpCodes = async (tx, tenantId, groupId, count) => {
    if (count <= 0)
        return [];
    const codes = [];
    let jumped = false;
    for (let round = 0; codes.length < count && round < 40; round += 1) {
        const need = count - codes.length;
        const changed = await tx.$executeRaw `
            UPDATE depo_malzeme_gruplari SET lastNumber = lastNumber + ${need}
             WHERE id = ${groupId} AND tenantId = ${tenantId}`;
        if (!changed)
            throw (0, warehouse_1.warehouseError)('GROUP_NOT_FOUND', 'Materialgruppe nicht gefunden.', { status: 400 });
        const [group] = await tx.$queryRaw `
            SELECT g.lastNumber, g.code, c.code AS categoryCode
              FROM depo_malzeme_gruplari g
              JOIN depo_ana_kategoriler c ON c.id = g.categoryId
             WHERE g.id = ${groupId}`;
        if (!group?.code || !group.categoryCode) {
            throw (0, warehouse_1.warehouseError)('GROUP_CODE_MISSING', 'Diese Materialgruppe hat noch kein Kürzel.', { status: 409 });
        }
        const last = Number(group.lastNumber);
        const candidates = range(last - need + 1, last).map((n) => (0, warehouseCodes_1.formatErpCode)(group.categoryCode, group.code, n));
        const taken = await tx.$queryRaw `
            SELECT erpCode FROM depo_urun_kartlari
             WHERE tenantId = ${tenantId} AND erpCode IN (${client_1.Prisma.join(candidates)})`;
        const takenSet = new Set(taken.map((row) => String(row.erpCode).toUpperCase()));
        const free = candidates.filter((code) => !takenSet.has(code));
        codes.push(...free);
        if (!free.length && !jumped) {
            // Ein geschlossener Block Vergebenes: einmal über die höchste
            // vergebene Nummer dieses Präfixes springen.
            jumped = true;
            const prefix = (0, warehouseCodes_1.erpPrefix)(group.categoryCode, group.code);
            const [high] = await tx.$queryRaw `
                SELECT MAX(CAST(SUBSTRING(erpCode, ${prefix.length + 1}) AS UNSIGNED)) AS high
                  FROM depo_urun_kartlari
                 WHERE tenantId = ${tenantId}
                   AND erpCode LIKE ${`${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}%`}
                   AND SUBSTRING(erpCode, ${prefix.length + 1}) REGEXP '^[0-9]+$'`;
            const highest = Number(high?.high ?? 0);
            if (highest > last) {
                await tx.$executeRaw `
                    UPDATE depo_malzeme_gruplari SET lastNumber = GREATEST(lastNumber, ${highest})
                     WHERE id = ${groupId} AND tenantId = ${tenantId}`;
            }
        }
    }
    if (codes.length < count)
        throw new Error('Depo: keine freien ERP-Codes gefunden.');
    return codes.slice(0, count);
};
exports.reserveErpCodes = reserveErpCodes;
/**
 * `count` firmeninterne GS1-Barcodes (04 + zehn Stellen + Prüfziffer). Ein
 * Code, der schon als Barcode oder Herstellerbarcode einer Karte steht — auch
 * als Barcode eines ihrer Lieferanten, auch in seiner zwölfstelligen
 * UPC-Form —, wird übersprungen.
 */
const reserveBarcodes = async (tx, tenantId, count) => {
    if (count <= 0)
        return [];
    const barcodes = [];
    for (let round = 0; barcodes.length < count && round < 20; round += 1) {
        const need = count - barcodes.length;
        await tx.$executeRaw `
            INSERT INTO depo_ayarlar (tenantId, barcodeLastNumber, updatedAt)
            VALUES (${tenantId}, ${need}, ${sqlNow()})
            ON DUPLICATE KEY UPDATE barcodeLastNumber = barcodeLastNumber + ${need}`;
        const [row] = await tx.$queryRaw `
            SELECT barcodeLastNumber FROM depo_ayarlar WHERE tenantId = ${tenantId}`;
        const last = Number(row?.barcodeLastNumber ?? 0);
        if (!Number.isFinite(last) || last > warehouseCodes_1.MAX_BARCODE_NUMBER) {
            throw (0, warehouse_1.warehouseError)('BARCODE_RANGE_EXHAUSTED', 'Der Barcodebereich der Firma ist erschöpft.', { status: 409 });
        }
        const candidates = range(last - need + 1, last).map(warehouseCodes_1.gs1InternalBarcode);
        const probes = [...new Set(candidates.flatMap(warehouseCodes_1.codeVariants))];
        const taken = await tx.$queryRaw `
            SELECT barcode AS code FROM depo_urun_kartlari
             WHERE tenantId = ${tenantId} AND barcode IN (${client_1.Prisma.join(probes)})
            UNION
            SELECT manufacturerBarcode AS code FROM depo_urun_kartlari
             WHERE tenantId = ${tenantId} AND manufacturerBarcode IN (${client_1.Prisma.join(probes)})
            UNION
            SELECT barcode AS code FROM depo_urun_tedarikcileri
             WHERE tenantId = ${tenantId} AND barcode IN (${client_1.Prisma.join(probes)})`;
        const takenSet = new Set(taken.map((entry) => String(entry.code)));
        barcodes.push(...candidates.filter((code) => !(0, warehouseCodes_1.codeVariants)(code).some((variant) => takenSet.has(variant))));
    }
    if (barcodes.length < count)
        throw new Error('Depo: keine freien Barcodes gefunden.');
    return barcodes.slice(0, count);
};
exports.reserveBarcodes = reserveBarcodes;
//# sourceMappingURL=WarehouseCodeIssuer.js.map