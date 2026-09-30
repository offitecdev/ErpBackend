"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BomPurchasesUseCase = void 0;
const productionBom_1 = require("../../../../domain/services/productionBom");
const productionBomProcurement_1 = require("../../../../domain/services/productionBomProcurement");
const QUOTE_MAX_BYTES = 12 * 1024 * 1024;
const QUOTE_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const EPS = 1e-9;
/* ── Welche Spalten die KI füllen darf ────────────────────────────────────
   Die Spalten schickt die Auftragsseite — es sind die ihrer VORLAGE. Fest
   bleiben der ERP-Code (`stdErp`, die eigene Angabe, mit der die BOM jede
   Zeile anlegt), Name und Menge: «satırlar belli». */
const AI_COLUMN_KEY = /^[a-zA-Z][a-zA-Z0-9]{0,15}$/;
const AI_LOCKED_KEYS = new Set(['stdErp']);
const AI_LOCKED_LABELS = new Set(['productName', 'quantity']);
const AI_FILL_LABELS = new Set(['grossPrice', 'netPrice', 'discount', 'discount2', 'total']);
const AI_MAX_COLUMNS = 16;
const AI_PROMPT_MAX_CHARS = 60_000;
const tableAiColumns = (raw) => {
    const columns = [];
    const keys = new Set();
    const labels = new Set();
    for (const entry of Array.isArray(raw) ? raw : []) {
        const value = (entry && typeof entry === 'object' ? entry : {});
        const key = String(value.key ?? '').trim();
        const name = String(value.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const rawLabel = String(value.label ?? '').trim();
        if (!AI_COLUMN_KEY.test(key) || !name || keys.has(key) || AI_LOCKED_KEYS.has(key) || AI_LOCKED_LABELS.has(rawLabel))
            continue;
        // Eine unbekannte oder doppelte Zuordnung ist keine Spalte, die hier jemand füllen soll.
        if (rawLabel && (!AI_FILL_LABELS.has(rawLabel) || labels.has(rawLabel)))
            continue;
        keys.add(key);
        if (rawLabel)
            labels.add(rawLabel);
        columns.push({ key, name, type: value.type === 'number' ? 'number' : 'text', label: rawLabel ? rawLabel : null });
        if (columns.length >= AI_MAX_COLUMNS)
            break;
    }
    return columns;
};
/**
 * ── DIE BESTELLUNGEN EINER BOM (27.09.2026, Vorgabe Samet) ──────────────────
 *
 *   · «Bize verilen tedarikçi sipariş numarasını yazmadan asla ne pdf
 *      gönderebiliyoruz ne de siparişi onaylayabiliyoruz» — die Nummer steht
 *      in `PurchaseOrder.quoteNumber` (das PDF druckt sie als «Teklif
 *      Numaranız»), das Angebot als Datei an der Verknüpfung.
 *   · «Fiyat talebi proje siparişine dönüşemez» — und seit dem 27.09.2026
 *      entsteht sie nur aus der BOM im Entwurf, je Lieferant eine («bom
 *      onaylandıktan sonra fiyat talebi alınamaz»).
 *   · «Mal kabulde de rezerveye gidilecek» — der Wareneingang bucht ins Depo
 *      (Menge oder Seriennummern) und gibt Nummern gleich der wartenden Zeile
 *      mit dem frühesten Liefertermin.
 */
class BomPurchasesUseCase {
    purchases;
    boms;
    stock;
    warehouseProducts;
    reservations;
    devices;
    writer;
    documents;
    tableAi;
    revisions;
    goodsIn;
    directory;
    constructor(purchases, boms, stock, warehouseProducts, reservations, devices, writer, documents, tableAi, revisions, goodsIn = null, directory = null) {
        this.purchases = purchases;
        this.boms = boms;
        this.stock = stock;
        this.warehouseProducts = warehouseProducts;
        this.reservations = reservations;
        this.devices = devices;
        this.writer = writer;
        this.documents = documents;
        this.tableAi = tableAi;
        this.revisions = revisions;
        this.goodsIn = goodsIn;
        this.directory = directory;
    }
    async requireLink(tenantId, purchaseOrderId) {
        const link = await this.purchases.linkForOrder(tenantId, purchaseOrderId);
        if (!link)
            throw (0, productionBom_1.bomError)('PURCHASE_NOT_FOUND', 'Diese Bestellung stammt aus keiner BOM.', { status: 404 });
        return link;
    }
    /**
     * Seit dem 27.09.2026 abends NUR der Einkauf (Seite «Satın alma» Stufe 2
     * oder Administratorrolle): «fiyat talepleri ve siparişleri muhasebe ve
     * yöneticiler yapacak». Die BOM stellt nur noch den Talep.
     */
    async assertCanPurchase(_tenantId, actor, _link) {
        this.devices.assertCanProcure(actor);
    }
    async bomDtoOf(tenantId, bomId) {
        const bom = await this.boms.get(tenantId, bomId);
        if (!bom)
            return null;
        const [dto] = await this.devices.dtos(tenantId, [bom]);
        return dto ?? null;
    }
    /* ── Angebotsnummer und Angebots-PDF ───────────────────────────────── */
    async setQuoteNumber(tenantId, actor, purchaseOrderId, body) {
        const link = await this.requireLink(tenantId, purchaseOrderId);
        await this.assertCanPurchase(tenantId, actor, link);
        const raw = String(body?.quoteNumber ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const ok = await this.writer.setQuoteNumber(tenantId, purchaseOrderId, raw || null);
        if (!ok)
            throw (0, productionBom_1.bomError)('PURCHASE_NOT_FOUND', 'Bestellung nicht gefunden.', { status: 404 });
        return { bom: await this.bomDtoOf(tenantId, link.bomId) };
    }
    /**
     * Das Angebot ablegen (R2, sonst Platte). `lean` (29.09.2026, Samet: «pdf
     * yüklemesi 5 saniye sürüyor, en fazla 200 ms»): die Antwort trägt nur die
     * Datei, nicht die ganze BOM — deren Rechnung kostete allein ~0,5 s; die
     * Seite zeigt das PDF sofort und liest den Rest im Hintergrund.
     */
    async uploadQuote(tenantId, actor, purchaseOrderId, file, options = {}) {
        const link = await this.requireLink(tenantId, purchaseOrderId);
        await this.assertCanPurchase(tenantId, actor, link);
        if (!file || !file.body?.length)
            throw (0, productionBom_1.bomError)('FILE_REQUIRED', 'Keine Datei empfangen.');
        const contentType = String(file.contentType || '').toLowerCase();
        if (!QUOTE_TYPES.has(contentType) || !this.documents.accepts(contentType)) {
            throw (0, productionBom_1.bomError)('FILE_TYPE', 'Das Angebot kommt als PDF oder Bild.');
        }
        if (file.body.length > QUOTE_MAX_BYTES)
            throw (0, productionBom_1.bomError)('FILE_TOO_LARGE', 'Die Datei ist zu gross (max. 12 MB).', { status: 413 });
        const ref = await this.documents.store(tenantId, file.body, contentType);
        const name = (file.fileName || 'angebot.pdf').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200);
        try {
            const updated = await this.purchases.setQuoteFile(tenantId, purchaseOrderId, { ref, name, type: contentType, size: file.body.length }, actor.id);
            if (!updated)
                throw (0, productionBom_1.bomError)('PURCHASE_NOT_FOUND', 'Bestellung nicht gefunden.', { status: 404 });
        }
        catch (error) {
            await this.documents.remove(ref).catch(() => undefined);
            throw error;
        }
        // Das ersetzte Angebot geht im Hintergrund — niemand wartet darauf.
        if (link.quoteFileRef && link.quoteFileRef !== ref)
            void this.documents.remove(link.quoteFileRef).catch(() => undefined);
        const quoteFile = { name, type: contentType, size: file.body.length };
        if (options.lean)
            return { bom: null, quoteFile };
        return { bom: await this.bomDtoOf(tenantId, link.bomId), quoteFile };
    }
    async readQuote(tenantId, purchaseOrderId) {
        const link = await this.requireLink(tenantId, purchaseOrderId);
        if (!link.quoteFileRef)
            throw (0, productionBom_1.bomError)('FILE_REQUIRED', 'Zu dieser Bestellung liegt kein Angebot.', { status: 404 });
        const body = await this.documents.read(link.quoteFileRef);
        return { body, contentType: link.quoteFileType || 'application/pdf', fileName: link.quoteFileName || 'angebot.pdf' };
    }
    async removeQuote(tenantId, actor, purchaseOrderId) {
        const link = await this.requireLink(tenantId, purchaseOrderId);
        await this.assertCanPurchase(tenantId, actor, link);
        const order = (await this.purchases.orders(tenantId, [purchaseOrderId]))[0];
        // Eine bestätigte Bestellung behält ihr Angebot — es war die Bedingung der Bestätigung.
        if (order && productionBom_1.CONFIRMED_ORDER_STATUSES.has(order.status)) {
            throw (0, productionBom_1.bomError)('STATUS_INVALID', 'Das Angebot einer bestätigten Bestellung bleibt.', { status: 409 });
        }
        await this.purchases.setQuoteFile(tenantId, purchaseOrderId, null, actor.id);
        if (link.quoteFileRef)
            await this.documents.remove(link.quoteFileRef).catch(() => undefined);
        return { bom: await this.bomDtoOf(tenantId, link.bomId) };
    }
    /* Preisanfragen entstehen seit dem 27.09.2026 nur noch aus der BOM im
       ENTWURF (DeviceBomsUseCase.createRequests) — die Kopie einer Bestellung
       als Anfrage gibt es nicht mehr («bom onaylandıktan sonra fiyat talebi
       alınamaz»). */
    /* ── Wareneingang ins Depo ─────────────────────────────────────────── */
    /**
     * `lines: [{ index, quantity, serials: [] }]` — `index` ist die Stelle in
     * `PurchaseOrder.items`. Karten mit Seriennummer brauchen genau so viele
     * Nummern wie Stück; jede Nummer steht danach an der Karte und geht (frei)
     * an die wartende Zeile mit dem frühesten Liefertermin.
     */
    async receive(tenantId, actor, purchaseOrderId, body) {
        const link = await this.requireLink(tenantId, purchaseOrderId);
        await this.assertCanPurchase(tenantId, actor, link);
        if (link.kind !== 'ORDER')
            throw (0, productionBom_1.bomError)('ORDER_ONLY', 'Ware kommt über eine Bestellung, nicht über eine Anfrage.', { status: 409 });
        const order = (await this.purchases.orders(tenantId, [purchaseOrderId]))[0];
        if (!order)
            throw (0, productionBom_1.bomError)('PURCHASE_NOT_FOUND', 'Bestellung nicht gefunden.', { status: 404 });
        if (!['TO_BE_STOCKED', 'PENDING'].includes(order.status)) {
            throw (0, productionBom_1.bomError)('STATUS_INVALID', 'Erst die Bestellung bestätigen — dann kommt die Ware.', { status: 409 });
        }
        const bom = await this.boms.get(tenantId, link.bomId);
        if (!bom)
            throw (0, productionBom_1.bomError)('BOM_NOT_FOUND', 'BOM nicht gefunden.', { status: 404 });
        const productOfLine = new Map(bom.lines.map((line) => [line.id, line.productId]));
        // Eine Zeile, die eine Revision entfernt hat, deren Bestellung aber blieb (der
        // Lieferant hat nicht storniert): ihre Ware kommt trotzdem ins Depo — frei.
        if (order.items.some((item) => typeof item.bomLineId === 'string' && !productOfLine.has(item.bomLineId))) {
            for (const revision of await this.revisions.listForBoms(tenantId, [bom.id])) {
                for (const line of revision.lines)
                    if (!productOfLine.has(line.id))
                        productOfLine.set(line.id, line.productId);
            }
        }
        const raw = body?.lines;
        if (!Array.isArray(raw) || !raw.length)
            throw (0, productionBom_1.bomError)('RECEIPT_INVALID', 'Keine Menge erfasst.');
        const plan = [];
        const productIds = new Set();
        const seenIndexes = new Set();
        for (const entry of raw) {
            const value = (entry && typeof entry === 'object' ? entry : {});
            const index = Math.trunc(Number(value.index));
            const item = order.items[index];
            const bomLineId = typeof item?.bomLineId === 'string' ? item.bomLineId : null;
            const productId = bomLineId ? productOfLine.get(bomLineId) : undefined;
            if (!item || !productId || seenIndexes.has(index)) {
                throw (0, productionBom_1.bomError)('RECEIPT_INVALID', `Position ${index + 1} gehört zu keiner BOM-Zeile.`, { params: { row: index + 1 } });
            }
            seenIndexes.add(index);
            const serials = Array.isArray(value.serials)
                ? [...new Set(value.serials.map((serial) => String(serial ?? '').trim()).filter(Boolean))]
                : [];
            const quantity = serials.length ? serials.length : (0, productionBom_1.round3)(Number(value.quantity) || 0);
            const remaining = (0, productionBom_1.round3)((Number(item.quantity) || 0) - (Number(item.receivedQuantity) || 0));
            if (quantity <= 0 || quantity > remaining + EPS) {
                throw (0, productionBom_1.bomError)('RECEIPT_INVALID', `Position ${index + 1}: höchstens ${remaining}.`, { params: { row: index + 1, max: remaining } });
            }
            plan.push({ index, quantity, serials, productId, serialRequired: false });
            productIds.add(productId);
        }
        const products = await this.stock.products(tenantId, [...productIds]);
        for (const entry of plan) {
            const product = products.get(entry.productId);
            if (!product)
                throw (0, productionBom_1.bomError)('PRODUCT_NOT_FOUND', 'Die Depo-Karte gibt es nicht mehr.', { status: 404 });
            entry.serialRequired = product.serialRequired;
            if (product.serialRequired && (!entry.serials.length || entry.serials.length !== entry.quantity)) {
                throw (0, productionBom_1.bomError)('SERIAL_REQUIRED', `Position ${entry.index + 1}: je Stück eine Seriennummer.`, { params: { row: entry.index + 1 } });
            }
            if (product.serialRequired) {
                const taken = await this.warehouseProducts.existingSerials(tenantId, entry.productId, entry.serials);
                if (taken.length) {
                    throw (0, productionBom_1.bomError)('SERIAL_TAKEN', `Seriennummer ${taken[0]} steht schon an der Karte.`, { status: 409, params: { serial: taken[0] ?? '' } });
                }
            }
        }
        // Wie die Reservierung VOR der Buchung stand — der Zuwachs danach zeigt, wohin die Ware ging.
        const before = await this.reservations.facts(tenantId, [...productIds]);
        // Erst ins Depo, dann in die Bestellung: fällt das Depo aus, bleibt die Bestellung offen.
        const booked = [];
        for (const entry of plan) {
            if (entry.serialRequired) {
                for (const serialNumber of entry.serials) {
                    await this.warehouseProducts.addSerial(tenantId, entry.productId, {
                        serialNumber,
                        productionProjectId: null,
                        productionItemId: null,
                        projectNumber: null,
                        projectName: null,
                        deviceName: null,
                    }, actor.id);
                }
            }
            else {
                const result = await this.warehouseProducts.adjustQuantity(tenantId, entry.productId, entry.quantity, actor.id);
                if (result !== 'ok')
                    throw (0, productionBom_1.bomError)('RECEIPT_INVALID', 'Der Bestand der Karte liess sich nicht buchen.', { status: 409 });
            }
            booked.push({ index: entry.index, quantity: entry.quantity });
        }
        const receipt = await this.writer.applyReceipt({ tenantId, userId: actor.id, purchaseOrderId, received: booked });
        const serialResult = await this.reservations.assignFreeSerialsDetailed(tenantId, [...productIds]);
        // Das Protokoll darf den Wareneingang nie scheitern lassen — die Ware ist gebucht.
        const allocations = await this.recordGoodsIn(tenantId, actor, order.id, order.referenceNumber, plan, products, before, serialResult.assigned)
            .catch((error) => {
            console.warn('[production-bom] goods-in log failed', error?.message);
            return [];
        });
        return { bom: await this.bomDtoOf(tenantId, link.bomId), status: receipt.status, allocations };
    }
    /**
     * «Mal kabulde projeler arasında en erken teslim tarihli projeye»: die
     * Reservierung rechnet ohnehin frühester Liefertermin zuerst. Hier wird
     * festgehalten, wohin DIESE Buchung die Ware gab — Menge je Zeile aus dem
     * Zuwachs an Reserviertem, Seriennummern aus ihrer Zuordnung; der Rest ist
     * freier Bestand. Das ist «Gelen mallar» an der BOM.
     */
    async recordGoodsIn(tenantId, actor, purchaseOrderId, referenceNumber, plan, products, before, assigned) {
        const productIds = [...new Set(plan.map((entry) => entry.productId))];
        const after = await this.reservations.facts(tenantId, productIds);
        const receiptId = `R${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 32);
        const receivedAt = new Date();
        const rows = [];
        const push = (productId, demand, quantity, serials) => {
            const product = products.get(productId);
            rows.push({
                receiptId,
                source: 'ORDER',
                purchaseOrderId,
                referenceNumber,
                productId,
                erpCode: product?.erpCode ?? null,
                name: product?.name ?? '—',
                bomId: demand?.bomId ?? null,
                lineId: demand?.lineId ?? null,
                productionProjectId: demand?.productionProjectId ?? null,
                productionItemId: demand?.productionItemId ?? null,
                quantity: (0, productionBom_1.round3)(quantity),
                serials,
                receivedById: actor.id,
                receivedAt,
            });
        };
        for (const productId of productIds) {
            const entries = plan.filter((entry) => entry.productId === productId);
            if (entries.some((entry) => entry.serialRequired)) {
                const received = new Set(entries.flatMap((entry) => entry.serials));
                const byLine = new Map();
                for (const entry of assigned) {
                    if (entry.productId !== productId || !received.has(entry.serialNumber))
                        continue;
                    const group = byLine.get(entry.demand.lineId) ?? { demand: entry.demand, serials: [] };
                    group.serials.push(entry.serialNumber);
                    byLine.set(entry.demand.lineId, group);
                    received.delete(entry.serialNumber);
                }
                for (const group of byLine.values())
                    push(productId, group.demand, group.serials.length, group.serials);
                if (received.size)
                    push(productId, null, received.size, [...received]);
                continue;
            }
            const quantity = (0, productionBom_1.round3)(entries.reduce((sum, entry) => sum + entry.quantity, 0));
            const demands = after.demands.filter((demand) => demand.productId === productId);
            for (const part of (0, productionBomProcurement_1.receiptAllocation)(quantity, demands, before.coverage.lines, after.coverage.lines)) {
                push(productId, part.demand, part.quantity, []);
            }
        }
        if (this.goodsIn)
            await this.goodsIn.add(tenantId, rows);
        const bomIds = [...new Set(rows.map((row) => row.bomId).filter((id) => Boolean(id)))];
        const projectIds = rows.map((row) => row.productionProjectId).filter((id) => Boolean(id));
        const itemIds = rows.map((row) => row.productionItemId).filter((id) => Boolean(id));
        const [boms, projects, devices] = await Promise.all([
            bomIds.length ? this.boms.getMany(tenantId, bomIds) : Promise.resolve([]),
            this.directory && projectIds.length ? this.directory.projects(tenantId, projectIds) : Promise.resolve(new Map()),
            this.directory && itemIds.length ? this.directory.devices(tenantId, itemIds) : Promise.resolve(new Map()),
        ]);
        const bomNumber = new Map(boms.map((bom) => [bom.id, bom.bomNumber]));
        return rows.map((row) => {
            const project = row.productionProjectId ? projects.get(row.productionProjectId) : undefined;
            const device = row.productionItemId ? devices.get(row.productionItemId) : undefined;
            const delivery = row.productionProjectId ? after.deliveryDates.get(row.productionProjectId) ?? null : null;
            return {
                productId: row.productId,
                erpCode: row.erpCode,
                name: row.name,
                quantity: row.quantity,
                serials: row.serials,
                bomId: row.bomId,
                bomNumber: row.bomId ? bomNumber.get(row.bomId) ?? null : null,
                projectNumber: project?.projectNumber ?? null,
                projectName: project?.projectName ?? null,
                deviceName: device?.name ?? null,
                deliveryDate: delivery ? delivery.toISOString() : null,
            };
        });
    }
    /* ── Die Tabelle per KI ──────────────────────────────────────────────── */
    /**
     * «Yeni sütun ekleme olmayacak, direkt şablon uygulanacak» (27.09.2026):
     * die Spalten kommen aus der VORLAGE der Auftragsseite, die Zeilen aus der
     * GESPEICHERTEN Bestellung samt BOM-Zeile (Hersteller, Typennummer) — nie
     * aus der Anfrage. Die KI füllt je Zeile die Spalten, zu denen die Quelle
     * etwas sagt; was davon in die Tabelle geht, entscheidet die Seite.
     */
    async fillTable(tenantId, actor, purchaseOrderId, body) {
        const link = await this.requireLink(tenantId, purchaseOrderId);
        await this.assertCanPurchase(tenantId, actor, link);
        const input = (body && typeof body === 'object' ? body : {});
        const columns = tableAiColumns(input.columns);
        if (!columns.length)
            throw (0, productionBom_1.bomError)('AI_COLUMNS_REQUIRED', 'Die Vorlage hat keine Spalte, die gefüllt werden kann.');
        const prompt = typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt.slice(0, AI_PROMPT_MAX_CHARS) : null;
        const images = (Array.isArray(input.images) ? input.images : [])
            .slice(0, 6)
            .flatMap((entry) => {
            const value = (entry && typeof entry === 'object' ? entry : {});
            const data = String(value.data ?? '');
            const mimeType = String(value.mimeType ?? '').toLowerCase() || 'image/png';
            return data && mimeType.startsWith('image/') ? [{ data, mimeType }] : [];
        });
        const text = typeof input.text === 'string' && input.text.trim() ? input.text : null;
        const document = typeof input.data === 'string' && input.data
            ? { data: input.data, fileName: typeof input.fileName === 'string' ? input.fileName : null, mimeType: typeof input.mimeType === 'string' ? input.mimeType : null }
            : null;
        if (!images.length && !prompt && !text && !document) {
            throw (0, productionBom_1.bomError)('AI_SOURCE_REQUIRED', 'Zeilen, Bild, Excel oder PDF des Lieferanten fehlen.');
        }
        const order = (await this.purchases.orders(tenantId, [purchaseOrderId]))[0];
        if (!order)
            throw (0, productionBom_1.bomError)('PURCHASE_NOT_FOUND', 'Bestellung nicht gefunden.', { status: 404 });
        const bom = await this.boms.get(tenantId, link.bomId);
        const lineById = new Map((bom?.lines ?? []).map((line) => [line.id, line]));
        // Die Zeilen kommen aus der gespeicherten Bestellung — nie aus der Anfrage.
        const rows = order.items.map((item, index) => {
            const line = typeof item.bomLineId === 'string' ? lineById.get(item.bomLineId) : undefined;
            return {
                index,
                erpCode: typeof item.code === 'string' ? item.code : line?.erpCode ?? null,
                name: line?.name ?? String(item.name ?? ''),
                brand: line?.brand ?? null,
                modelNumber: line?.modelNumber ?? null,
                quantity: Number(item.quantity) || 0,
                unit: typeof item.unit === 'string' && item.unit.trim() ? item.unit.trim() : null,
            };
        });
        const language = input.language === 'de' || input.language === 'en' ? input.language : 'tr';
        try {
            return await this.tableAi({ columns, rows, prompt, images, text, document, language, header: input.header === true });
        }
        catch (error) {
            const code = error?.code;
            if (code === 'AI_NOT_CONFIGURED' || code === 'GPT_NOT_CONFIGURED') {
                throw (0, productionBom_1.bomError)('AI_NOT_CONFIGURED', 'Die KI ist nicht eingerichtet.', { status: 503 });
            }
            if (code === 'AI_SOURCE_REQUIRED' || code === 'AI_SOURCE_UNREADABLE') {
                throw (0, productionBom_1.bomError)(code, error.message, { status: 422 });
            }
            if (code === 'AI_COLUMNS_REQUIRED')
                throw (0, productionBom_1.bomError)(code, error.message);
            throw (0, productionBom_1.bomError)('AI_FAILED', error?.message || 'Die KI hat nicht geantwortet.', {
                status: Number(error?.status) || 502,
                ...(code ? { params: { reason: code } } : {}),
            });
        }
    }
}
exports.BomPurchasesUseCase = BomPurchasesUseCase;
//# sourceMappingURL=BomPurchasesUseCase.js.map