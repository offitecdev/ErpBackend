"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaWarehouseDirectory = exports.PrismaWarehouseProductRepository = exports.supplierRows = exports.productData = exports.num = exports.newId = void 0;
const client_1 = require("@prisma/client");
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const warehouseCodes_1 = require("../../domain/services/warehouseCodes");
const WarehouseCodeIssuer_1 = require("./WarehouseCodeIssuer");
/**
 * ── DEPO: DIE PRISMA-SEITE (26.09.2026) ─────────────────────────────────────
 *
 * Die Liste läuft über EINE rohe Abfrage mit LEFT JOIN auf Gruppe und
 * Kategorie plus einer Zählung daneben — zwei Anweisungen, ein Netzweg
 * (Prisma führt jedes `include` als eigene, nachgelagerte Abfrage aus; gegen
 * die entfernte Datenbank ist das der Unterschied zwischen einer schnellen
 * und einer zähen Liste).
 *
 * Mengen bei Seriennummernpflicht: jede Änderung an den Nummern zählt die
 * Menge in derselben Transaktion neu (`recount`), die Liste kann sie darum
 * direkt aus der Karte lesen und danach sortieren.
 *
 * ERP-Code und Barcode (zweiter Durchgang): wer eine Karte mit Gruppe
 * anlegt oder die Gruppe wechselt, zieht Code und Barcode im selben Vorgang
 * (WarehouseCodeIssuer.ts).
 */
const newId = () => (0, nanoid_1.nanoid)(12);
exports.newId = newId;
/** Zeitstempel für rohe Anweisungen — UTC wie jeder Prisma-Zeitstempel. */
const sqlNow = () => new Date().toISOString().slice(0, 23).replace('T', ' ');
const num = (value) => {
    if (value === null || value === undefined)
        return 0;
    const parsed = Number(typeof value === 'object' ? String(value) : value);
    return Number.isFinite(parsed) ? parsed : 0;
};
exports.num = num;
const numOrNull = (value) => value === null || value === undefined ? null : (0, exports.num)(value);
const textOrNull = (value) => value === null || value === undefined ? null : String(value);
const dateOf = (value) => (value instanceof Date ? value : new Date(String(value)));
/** LIKE-Muster: Platzhalter im Suchtext wörtlich nehmen. */
const likePattern = (text) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
/** Gleich wie die Datenbank (utf8mb4_unicode_ci): ohne Gross/Klein, ohne Randleerzeichen. */
const sameCode = (a, b) => Boolean(a && b && a.trim().toLocaleLowerCase('de-CH') === b.trim().toLocaleLowerCase('de-CH'));
/** Die Lieferantenliste aus dem JSON der Abfrage (MariaDB liefert Text). */
const suppliersOf = (raw) => {
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        }
        catch {
            value = null;
        }
    }
    if (!Array.isArray(value))
        return [];
    return value
        .map((entry) => (entry && typeof entry === 'object' ? entry : {}))
        .filter((entry) => typeof entry.name === 'string' && entry.name)
        .map((entry) => ({
        supplierId: textOrNull(entry.supplierId),
        name: String(entry.name),
        barcode: textOrNull(entry.barcode),
    }));
};
const toProduct = (row) => ({
    id: String(row.id),
    tenantId: String(row.tenantId),
    erpCode: textOrNull(row.erpCode),
    materialGroupId: textOrNull(row.materialGroupId),
    materialGroupName: textOrNull(row.materialGroupName),
    materialGroupCode: textOrNull(row.materialGroupCode),
    categoryId: textOrNull(row.categoryId),
    categoryName: textOrNull(row.categoryName),
    categoryCode: textOrNull(row.categoryCode),
    name: String(row.name ?? ''),
    brand: textOrNull(row.brand),
    modelNumber: textOrNull(row.modelNumber),
    supplierId: textOrNull(row.supplierId),
    supplierName: textOrNull(row.supplierName),
    suppliers: suppliersOf(row.suppliersJson),
    description: textOrNull(row.description),
    quantity: (0, exports.num)(row.quantity),
    purchasePrice: numOrNull(row.purchasePrice),
    minimumOrderQuantity: numOrNull(row.minimumOrderQuantity),
    currency: textOrNull(row.currency),
    barcode: textOrNull(row.barcode),
    manufacturerBarcode: textOrNull(row.manufacturerBarcode),
    serialRequired: Boolean(Number(row.serialRequired)),
    createdAt: dateOf(row.createdAt),
    updatedAt: dateOf(row.updatedAt),
});
const toSerial = (row) => ({
    id: row.id,
    tenantId: row.tenantId,
    productId: row.productId,
    serialNumber: row.serialNumber,
    productionProjectId: row.productionProjectId ?? null,
    productionItemId: row.productionItemId ?? null,
    projectNumber: row.projectNumber ?? null,
    projectName: row.projectName ?? null,
    deviceName: row.deviceName ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});
