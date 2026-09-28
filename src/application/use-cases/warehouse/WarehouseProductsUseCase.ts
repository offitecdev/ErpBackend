import type {
    IWarehouseDirectory,
    IWarehouseGroupRepository,
    IWarehouseProductRepository,
    WarehouseCodeAction,
} from '../../../domain/repositories/IWarehouseRepository';
import type {
    WarehouseMaterialGroup,
    WarehouseProduct,
    WarehouseProductFields,
    WarehouseProductFilter,
    WarehouseSerialDraft,
} from '../../../domain/entities/Warehouse';
import {
    assertSuppliersUnique,
    cleanCode,
    fieldsOfProduct,
    firstDuplicate,
    makerBarcodesOf,
    parseQuantity,
    productFieldsFromInput,
    serialFromInput,
    warehouseError,
    WAREHOUSE_LIMITS,
} from '../../../domain/services/warehouse';
import { codeVariants } from '../../../domain/services/warehouseCodes';
import { emitWarehouseStockChanged } from '../../../shared/warehouseStockEvents';
import {
    isGoodsInUndoInvalid,
    warehouseGoodsInHandler,
    type WarehouseGoodsInResult,
    type WarehouseGoodsInSupplier,
} from '../../../shared/warehouseGoodsIn';
import {
    productDto,
    serialDto,
    targetIdsOf,
    type WarehouseLookupDto,
    type WarehouseLookupMatchDto,
    type WarehouseProductDetailDto,
    type WarehouseProductDto,
} from './warehouseReadModel';
import { WarehouseTargetResolver } from './warehouseTargets';

/** Höchstens so viele Seriennummern kommen mit einem Speichern der Karte. */
const MAX_SERIALS_ON_CREATE = 500;
/** Höchstens so viele Karten gehen in einen Export (PDF / Excel). */
export const WAREHOUSE_EXPORT_LIMIT = 5000;
/** Eine Buchung aus «Ürün ekle» (auch zurück): höchstens so viele Stück. */
const MAX_ADJUST = 100_000;

/** Eine verletzte Eindeutigkeit der Datenbank (Prisma P2002) auf eine Spalte. */
export const isUniqueViolation = (error: unknown, column: string): boolean => {
    const e = error as { code?: string; meta?: unknown; message?: string } | null;
    if (e?.code !== 'P2002') return false;
    const where = `${JSON.stringify(e.meta ?? {})} ${e.message ?? ''}`;
    return where.includes(column) || !/_key|target|fields/.test(where);
};

const sameCode = (a: string | null, code: string): boolean =>
    Boolean(a) && codeVariants(code).some((variant) => variant.toLocaleLowerCase('de-CH') === a!.toLocaleLowerCase('de-CH'));

/** Ein Code in allen Schreibweisen, die als derselbe gelten (UPC-A = EAN-13 mit 0). */
const codeKeys = (code: string): string[] => codeVariants(code).map((variant) => variant.toLocaleLowerCase('de-CH'));

/* ── «Ürün ekle» = Wareneingang (28.09.2026) ───────────────────────────── */

/**
 * Der Lieferant, den ein gelesener Code nennt: der Barcode GENAU eines
 * Lieferanten der Karte (vierter Durchgang). Unser Barcode, der ERP-Code, ein
 * Herstellerbarcode ohne Lieferant — oder derselbe Barcode bei zwei
 * Lieferanten — nennen keinen.
 */
export const supplierOfCode = (product: WarehouseProduct, rawCode: unknown): WarehouseGoodsInSupplier | null => {
    const code = typeof rawCode === 'string' ? rawCode.trim().slice(0, WAREHOUSE_LIMITS.barcode) : '';
    if (!code) return null;
    const hits = product.suppliers.filter((entry) => sameCode(entry.barcode, code));
    return hits.length === 1 && hits[0] ? { supplierId: hits[0].supplierId, name: hits[0].name } : null;
};

/** Die Buchungen, die eine Rücknahme nennt — zusammen nie mehr, als zurückgeht. */
const undoEntriesFrom = (raw: unknown, amount: number): Array<{ receiptId: string; quantity: number; serials: string[] }> => {
    const entries: Array<{ receiptId: string; quantity: number; serials: string[] }> = [];
    let left = amount;
    for (const value of Array.isArray(raw) ? raw.slice(0, 50) : []) {
        const entry = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
        const receiptId = typeof entry.receiptId === 'string' ? entry.receiptId.trim().slice(0, 32) : '';
        const quantity = Math.min(left, Math.round((Number(entry.quantity) || 0) * 1000) / 1000);
        if (!receiptId || !(quantity > 0)) continue;
        entries.push({ receiptId, quantity, serials: [] });
        left = Math.round((left - quantity) * 1000) / 1000;
    }
    return entries;
};

/** Gutschreiben ist Beiwerk: die Stücke sind im Depo — ein Fehler dort bricht die Buchung nie ab. */
export const bookGoodsIn = async (work: () => Promise<WarehouseGoodsInResult | null>): Promise<WarehouseGoodsInResult | null> => {
    try {
        return await work();
    } catch (error) {
        console.warn('[warehouse] goods-in booking failed', (error as Error)?.message);
        return null;
    }
};

/** Eine Rücknahme, die nicht zur Buchung passt, wird ein Fehler des Depos (409). */
export const undoGoodsIn = async (work: () => Promise<void>): Promise<void> => {
    try {
        await work();
    } catch (error) {
        if (isGoodsInUndoInvalid(error)) {
            throw warehouseError('RECEIPT_UNDO_INVALID', (error as Error).message || 'Diese Buchung lässt sich nicht zurücknehmen.', { status: 409 });
        }
        throw error;
    }
};

/**
 * ── DIE PRODUKTKARTEN (26.09.2026) ──────────────────────────────────────────
 *
 * Liste, Karte, Anlegen, Ändern, Löschen, «Ürün ekle» (Bestand ±n), der Scan
 * und der Export. Pflicht ist nur der Name. Karten mit Seriennummernpflicht
 * führen ihre Menge nicht selbst: sie ist die Zahl ihrer Seriennummern.
 *
 * ERP-CODE (zweiter Durchgang): «Malzeme grubuna göre ERP kodu oluşturulması
 * gerekiyor» — eine Karte mit Gruppe bekommt ihren Code beim Speichern:
 *   · neue Karte mit Gruppe          → Code + Barcode
 *   · Gruppe gewechselt              → neuer Code (der Barcode bleibt der Karte)
 *   · Gruppe entfernt                → kein Code mehr (Barcode bleibt)
 *   · Gruppe ohne Code, Altbestand   → Code wird beim nächsten Speichern nachgeholt
 * Getippte Werte für ERP-Code und unseren Barcode gibt es nicht mehr.
 */
export class WarehouseProductsUseCase {
    private targets: WarehouseTargetResolver;

    constructor(
        private products: IWarehouseProductRepository,
        private groups: IWarehouseGroupRepository,
        private directory: IWarehouseDirectory,
    ) {
        this.targets = new WarehouseTargetResolver(directory);
    }

    async list(tenantId: string, filter: WarehouseProductFilter) {
        const page = await this.products.list(tenantId, filter);
        return {
            items: page.items.map((product) => productDto(product, { preview: true })),
            total: page.total,
            page: filter.page,
            pageSize: filter.pageSize,
        };
    }

    /**
     * Alle Karten der Abfrage (Suche, Gruppen, Barcode) für PDF und Excel —
     * «malzeme gruplarına göre toplu indirebilelim». Höchstens 5000.
     */
    async export(tenantId: string, filter: Omit<WarehouseProductFilter, 'page' | 'pageSize'>) {
        const page = await this.products.list(tenantId, { ...filter, page: 1, pageSize: WAREHOUSE_EXPORT_LIMIT });
        return {
            items: page.items.map((product) => productDto(product)),
            total: page.total,
            truncated: page.total > page.items.length,
        };
    }

    async get(tenantId: string, id: string): Promise<WarehouseProductDetailDto> {
        const product = await this.products.get(tenantId, id);
        if (!product) throw warehouseError('NOT_FOUND', 'Produktkarte nicht gefunden.', { status: 404 });
        return this.detail(tenantId, product);
    }