const PRODUCT_SELECT = client_1.Prisma.sql `
    SELECT p.id, p.tenantId, p.erpCode, p.materialGroupId, g.name AS materialGroupName, g.code AS materialGroupCode,
           c.id AS categoryId, c.name AS categoryName, c.code AS categoryCode, p.name, p.brand,
           p.modelNumber, p.supplierId, p.supplierName,
           (SELECT JSON_ARRAYAGG(JSON_OBJECT('supplierId', s.supplierId, 'name', s.supplierName, 'barcode', s.barcode)
                   ORDER BY s.sortOrder, s.supplierName)
              FROM depo_urun_tedarikcileri s WHERE s.productId = p.id) AS suppliersJson,
           p.description, p.quantity,
           p.purchasePrice, p.minimumOrderQuantity, p.currency, p.barcode, p.manufacturerBarcode, p.serialRequired,
           p.createdAt, p.updatedAt
      FROM depo_urun_kartlari p
      LEFT JOIN depo_malzeme_gruplari g ON g.id = p.materialGroupId
      LEFT JOIN depo_ana_kategoriler c ON c.id = g.categoryId`;
/** Die Spalten der Sortierung — nur diese Namen gelangen je in das SQL.
    `natural`: eingebettete Zahlen als Zahlen vergleichen (HS 5 · HS 10 · HS 100). */
const SORT_COLUMNS = {
    erpCode: { column: 'p.erpCode', nullable: true, natural: true },
    name: { column: 'p.name', nullable: false, natural: true },
    brand: { column: 'p.brand', nullable: true, natural: true },
    modelNumber: { column: 'p.modelNumber', nullable: true, natural: true },
    supplierName: { column: 'p.supplierName', nullable: true, natural: true },
    description: { column: 'p.description', nullable: true, natural: false },
    quantity: { column: 'p.quantity', nullable: false, natural: false },
    barcode: { column: 'p.barcode', nullable: true, natural: true },
    updatedAt: { column: 'p.updatedAt', nullable: false, natural: false },
};
/* Die Ordnung der Produktliste im Lager (Vorgabe Samet 07.09.2026) gilt auch
   hier: erst Buchstaben, dann Zahlen, und Zahlen im Namen als Zahlen. Das
   leistet MariaDBs `NATURAL_SORT_KEY` (ab 10.7) — einmal geprüft; fehlt es,
   wird zeichenweise sortiert. Ein Fehlschlag wird nicht gemerkt (ein
   Verbindungsfehler sagt nichts über die Datenbank). */
let naturalSortSupported = null;
const supportsNaturalSort = async () => {
    if (naturalSortSupported !== null)
        return naturalSortSupported;
    try {
        await prisma_client_1.default.$queryRawUnsafe("SELECT NATURAL_SORT_KEY('a') AS k");
        naturalSortSupported = true;
        return true;
    }
    catch {
        return false;
    }
};
/** Leere Werte stehen immer am Ende — auch absteigend. */
const orderSql = (sort, direction, natural) => {
    const spec = SORT_COLUMNS[sort] ?? SORT_COLUMNS.name;
    const dir = direction === 'desc' ? 'DESC' : 'ASC';
    const key = (column, useNatural) => (useNatural && natural ? `NATURAL_SORT_KEY(${column})` : column);
    const empties = spec.nullable ? `(${spec.column} IS NULL OR ${spec.column} = '') ASC, ` : '';
    const digitsLast = spec.natural ? `(${spec.column} REGEXP '^[0-9]') ${dir}, ` : '';
    const tie = sort === 'name' ? 'p.id ASC' : `${key('p.name', true)} ASC, p.id ASC`;
    return client_1.Prisma.raw(`${empties}${digitsLast}${key(spec.column, spec.natural)} ${dir}, ${tie}`);
};
/** Der Datensatz, den die Karte beim Schreiben bekommt (der erste Lieferant als Abzug). */
const productData = (fields) => ({
    erpCode: fields.erpCode,
    materialGroupId: fields.materialGroupId,
    name: fields.name,
    brand: fields.brand,
    modelNumber: fields.modelNumber,
    supplierId: fields.suppliers[0]?.supplierId ?? null,
    supplierName: fields.suppliers[0]?.name ?? null,
    // Nicht mehr geführt (vierter Durchgang) — ein alter Abzug wird geleert.
    supplierNumber: null,
    description: fields.description,
    purchasePrice: fields.purchasePrice,
    minimumOrderQuantity: fields.minimumOrderQuantity,
    currency: fields.currency,
    barcode: fields.barcode,
    manufacturerBarcode: fields.manufacturerBarcode,
    serialRequired: fields.serialRequired,
});
exports.productData = productData;
/** Die Zeilen der Lieferantenliste einer Karte — jeder Lieferant mit seinem Barcode. */
const supplierRows = (tenantId, productId, suppliers) => suppliers.map((entry, index) => ({
    id: (0, exports.newId)(),
    tenantId,
    productId,
    supplierId: entry.supplierId,
    supplierName: entry.name,
    barcode: entry.barcode,
    sortOrder: index,
}));
exports.supplierRows = supplierRows;
/** Menge = Zahl der Seriennummern, für Karten mit Pflicht (eine Anweisung). */
const recount = (db, tenantId, productId) => db.$executeRaw `
    UPDATE depo_urun_kartlari p
       SET p.quantity = (SELECT COUNT(*) FROM depo_seri_numaralari s WHERE s.productId = p.id),
           p.updatedAt = ${sqlNow()}
     WHERE p.id = ${productId} AND p.tenantId = ${tenantId} AND p.serialRequired = 1`;