    async create(tenantId: string, userId: string, body: unknown): Promise<WarehouseProductDetailDto> {
        const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const fields = productFieldsFromInput(input);
        const group = await this.resolveReferences(tenantId, fields, null, true);
        if (group && !group.code) throw this.codeMissing(group);
        const serials = fields.serialRequired ? await this.serialDrafts(tenantId, input.serials) : [];
        await this.assertCodesFree(tenantId, { ownBarcode: fields.barcode, makerBarcodes: makerBarcodesOf(fields) });

        try {
            const product = await this.products.create(tenantId, fields, serials, userId, { issueCode: Boolean(group) });
            // Neue Seriennummern: die BOM der Produktion reserviert sie (27.09.2026).
            if (serials.length) emitWarehouseStockChanged({ tenantId, productIds: [product.id] });
            return this.detail(tenantId, product);
        } catch (error) {
            throw this.mapUnique(error, fields);
        }
    }

    async update(tenantId: string, userId: string, id: string, body: unknown): Promise<WarehouseProductDetailDto> {
        const current = await this.products.get(tenantId, id);
        if (!current) throw warehouseError('NOT_FOUND', 'Produktkarte nicht gefunden.', { status: 404 });

        const fields = productFieldsFromInput(body, fieldsOfProduct(current));
        const suppliersChanged = JSON.stringify(fields.suppliers) !== JSON.stringify(current.suppliers);
        const group = await this.resolveReferences(tenantId, fields, current, suppliersChanged);
        // Dritter Durchgang: das Häkchen «Seri numarası gereklidir» eben gesetzt
        // und gleich Nummern gelesen — sie kommen mit diesem Speichern.
        const serials = fields.serialRequired
            ? await this.serialDrafts(tenantId, (body as { serials?: unknown } | null)?.serials)
            : [];
        if (serials.length) {
            const taken = await this.products.existingSerials(tenantId, id, serials.map((draft) => draft.serialNumber));
            if (taken.length) {
                throw warehouseError('SERIAL_TAKEN', 'Diese Seriennummer ist an der Karte schon erfasst.', {
                    status: 409,
                    params: { serial: taken[0] ?? '' },
                });
            }
        }

        let action: WarehouseCodeAction = 'keep';
        if (fields.materialGroupId !== current.materialGroupId) {
            if (!fields.materialGroupId) action = 'clear';
            else if (!group?.code) throw this.codeMissing(group);
            else action = 'issue';
        } else if (fields.materialGroupId && !current.erpCode) {
            // Altbestand ohne Code: nachholen, sobald die Gruppe ein Kürzel hat.
            const own = await this.groups.getGroup(tenantId, fields.materialGroupId);
            if (own?.code) action = 'issue';
        }

        // Nur Herstellerbarcodes, die die Karte noch nicht trug (ohne Lieferant
        // oder bei einem Lieferanten) — einer, der nur den Platz wechselt, ist frei.
        const before = new Set(makerBarcodesOf(current).flatMap(codeKeys));
        const added = makerBarcodesOf(fields).filter((code) => !codeKeys(code).some((key) => before.has(key)));
        if (added.length) await this.assertCodesFree(tenantId, { ownBarcode: null, makerBarcodes: added }, id);

        try {
            const updated = await this.products.update(tenantId, id, fields, userId, action, { writeSuppliers: suppliersChanged, serials });
            if (!updated) throw warehouseError('NOT_FOUND', 'Produktkarte nicht gefunden.', { status: 404 });
            if (serials.length) emitWarehouseStockChanged({ tenantId, productIds: [id] });
            return this.detail(tenantId, updated);
        } catch (error) {
            throw this.mapUnique(error, fields);
        }
    }

    async delete(tenantId: string, id: string): Promise<{ ok: true }> {
        const removed = await this.products.delete(tenantId, id);
        if (!removed) throw warehouseError('NOT_FOUND', 'Produktkarte nicht gefunden.', { status: 404 });
        return { ok: true };
    }

    /**
     * «Ürün ekle» für Karten OHNE Seriennummernpflicht: jeder Scan bucht sofort
     * ein (Vorgabe 1). Eine negative Zahl nimmt einen Scan zurück — nie unter 0.
     * Eine Karte mit Pflicht bekommt ihre Stücke über die Seriennummern.
     *
     * `goodsIn: true` (28.09.2026, das Fenster «Ürün ekle»): die Stücke sind
     * der Wareneingang der Bestellungen, die auf die Karte warten — die BOM
     * schreibt sie gut und meldet, wohin sie gingen (`goodsIn` der Antwort).
     * `code` = der gelesene Barcode: nennt er einen Lieferanten, zählt nur
     * dessen Bestellung. Eine Rücknahme nennt in `undo` die Buchungen, die sie
     * zurücknimmt.
     */
    async receive(
        tenantId: string,
        userId: string,
        id: string,
        body: unknown,
    ): Promise<WarehouseProductDto & { goodsIn: WarehouseGoodsInResult | null }> {
        const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const raw = input.quantity;
        const numeric = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim().replace(',', '.'));
        const negative = raw !== undefined && raw !== null && raw !== '' && Number.isFinite(numeric) && numeric < 0;
        const amount = raw === undefined || raw === null || raw === '' ? 1 : parseQuantity(negative ? Math.abs(numeric) : raw);
        if (!(amount > 0) || amount > MAX_ADJUST) throw warehouseError('RECEIVE_INVALID', 'Die Menge muss grösser als 0 sein.');
        const delta = negative ? -amount : amount;

        const product = await this.products.get(tenantId, id);
        if (!product) throw warehouseError('NOT_FOUND', 'Produktkarte nicht gefunden.', { status: 404 });
        if (product.serialRequired) {
            throw warehouseError('QUANTITY_SERIAL_MANAGED', 'Diese Karte zählt ihre Stücke über Seriennummern.', { status: 409 });
        }
        const adjust = async () => {
            const outcome = await this.products.adjustQuantity(tenantId, id, delta, userId);
            if (outcome === 'missing') throw warehouseError('NOT_FOUND', 'Produktkarte nicht gefunden.', { status: 404 });
            if (outcome === 'below-zero') {
                throw warehouseError('QUANTITY_BELOW_ZERO', 'Der Bestand kann nicht unter 0 fallen.', { status: 409 });
            }
        };