const serialData = (tenantId, productId, draft, userId) => ({
    id: (0, exports.newId)(),
    tenantId,
    productId,
    serialNumber: draft.serialNumber,
    productionProjectId: draft.productionProjectId,
    productionItemId: draft.productionItemId,
    projectNumber: draft.projectNumber,
    projectName: draft.projectName,
    deviceName: draft.deviceName,
    createdById: userId,
});
class PrismaWarehouseProductRepository {
    async list(tenantId, filter) {
        const conditions = [client_1.Prisma.sql `p.tenantId = ${tenantId}`];
        if (filter.search) {
            const pattern = likePattern(filter.search);
            conditions.push(client_1.Prisma.sql `(p.erpCode LIKE ${pattern} OR p.name LIKE ${pattern})`);
        }
        if (filter.groupIds?.length) {
            const ids = filter.groupIds.filter((id) => Boolean(id));
            const parts = [];
            if (ids.length)
                parts.push(client_1.Prisma.sql `p.materialGroupId IN (${client_1.Prisma.join(ids)})`);
            if (filter.groupIds.includes(null))
                parts.push(client_1.Prisma.sql `p.materialGroupId IS NULL`);
            conditions.push(client_1.Prisma.sql `(${client_1.Prisma.join(parts, ' OR ')})`);
        }
        if (filter.barcode) {
            // Ein EAN-13 mit führender 0 kann als zwölfstelliger UPC-A kommen.
            // Der Barcode eines Lieferanten findet seine Karte (vierter Durchgang).
            const codes = client_1.Prisma.join((0, warehouseCodes_1.codeVariants)(filter.barcode));
            conditions.push(client_1.Prisma.sql `(
                p.barcode IN (${codes}) OR p.manufacturerBarcode IN (${codes}) OR p.erpCode = ${filter.barcode}
                OR EXISTS (SELECT 1 FROM depo_urun_tedarikcileri t WHERE t.productId = p.id AND t.barcode IN (${codes}))
                OR EXISTS (SELECT 1 FROM depo_seri_numaralari s WHERE s.productId = p.id AND s.serialNumber = ${filter.barcode})
            )`);
        }
        const where = client_1.Prisma.join(conditions, ' AND ');
        const offset = (filter.page - 1) * filter.pageSize;
        const natural = await supportsNaturalSort();
        const [rows, counted] = await Promise.all([
            prisma_client_1.default.$queryRaw `${PRODUCT_SELECT}
                WHERE ${where}
                ORDER BY ${orderSql(filter.sort, filter.direction, natural)}
                LIMIT ${filter.pageSize} OFFSET ${offset}`,
            prisma_client_1.default.$queryRaw `SELECT COUNT(*) AS total FROM depo_urun_kartlari p WHERE ${where}`,
        ]);
        return { items: rows.map(toProduct), total: (0, exports.num)(counted[0]?.total) };
    }
    async get(tenantId, id) {
        const rows = await prisma_client_1.default.$queryRaw `${PRODUCT_SELECT}
            WHERE p.tenantId = ${tenantId} AND p.id = ${id}
            LIMIT 1`;
        return rows[0] ? toProduct(rows[0]) : null;
    }
    async getMany(tenantId, ids) {
        if (!ids.length)
            return [];
        const rows = await prisma_client_1.default.$queryRaw `${PRODUCT_SELECT}
            WHERE p.tenantId = ${tenantId} AND p.id IN (${client_1.Prisma.join(ids)})`;
        return rows.map(toProduct);
    }
    async findConflicts(tenantId, codes, excludeId) {
        const own = codes.ownBarcode ? (0, warehouseCodes_1.codeVariants)(codes.ownBarcode) : [];
        const makers = codes.makerBarcodes.map((code) => ({ code, variants: (0, warehouseCodes_1.codeVariants)(code) }));
        const probes = [...new Set([...own, ...makers.flatMap((maker) => maker.variants)])];
        const or = [];
        if (codes.erpCode)
            or.push({ erpCode: codes.erpCode });
        // Unser Barcode zeigt auf GENAU eine Karte, ebenso jeder Herstellerbarcode
        // (dritter Durchgang: «o üretici barkodundan sadece 1 tane ürün olabilir»)
        // — gleich, ob er ohne Lieferant oder bei einem Lieferanten steht.
        if (probes.length)
            or.push({ barcode: { in: probes } }, { manufacturerBarcode: { in: probes } });
        if (!or.length)
            return [];
        const [rows, supplierHits] = await Promise.all([
            prisma_client_1.default.warehouseProduct.findMany({
                where: { tenantId, ...(excludeId ? { id: { not: excludeId } } : {}), OR: or },
                select: { id: true, name: true, erpCode: true, barcode: true, manufacturerBarcode: true },
                take: 10,
            }),
            probes.length
                ? prisma_client_1.default.$queryRaw `
                    SELECT s.productId, p.name, s.barcode
                      FROM depo_urun_tedarikcileri s
                      JOIN depo_urun_kartlari p ON p.id = s.productId
                     WHERE s.tenantId = ${tenantId} AND s.barcode IN (${client_1.Prisma.join(probes)})
                       ${excludeId ? client_1.Prisma.sql `AND s.productId <> ${excludeId}` : client_1.Prisma.empty}
                     LIMIT 10`
                : Promise.resolve([]),
        ]);
        const hits = (value, variants) => Boolean(value) && variants.some((variant) => sameCode(variant, value));
        const conflicts = [];
        for (const row of rows) {
            if (codes.erpCode && sameCode(row.erpCode, codes.erpCode)) {
                conflicts.push({ productId: row.id, productName: row.name, field: 'erpCode', code: codes.erpCode });
            }
            if (codes.ownBarcode && (hits(row.barcode, own) || hits(row.manufacturerBarcode, own))) {
                conflicts.push({ productId: row.id, productName: row.name, field: 'barcode', code: codes.ownBarcode });
            }
            for (const maker of makers) {
                if (hits(row.barcode, maker.variants)) {
                    conflicts.push({ productId: row.id, productName: row.name, field: 'barcode', code: maker.code });
                }
                if (hits(row.manufacturerBarcode, maker.variants)) {
                    conflicts.push({ productId: row.id, productName: row.name, field: 'manufacturerBarcode', code: maker.code });
                }
            }
        }
        for (const hit of supplierHits) {
            if (codes.ownBarcode && hits(hit.barcode, own)) {
                conflicts.push({ productId: hit.productId, productName: hit.name, field: 'barcode', code: codes.ownBarcode });
            }
            for (const maker of makers) {
                if (hits(hit.barcode, maker.variants)) {
                    conflicts.push({ productId: hit.productId, productName: hit.name, field: 'manufacturerBarcode', code: maker.code });
                }
            }
        }
        return conflicts;
    }
    async create(tenantId, fields, serials, userId, options) {
        const id = (0, exports.newId)();
        const quantity = fields.serialRequired ? serials.length : fields.quantity;
        const base = {
            id,
            tenantId,
            ...(0, exports.productData)(fields),
            quantity,
            createdById: userId,
            updatedById: userId,
        };
        const serialRows = serials.map((draft) => serialData(tenantId, id, draft, userId));
        const suppliers = (0, exports.supplierRows)(tenantId, id, fields.suppliers);
        if (options.issueCode && fields.materialGroupId) {
            const groupId = fields.materialGroupId;
            await prisma_client_1.default.$transaction(async (tx) => {
                const [erpCode] = await (0, WarehouseCodeIssuer_1.reserveErpCodes)(tx, tenantId, groupId, 1);
                const [barcode] = fields.barcode ? [fields.barcode] : await (0, WarehouseCodeIssuer_1.reserveBarcodes)(tx, tenantId, 1);
                await tx.warehouseProduct.create({ data: { ...base, erpCode: erpCode ?? null, barcode: barcode ?? null } });
                if (suppliers.length)
                    await tx.warehouseProductSupplier.createMany({ data: suppliers });
                if (serialRows.length)
                    await tx.warehouseSerialNumber.createMany({ data: serialRows });
            }, WarehouseCodeIssuer_1.CARD_TX_OPTIONS);
        }
        else {
            await prisma_client_1.default.$transaction([
                prisma_client_1.default.warehouseProduct.create({ data: base }),
                ...(suppliers.length ? [prisma_client_1.default.warehouseProductSupplier.createMany({ data: suppliers })] : []),
                ...(serialRows.length ? [prisma_client_1.default.warehouseSerialNumber.createMany({ data: serialRows })] : []),
            ]);
        }
        const created = await this.get(tenantId, id);
        if (!created)
            throw new Error('Depo: neue Karte nicht lesbar.');
        return created;
    }
    async update(tenantId, id, fields, userId, code, options = {}) {
        const suppliers = options.writeSuppliers ? (0, exports.supplierRows)(tenantId, id, fields.suppliers) : null;
        // Nummern, die mit dem Speichern dazukommen, nur bei Pflicht (sonst zählte sie niemand).
        const serialRows = fields.serialRequired
            ? (options.serials ?? []).map((draft) => serialData(tenantId, id, draft, userId))
            : [];
        const data = (erpCode, barcode) => ({
            ...(0, exports.productData)(fields),
            erpCode,
            barcode,
            // Bei Pflicht zählt `recount` die Menge; eine mitgeschickte Zahl gilt dann nicht.
            ...(fields.serialRequired ? {} : { quantity: fields.quantity }),
            updatedById: userId,
        });
        let changed = 0;
        if (code === 'issue' && fields.materialGroupId) {
            const groupId = fields.materialGroupId;
            changed = await prisma_client_1.default.$transaction(async (tx) => {
                const exists = await tx.warehouseProduct.count({ where: { id, tenantId } });
                if (!exists)
                    return 0;
                const [erpCode] = await (0, WarehouseCodeIssuer_1.reserveErpCodes)(tx, tenantId, groupId, 1);
                const [barcode] = fields.barcode ? [fields.barcode] : await (0, WarehouseCodeIssuer_1.reserveBarcodes)(tx, tenantId, 1);
                const result = await tx.warehouseProduct.updateMany({
                    where: { id, tenantId },
                    data: data(erpCode ?? null, barcode ?? null),
                });
                if (suppliers) {
                    await tx.warehouseProductSupplier.deleteMany({ where: { productId: id, tenantId } });
                    if (suppliers.length)
                        await tx.warehouseProductSupplier.createMany({ data: suppliers });
                }
                if (result.count && serialRows.length)
                    await tx.warehouseSerialNumber.createMany({ data: serialRows });
                await recount(tx, tenantId, id);
                return result.count;
            }, WarehouseCodeIssuer_1.CARD_TX_OPTIONS);
        }
        else if (serialRows.length) {
            // Mit neuen Seriennummern: erst prüfen, ob die Karte noch da ist —
            // eine gelöschte Karte bekommt keine verwaisten Nummern.
            changed = await prisma_client_1.default.$transaction(async (tx) => {
                const result = await tx.warehouseProduct.updateMany({
                    where: { id, tenantId },
                    data: data(code === 'clear' ? null : fields.erpCode, fields.barcode),
                });
                if (!result.count)
                    return 0;
                if (suppliers) {
                    await tx.warehouseProductSupplier.deleteMany({ where: { productId: id, tenantId } });
                    if (suppliers.length)
                        await tx.warehouseProductSupplier.createMany({ data: suppliers });
                }
                await tx.warehouseSerialNumber.createMany({ data: serialRows });
                await recount(tx, tenantId, id);
                return result.count;
            }, WarehouseCodeIssuer_1.CARD_TX_OPTIONS);
        }
        else {
            const [result] = await prisma_client_1.default.$transaction([
                prisma_client_1.default.warehouseProduct.updateMany({
                    where: { id, tenantId },
                    data: data(code === 'clear' ? null : fields.erpCode, fields.barcode),
                }),
                ...(suppliers
                    ? [
                        prisma_client_1.default.warehouseProductSupplier.deleteMany({ where: { productId: id, tenantId } }),
                        ...(suppliers.length ? [prisma_client_1.default.warehouseProductSupplier.createMany({ data: suppliers })] : []),
                    ]
                    : []),
                recount(prisma_client_1.default, tenantId, id),
            ]);
            changed = result.count;
        }
        if (!changed)
            return null;
        return this.get(tenantId, id);
    }
    async delete(tenantId, id) {
        // Die Seriennummern gehen über den Fremdschlüssel mit (ON DELETE CASCADE).
        const result = await prisma_client_1.default.warehouseProduct.deleteMany({ where: { id, tenantId } });
        return result.count > 0;
    }
    async adjustQuantity(tenantId, id, delta, userId) {
        const result = await prisma_client_1.default.warehouseProduct.updateMany({
            where: { id, tenantId, serialRequired: false, ...(delta < 0 ? { quantity: { gte: -delta } } : {}) },
            data: { quantity: { increment: delta }, updatedById: userId },
        });
        if (result.count)
            return 'ok';
        if (delta >= 0)
            return 'missing';
        const exists = await prisma_client_1.default.warehouseProduct.count({ where: { id, tenantId, serialRequired: false } });
        return exists ? 'below-zero' : 'missing';
    }
    async assignMissingCodes(tenantId, groupId) {
        return prisma_client_1.default.$transaction(async (tx) => {
            // Zuerst die Gruppe sperren (wie jedes Anlegen/Ändern mit Code) — so
            // warten gleichzeitige Vorgänge aufeinander, statt sich zu verklemmen.
            await tx.$queryRaw `SELECT id FROM depo_malzeme_gruplari WHERE id = ${groupId} AND tenantId = ${tenantId} FOR UPDATE`;
            // In der Reihenfolge des Anlegens («baştan sırayla»), gesperrt bis zum Ende.
            const rows = await tx.$queryRaw `
                SELECT id, barcode FROM depo_urun_kartlari
                 WHERE tenantId = ${tenantId} AND materialGroupId = ${groupId} AND erpCode IS NULL
                 ORDER BY createdAt ASC, id ASC
                 LIMIT 5000
                 FOR UPDATE`;
            if (!rows.length)
                return 0;
            const codes = await (0, WarehouseCodeIssuer_1.reserveErpCodes)(tx, tenantId, groupId, rows.length);
            const needBarcode = rows.filter((row) => !row.barcode);
            const barcodes = await (0, WarehouseCodeIssuer_1.reserveBarcodes)(tx, tenantId, needBarcode.length);
            const barcodeOf = new Map(needBarcode.map((row, index) => [row.id, barcodes[index] ?? null]));
            const chunk = 400;
            for (let index = 0; index < rows.length; index += chunk) {
                const slice = rows.slice(index, index + chunk);
                const codeCases = client_1.Prisma.join(slice.map((row, offset) => client_1.Prisma.sql `WHEN ${row.id} THEN ${codes[index + offset] ?? null}`), ' ');
                const barcodeCases = client_1.Prisma.join(slice.map((row) => client_1.Prisma.sql `WHEN ${row.id} THEN ${barcodeOf.get(row.id) ?? null}`), ' ');
                await tx.$executeRaw `
                    UPDATE depo_urun_kartlari
                       SET erpCode = CASE id ${codeCases} END,
                           barcode = COALESCE(barcode, CASE id ${barcodeCases} END),
                           updatedAt = ${sqlNow()}
                     WHERE tenantId = ${tenantId} AND id IN (${client_1.Prisma.join(slice.map((row) => row.id))})`;
            }
            return rows.length;
        }, WarehouseCodeIssuer_1.CODE_TX_OPTIONS);
    }
    async listSerials(tenantId, productId) {
        const rows = await prisma_client_1.default.warehouseSerialNumber.findMany({
            where: { tenantId, productId },
            orderBy: [{ createdAt: 'asc' }, { serialNumber: 'asc' }],
        });
        return rows.map(toSerial);
    }
    async getSerial(tenantId, id) {
        const row = await prisma_client_1.default.warehouseSerialNumber.findFirst({ where: { id, tenantId } });
        return row ? toSerial(row) : null;
    }
    async existingSerials(tenantId, productId, serialNumbers, excludeId) {
        if (!serialNumbers.length)
            return [];
        const rows = await prisma_client_1.default.warehouseSerialNumber.findMany({
            where: {
                tenantId,
                productId,
                serialNumber: { in: serialNumbers },
                ...(excludeId ? { id: { not: excludeId } } : {}),
            },
            select: { serialNumber: true },
        });
        return rows.map((row) => row.serialNumber);
    }
    async addSerial(tenantId, productId, draft, userId) {
        const [created] = await prisma_client_1.default.$transaction([
            prisma_client_1.default.warehouseSerialNumber.create({ data: serialData(tenantId, productId, draft, userId) }),
            recount(prisma_client_1.default, tenantId, productId),
        ]);
        return toSerial(created);
    }
    async updateSerial(tenantId, id, patch) {
        const data = {
            ...(patch.serialNumber !== undefined ? { serialNumber: patch.serialNumber } : {}),
            ...(patch.target ? {
                productionProjectId: patch.target.productionProjectId,
                productionItemId: patch.target.productionItemId,
                projectNumber: patch.target.projectNumber,
                projectName: patch.target.projectName,
                deviceName: patch.target.deviceName,
            } : {}),
        };
        if (Object.keys(data).length) {
            const result = await prisma_client_1.default.warehouseSerialNumber.updateMany({ where: { id, tenantId }, data });
            if (!result.count)
                return null;
        }
        return this.getSerial(tenantId, id);
    }
    async deleteSerial(tenantId, id) {
        const serial = await this.getSerial(tenantId, id);
        if (!serial)
            return null;
        const [removed] = await prisma_client_1.default.$transaction([
            prisma_client_1.default.warehouseSerialNumber.deleteMany({ where: { id, tenantId } }),
            recount(prisma_client_1.default, tenantId, serial.productId),
        ]);
        return removed.count ? serial : null;
    }
    async findByCode(tenantId, codes, limit) {
        if (!codes.length)
            return [];
        const list = client_1.Prisma.join(codes);
        const rows = await prisma_client_1.default.$queryRaw `${PRODUCT_SELECT}
            WHERE p.tenantId = ${tenantId}
              AND (p.barcode IN (${list}) OR p.manufacturerBarcode IN (${list}) OR p.erpCode IN (${list})
                   OR p.id IN (SELECT t.productId FROM depo_urun_tedarikcileri t
                                WHERE t.tenantId = ${tenantId} AND t.barcode IN (${list})))
            ORDER BY p.name ASC
            LIMIT ${limit}`;
        return rows.map(toProduct);
    }
    async findSerialsByNumber(tenantId, serialNumber, limit) {
        const rows = await prisma_client_1.default.warehouseSerialNumber.findMany({
            where: { tenantId, serialNumber },
            orderBy: { createdAt: 'asc' },
            take: limit,
        });
        return rows.map(toSerial);
    }
    async serialCounts(tenantId, productIds) {
        if (!productIds.length)
            return new Map();
        const rows = await prisma_client_1.default.warehouseSerialNumber.groupBy({
            by: ['productId'],
            where: { tenantId, productId: { in: productIds } },
            _count: { _all: true },
        });
        return new Map(rows.map((row) => [row.productId, row._count._all]));
    }
    async existingNames(tenantId, names) {
        const unique = [...new Set(names.filter(Boolean))];
        const found = new Set();
        for (let index = 0; index < unique.length; index += 500) {
            const slice = unique.slice(index, index + 500);
            const rows = await prisma_client_1.default.warehouseProduct.findMany({
                where: { tenantId, name: { in: slice } },
                select: { name: true },
                distinct: ['name'],
            });
            for (const row of rows)
                found.add(row.name.trim().toLocaleLowerCase('tr-TR'));
        }
        return found;
    }
    async manufacturerBarcodeOwners(tenantId, codes) {
        const probes = [...new Set(codes.filter(Boolean).flatMap(warehouseCodes_1.codeVariants))];
        const found = new Map();
        for (let index = 0; index < probes.length; index += 500) {
            const slice = probes.slice(index, index + 500);
            // Ohne Lieferant auf der Karte ODER bei einem ihrer Lieferanten.
            const [rows, supplierRows] = await Promise.all([
                prisma_client_1.default.warehouseProduct.findMany({
                    where: { tenantId, manufacturerBarcode: { in: slice } },
                    select: { manufacturerBarcode: true, name: true },
                }),
                prisma_client_1.default.$queryRaw `
                    SELECT s.barcode, p.name
                      FROM depo_urun_tedarikcileri s
                      JOIN depo_urun_kartlari p ON p.id = s.productId
                     WHERE s.tenantId = ${tenantId} AND s.barcode IN (${client_1.Prisma.join(slice)})`,
            ]);
            const owners = [
                ...rows.map((row) => ({ code: row.manufacturerBarcode, name: row.name })),
                ...supplierRows.map((row) => ({ code: row.barcode, name: row.name })),
            ];
            for (const owner of owners) {
                if (!owner.code)
                    continue;
                for (const variant of (0, warehouseCodes_1.codeVariants)(owner.code))
                    found.set(variant.toLocaleLowerCase('de-CH'), owner.name);
            }
        }
        return found;
    }
    async ownBarcodes(tenantId, codes) {
        const probes = [...new Set(codes.filter(Boolean).flatMap(warehouseCodes_1.codeVariants))];
        const found = new Map();
        for (let index = 0; index < probes.length; index += 500) {
            const slice = probes.slice(index, index + 500);
            const rows = await prisma_client_1.default.warehouseProduct.findMany({
                where: { tenantId, barcode: { in: slice } },
                select: { barcode: true, name: true },
            });
            for (const row of rows) {
                if (!row.barcode)
                    continue;
                for (const variant of (0, warehouseCodes_1.codeVariants)(row.barcode))
                    found.set(variant.toLocaleLowerCase('de-CH'), row.name);
            }
        }
        return found;
    }
}
exports.PrismaWarehouseProductRepository = PrismaWarehouseProductRepository;
/**
 * Was das Depo von anderen Modulen NUR LIEST: die Lieferantenliste der Firma
 * (Supplier), die Produktionsprojekte samt Geräten (uretim_*) und die Namen
 * von Personen. Geschrieben wird dort nie.
 */
class PrismaWarehouseDirectory {
    async searchSuppliers(tenantId, query, limit) {
        const [suppliers, written] = await Promise.all([
            prisma_client_1.default.supplier.findMany({
                where: { tenantId, isActive: true, ...(query ? { companyName: { contains: query } } : {}) },
                select: { id: true, companyName: true },
                orderBy: { companyName: 'asc' },
                take: limit,
            }),
            prisma_client_1.default.warehouseProduct.findMany({
                where: {
                    tenantId,
                    supplierId: null,
                    supplierName: query ? { contains: query } : { not: null },
                },
                select: { supplierName: true },
                distinct: ['supplierName'],
                orderBy: { supplierName: 'asc' },
                take: limit,
            }),
        ]);
        const options = suppliers.map((row) => ({ id: row.id, name: row.companyName }));
        for (const row of written) {
            const name = row.supplierName?.trim();
            if (!name || options.some((option) => sameCode(option.name, name)))
                continue;
            options.push({ id: null, name });
        }
        return options.slice(0, limit);
    }
    async getSupplier(tenantId, id) {
        const row = await prisma_client_1.default.supplier.findFirst({ where: { id, tenantId }, select: { id: true, companyName: true } });
        return row ? { id: row.id, name: row.companyName } : null;
    }
    async suppliersByIds(tenantId, ids) {
        const unique = [...new Set(ids.filter(Boolean))];
        if (!unique.length)
            return new Map();
        const rows = await prisma_client_1.default.supplier.findMany({
            where: { tenantId, id: { in: unique } },
            select: { id: true, companyName: true },
        });
        return new Map(rows.map((row) => [row.id, { id: row.id, name: row.companyName }]));
    }
    async suppliersByName(tenantId, names) {
        const unique = [...new Set(names.filter(Boolean))];
        const found = new Map();
        for (let index = 0; index < unique.length; index += 500) {
            const rows = await prisma_client_1.default.supplier.findMany({
                where: { tenantId, isActive: true, companyName: { in: unique.slice(index, index + 500) } },
                select: { id: true, companyName: true },
            });
            for (const row of rows) {
                const key = row.companyName.trim().toLocaleLowerCase('tr-TR');
                if (!found.has(key))
                    found.set(key, { id: row.id, name: row.companyName });
            }
        }
        return found;
    }
    async listProjects(tenantId, search, limit) {
        const pattern = search ? likePattern(search) : null;
        const rows = await prisma_client_1.default.$queryRaw `
            SELECT p.id, p.projectNumber, p.projectName, p.customerName, p.isActive,
                   (SELECT COUNT(*) FROM uretim_proje_kalemleri i
                     WHERE i.productionProjectId = p.id AND i.isActive = 1 AND i.kind = 'DEVICE') AS deviceCount
              FROM uretim_projeler p
             WHERE p.tenantId = ${tenantId} AND p.isActive = 1
               ${pattern ? client_1.Prisma.sql `AND (p.projectNumber LIKE ${pattern} OR p.projectName LIKE ${pattern} OR p.customerName LIKE ${pattern})` : client_1.Prisma.empty}
             ORDER BY p.projectNumber DESC, p.projectName ASC
             LIMIT ${limit}`;
        return rows.map((row) => ({
            id: row.id,
            projectNumber: String(row.projectNumber ?? ''),
            projectName: String(row.projectName ?? ''),
            customerName: row.customerName ?? null,
            deviceCount: (0, exports.num)(row.deviceCount),
            isActive: Boolean(Number(row.isActive)),
        }));
    }
    async getProject(tenantId, id) {
        const row = await prisma_client_1.default.productionProject.findFirst({
            where: { id, tenantId },
            select: { id: true, projectNumber: true, projectName: true, customerName: true, isActive: true },
        });
        return row ? { ...row, customerName: row.customerName ?? null, deviceCount: 0 } : null;
    }
    async listDevices(tenantId, projectId) {
        const rows = await prisma_client_1.default.productionProjectItem.findMany({
            where: { tenantId, productionProjectId: projectId, isActive: true, kind: 'DEVICE' },
            select: { id: true, productionProjectId: true, name: true, positionNumber: true, articleCode: true, isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { positionNumber: 'asc' }, { name: 'asc' }],
        });
        return rows.map((row) => ({
            ...row,
            positionNumber: row.positionNumber ?? null,
            articleCode: row.articleCode ?? null,
        }));
    }
    async getDevice(tenantId, id) {
        const row = await prisma_client_1.default.productionProjectItem.findFirst({
            where: { id, tenantId },
            select: { id: true, productionProjectId: true, name: true, positionNumber: true, articleCode: true, isActive: true },
        });
        return row ? { ...row, positionNumber: row.positionNumber ?? null, articleCode: row.articleCode ?? null } : null;
    }
    async names(tenantId, projectIds, itemIds) {
        const [projects, devices] = await Promise.all([
            projectIds.length
                ? prisma_client_1.default.productionProject.findMany({
                    where: { tenantId, id: { in: projectIds } },
                    select: { id: true, projectNumber: true, projectName: true, customerName: true, isActive: true },
                })
                : Promise.resolve([]),
            itemIds.length
                ? prisma_client_1.default.productionProjectItem.findMany({
                    where: { tenantId, id: { in: itemIds } },
                    select: { id: true, productionProjectId: true, name: true, positionNumber: true, articleCode: true, isActive: true },
                })
                : Promise.resolve([]),
        ]);
        return {
            projects: new Map(projects.map((row) => [row.id, { ...row, customerName: row.customerName ?? null, deviceCount: 0 }])),
            devices: new Map(devices.map((row) => [row.id, {
                    ...row,
                    positionNumber: row.positionNumber ?? null,
                    articleCode: row.articleCode ?? null,
                }])),
        };
    }
    async personName(id) {
        const row = await prisma_client_1.default.employee.findUnique({ where: { id }, select: { firstName: true, lastName: true } });
        const name = row ? `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim() : '';
        return name || null;
    }
}
exports.PrismaWarehouseDirectory = PrismaWarehouseDirectory;
//# sourceMappingURL=WarehouseRepository.js.map