        const handler = input.goodsIn === true ? warehouseGoodsInHandler() : null;
        let goodsIn: WarehouseGoodsInResult | null = null;
        const undo = negative && handler ? undoEntriesFrom(input.undo, amount) : [];
        if (handler && undo.length) {
            await undoGoodsIn(() => handler.undo({ tenantId, userId, productId: id, entries: undo }, adjust));
        } else {
            await adjust();
            if (handler && !negative) {
                goodsIn = await bookGoodsIn(() => handler.book({
                    tenantId,
                    userId,
                    productId: id,
                    quantity: amount,
                    serials: [],
                    supplier: supplierOfCode(product, input.code),
                }));
            }
        }
        const updated = await this.products.get(tenantId, id);
        if (!updated) throw warehouseError('NOT_FOUND', 'Produktkarte nicht gefunden.', { status: 404 });
        return { ...productDto(updated), goodsIn };
    }

    /**
     * Der Scan (Suche per Barcode, «Ürün ekle»): zuerst die Seriennummer — sie
     * nennt das Stück samt Projekt —, dann Barcode, Herstellerbarcode, der
     * Barcode eines Lieferanten (vierter Durchgang) und ERP-Code einer Karte
     * (ein zwölfstelliger UPC-A findet auch seinen EAN-13 mit führender 0).
     * Mehrere Treffer kommen alle zurück; die Oberfläche lässt wählen.
     */
    async lookup(tenantId: string, rawCode: unknown): Promise<WarehouseLookupDto> {
        const code = cleanCode(rawCode, 'code', WAREHOUSE_LIMITS.barcode);
        if (!code) throw warehouseError('CODE_REQUIRED', 'Kein Code gelesen.');

        const [byCode, serials] = await Promise.all([
            this.products.findByCode(tenantId, codeVariants(code), 10),
            this.products.findSerialsByNumber(tenantId, code, 10),
        ]);
        const known = new Map(byCode.map((product) => [product.id, product]));
        const missing = [...new Set(serials.map((serial) => serial.productId))].filter((id) => !known.has(id));
        const [extra, live] = await Promise.all([
            this.products.getMany(tenantId, missing),
            this.liveNames(tenantId, serials),
        ]);
        for (const product of extra) known.set(product.id, product);

        const matches: WarehouseLookupMatchDto[] = [];
        for (const serial of serials) {
            const product = known.get(serial.productId);
            if (!product) continue;
            matches.push({ matchedBy: 'serial', product: productDto(product), serial: serialDto(serial, live), supplier: null });
        }
        for (const product of byCode) {
            const supplier = product.suppliers.find((entry) => sameCode(entry.barcode, code));
            if (sameCode(product.barcode, code)) {
                matches.push({ matchedBy: 'barcode', product: productDto(product), serial: null, supplier: null });
            } else if (sameCode(product.manufacturerBarcode, code)) {
                matches.push({ matchedBy: 'manufacturerBarcode', product: productDto(product), serial: null, supplier: null });
            } else if (supplier) {
                matches.push({
                    matchedBy: 'supplierBarcode',
                    product: productDto(product),
                    serial: null,
                    supplier: { id: supplier.supplierId, name: supplier.name },
                });
            } else {
                matches.push({ matchedBy: 'erpCode', product: productDto(product), serial: null, supplier: null });
            }
        }
        return { code, matches };
    }

    /* ── Hilfen ─────────────────────────────────────────────────────────── */

    private async detail(tenantId: string, product: WarehouseProduct): Promise<WarehouseProductDetailDto> {
        const serials = await this.products.listSerials(tenantId, product.id);
        const live = await this.liveNames(tenantId, serials);
        return { product: productDto(product), serials: serials.map((serial) => serialDto(serial, live)) };
    }

    private liveNames(tenantId: string, serials: Parameters<typeof targetIdsOf>[0]) {
        const { projectIds, itemIds } = targetIdsOf(serials);
        if (!projectIds.length && !itemIds.length) {
            return Promise.resolve({ projects: new Map(), devices: new Map() });
        }
        return this.directory.names(tenantId, projectIds, itemIds);
    }

    private codeMissing(group: WarehouseMaterialGroup | null) {
        return warehouseError('GROUP_CODE_MISSING', 'Diese Materialgruppe hat noch kein Kürzel.', {
            status: 409,
            params: { group: group?.name ?? '' },
        });
    }

    /**
     * Gruppe und Lieferanten prüfen. Die Gruppe nur, wenn sie sich geändert
     * hat; die Lieferanten, wenn die Liste neu ist (`checkSuppliers`): ein
     * aus der Lieferantenliste gewählter Lieferant schreibt seinen Namen aus
     * der Liste, eine unbekannte Kennung fällt weg und der geschriebene Name
     * bleibt. Gibt die (neue) Gruppe zurück, falls sie gelesen wurde.
     */
    private async resolveReferences(
        tenantId: string,
        fields: WarehouseProductFields,
        current: WarehouseProduct | null,
        checkSuppliers: boolean,
    ): Promise<WarehouseMaterialGroup | null> {
        let group: WarehouseMaterialGroup | null = null;
        if (fields.materialGroupId && fields.materialGroupId !== current?.materialGroupId) {
            group = await this.groups.getGroup(tenantId, fields.materialGroupId);
            if (!group) throw warehouseError('GROUP_NOT_FOUND', 'Materialgruppe nicht gefunden.', { status: 400 });
        }
        const ids = fields.suppliers.map((entry) => entry.supplierId).filter((id): id is string => Boolean(id));
        if (checkSuppliers && ids.length) {
            const known = await this.directory.suppliersByIds(tenantId, ids);
            fields.suppliers = fields.suppliers.map((entry) => {
                if (!entry.supplierId) return entry;
                const supplier = known.get(entry.supplierId);
                return supplier
                    ? { ...entry, name: supplier.name.slice(0, WAREHOUSE_LIMITS.supplierName) }
                    : { ...entry, supplierId: null };
            });
            // Zwei Einträge können nach dem Namen aus der Liste derselbe sein.
            assertSuppliersUnique(fields.suppliers);
        }
        return group;
    }

    /**
     * Die Barcodes der Karte gegen alle anderen: jeder Herstellerbarcode —
     * ohne Lieferant oder der eines Lieferanten — gehört genau EINER Karte
     * (dritter Durchgang: «o üretici barkodundan sadece 1 tane ürün olabilir»)
     * und ist nie der Barcode einer anderen; unser Barcode ebenso. EAN-13 und
     * UPC-A gelten als derselbe Code.
     */
    private async assertCodesFree(
        tenantId: string,
        codes: { ownBarcode: string | null; makerBarcodes: string[] },
        excludeId?: string,
    ): Promise<void> {
        if (!codes.ownBarcode && !codes.makerBarcodes.length) return;
        const conflicts = await this.products.findConflicts(
            tenantId,
            { erpCode: null, ownBarcode: codes.ownBarcode, makerBarcodes: codes.makerBarcodes },
            excludeId,
        );
        const maker = conflicts.find((conflict) => conflict.field === 'manufacturerBarcode');
        if (maker) {
            throw warehouseError('MANUFACTURER_BARCODE_TAKEN', 'Dieser Herstellerbarcode gehört schon zu einer anderen Karte.', {
                status: 409,
                params: { code: maker.code, name: maker.productName },
                details: { productId: maker.productId },
            });
        }
        const barcode = conflicts.find((conflict) => conflict.field === 'barcode');
        if (barcode) {
            throw warehouseError('BARCODE_TAKEN', 'Dieser Barcode gehört schon zu einer anderen Karte.', {
                status: 409,
                params: { code: barcode.code, name: barcode.productName },
                details: { productId: barcode.productId },
            });
        }
    }

    /** Seriennummern, die mit der Karte kommen (neu oder Pflicht eben eingeschaltet): geprüft, ohne Doppel. */
    private async serialDrafts(tenantId: string, raw: unknown): Promise<WarehouseSerialDraft[]> {
        if (!Array.isArray(raw) || !raw.length) return [];
        if (raw.length > MAX_SERIALS_ON_CREATE) {
            throw warehouseError('FIELD_TOO_LONG', 'Zu viele Seriennummern auf einmal.', {
                params: { field: 'serials', max: MAX_SERIALS_ON_CREATE },
            });
        }
        const entries = raw.map((entry) => {
            const item = (entry && typeof entry === 'object' ? entry : { serialNumber: entry }) as Record<string, unknown>;
            return {
                serialNumber: serialFromInput(item.serialNumber),
                projectRaw: item.productionProjectId,
                itemRaw: item.productionItemId,
            };
        });
        const duplicate = firstDuplicate(entries.map((entry) => entry.serialNumber));
        if (duplicate) {
            throw warehouseError('SERIAL_DUPLICATE_INPUT', 'Eine Seriennummer steht zweimal in der Liste.', {
                params: { serial: duplicate },
            });
        }

        // Gleiche Zuordnungen nur einmal nachschlagen.
        const resolved = new Map<string, Awaited<ReturnType<WarehouseTargetResolver['resolve']>>>();
        const drafts: WarehouseSerialDraft[] = [];
        for (const entry of entries) {
            const key = `${String(entry.projectRaw ?? '')}|${String(entry.itemRaw ?? '')}`;
            let target = resolved.get(key);
            if (!target) {
                target = await this.targets.resolve(tenantId, entry.projectRaw, entry.itemRaw);
                resolved.set(key, target);
            }
            drafts.push({ serialNumber: entry.serialNumber, ...target });
        }
        return drafts;
    }

    private mapUnique(error: unknown, fields: WarehouseProductFields): unknown {
        if (isUniqueViolation(error, 'barcode') && !isUniqueViolation(error, 'erpCode')) {
            return warehouseError('BARCODE_TAKEN', 'Dieser Barcode gehört schon zu einer anderen Karte.', {
                status: 409,
                params: { code: fields.barcode ?? '', name: '' },
            });
        }
        if (isUniqueViolation(error, 'erpCode')) {
            return warehouseError('ERP_CODE_TAKEN', 'Dieser ERP-Code gehört schon zu einer anderen Karte.', {
                status: 409,
                params: { code: fields.erpCode ?? '', name: '' },
            });
        }
        if (isUniqueViolation(error, 'serialNumber')) {
            return warehouseError('SERIAL_TAKEN', 'Diese Seriennummer ist an der Karte schon erfasst.', {
                status: 409,
                params: { serial: '' },
            });
        }
        if (isUniqueViolation(error, 'supplierName')) {
            // Die Datenbank vergleicht ohne Akzente (ş = s): zwei Schreibweisen desselben Namens.
            return warehouseError('SUPPLIER_DUPLICATE', 'Dieser Lieferant steht schon auf der Karte.', {
                status: 409,
                params: { name: '' },
            });
        }
        return error;
    }
}
