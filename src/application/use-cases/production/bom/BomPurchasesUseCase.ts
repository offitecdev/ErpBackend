import type { BomDemand, BomGoodsIn, BomPurchaseLink } from '../../../../domain/entities/ProductionBom';
import type {
    IBomGoodsInRepository,
    IBomProductionDirectory,
    IBomPurchaseRepository,
    IBomRepository,
    IBomRevisionRepository,
    IBomStockReader,
} from '../../../../domain/repositories/IProductionBomRepository';
import type { IWarehouseProductRepository } from '../../../../domain/repositories/IWarehouseRepository';
import {
    bomError,
    CONFIRMED_ORDER_STATUSES,
    round3,
} from '../../../../domain/services/productionBom';
import { receiptAllocation } from '../../../../domain/services/productionBomProcurement';
import type { BomPurchaseOrderWriter } from '../../../../infrastructure/services/productionBomPurchaseWriter';
import type { TableAiColumn, TableAiInput, TableAiLabel, TableAiResult } from '../../../../infrastructure/services/bomTableAi';
import type { BomReservationService } from './BomReservationService';
import type { BomActor } from './BomTemplatesUseCase';
import type { DeviceBomsUseCase } from './DeviceBomsUseCase';
import type { BomDto } from './bomReadModel';

/** Die Ablage der Angebots-PDFs (DocumentStorage, R2 oder Platte). */
export interface BomDocumentStore {
    accepts(contentType: string): boolean;
    store(tenantId: string, body: Buffer, contentType: string): Promise<string>;
    read(reference: string): Promise<Buffer>;
    remove(reference: string): Promise<void>;
}

export type TableAiPort = (input: TableAiInput) => Promise<TableAiResult>;

/** Wohin eine Buchung Ware gab — für die Meldung nach dem Wareneingang. */
export interface BomReceiptAllocationDto {
    productId: string;
    erpCode: string | null;
    name: string;
    quantity: number;
    serials: string[];
    /** null = kein wartender Bedarf: freier Bestand. */
    bomId: string | null;
    bomNumber: string | null;
    projectNumber: string | null;
    projectName: string | null;
    deviceName: string | null;
    deliveryDate: string | null;
}

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
const AI_FILL_LABELS = new Set<string>(['grossPrice', 'netPrice', 'discount', 'discount2', 'total']);
const AI_MAX_COLUMNS = 16;
const AI_PROMPT_MAX_CHARS = 60_000;

const tableAiColumns = (raw: unknown): TableAiColumn[] => {
    const columns: TableAiColumn[] = [];
    const keys = new Set<string>();
    const labels = new Set<string>();
    for (const entry of Array.isArray(raw) ? raw : []) {
        const value = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
        const key = String(value.key ?? '').trim();
        const name = String(value.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const rawLabel = String(value.label ?? '').trim();
        if (!AI_COLUMN_KEY.test(key) || !name || keys.has(key) || AI_LOCKED_KEYS.has(key) || AI_LOCKED_LABELS.has(rawLabel)) continue;
        // Eine unbekannte oder doppelte Zuordnung ist keine Spalte, die hier jemand füllen soll.
        if (rawLabel && (!AI_FILL_LABELS.has(rawLabel) || labels.has(rawLabel))) continue;
        keys.add(key);
        if (rawLabel) labels.add(rawLabel);
        columns.push({ key, name, type: value.type === 'number' ? 'number' : 'text', label: rawLabel ? rawLabel as TableAiLabel : null });
        if (columns.length >= AI_MAX_COLUMNS) break;
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
export class BomPurchasesUseCase {
    constructor(
        private purchases: IBomPurchaseRepository,
        private boms: IBomRepository,
        private stock: IBomStockReader,
        private warehouseProducts: IWarehouseProductRepository,
        private reservations: BomReservationService,
        private devices: DeviceBomsUseCase,
        private writer: BomPurchaseOrderWriter,
        private documents: BomDocumentStore,
        private tableAi: TableAiPort,
        private revisions: IBomRevisionRepository,
        private goodsIn: IBomGoodsInRepository | null = null,
        private directory: IBomProductionDirectory | null = null,
    ) {}

    private async requireLink(tenantId: string, purchaseOrderId: string): Promise<BomPurchaseLink> {
        const link = await this.purchases.linkForOrder(tenantId, purchaseOrderId);
        if (!link) throw bomError('PURCHASE_NOT_FOUND', 'Diese Bestellung stammt aus keiner BOM.', { status: 404 });
        return link;
    }

    /**
     * Seit dem 27.09.2026 abends NUR der Einkauf (Seite «Satın alma» Stufe 2
     * oder Administratorrolle): «fiyat talepleri ve siparişleri muhasebe ve
     * yöneticiler yapacak». Die BOM stellt nur noch den Talep.
     */
    private async assertCanPurchase(_tenantId: string, actor: BomActor, _link: BomPurchaseLink): Promise<void> {
        this.devices.assertCanProcure(actor);
    }

    private async bomDtoOf(tenantId: string, bomId: string): Promise<BomDto | null> {
        const bom = await this.boms.get(tenantId, bomId);
        if (!bom) return null;
        const [dto] = await this.devices.dtos(tenantId, [bom]);
        return dto ?? null;
    }

    /* ── Angebotsnummer und Angebots-PDF ───────────────────────────────── */

    async setQuoteNumber(tenantId: string, actor: BomActor, purchaseOrderId: string, body: unknown): Promise<{ bom: BomDto | null }> {
        const link = await this.requireLink(tenantId, purchaseOrderId);
        await this.assertCanPurchase(tenantId, actor, link);
        const raw = String((body as Record<string, unknown> | null)?.quoteNumber ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const ok = await this.writer.setQuoteNumber(tenantId, purchaseOrderId, raw || null);
        if (!ok) throw bomError('PURCHASE_NOT_FOUND', 'Bestellung nicht gefunden.', { status: 404 });
        return { bom: await this.bomDtoOf(tenantId, link.bomId) };
    }

    async uploadQuote(
        tenantId: string,
        actor: BomActor,
        purchaseOrderId: string,
        file: { body: Buffer; contentType: string; fileName: string } | null,
    ): Promise<{ bom: BomDto | null }> {
        const link = await this.requireLink(tenantId, purchaseOrderId);
        await this.assertCanPurchase(tenantId, actor, link);
        if (!file || !file.body?.length) throw bomError('FILE_REQUIRED', 'Keine Datei empfangen.');
        const contentType = String(file.contentType || '').toLowerCase();
        if (!QUOTE_TYPES.has(contentType) || !this.documents.accepts(contentType)) {
            throw bomError('FILE_TYPE', 'Das Angebot kommt als PDF oder Bild.');
        }
        if (file.body.length > QUOTE_MAX_BYTES) throw bomError('FILE_TOO_LARGE', 'Die Datei ist zu gross (max. 12 MB).', { status: 413 });
        const ref = await this.documents.store(tenantId, file.body, contentType);
        const name = (file.fileName || 'angebot.pdf').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200);
        try {
            const updated = await this.purchases.setQuoteFile(tenantId, purchaseOrderId, { ref, name, type: contentType, size: file.body.length }, actor.id);
            if (!updated) throw bomError('PURCHASE_NOT_FOUND', 'Bestellung nicht gefunden.', { status: 404 });
        } catch (error) {
            await this.documents.remove(ref).catch(() => undefined);
            throw error;
        }
        if (link.quoteFileRef && link.quoteFileRef !== ref) await this.documents.remove(link.quoteFileRef).catch(() => undefined);
        return { bom: await this.bomDtoOf(tenantId, link.bomId) };
    }

    async readQuote(tenantId: string, purchaseOrderId: string): Promise<{ body: Buffer; contentType: string; fileName: string }> {
        const link = await this.requireLink(tenantId, purchaseOrderId);
        if (!link.quoteFileRef) throw bomError('FILE_REQUIRED', 'Zu dieser Bestellung liegt kein Angebot.', { status: 404 });
        const body = await this.documents.read(link.quoteFileRef);
        return { body, contentType: link.quoteFileType || 'application/pdf', fileName: link.quoteFileName || 'angebot.pdf' };
    }

    async removeQuote(tenantId: string, actor: BomActor, purchaseOrderId: string): Promise<{ bom: BomDto | null }> {
        const link = await this.requireLink(tenantId, purchaseOrderId);
        await this.assertCanPurchase(tenantId, actor, link);
        const order = (await this.purchases.orders(tenantId, [purchaseOrderId]))[0];
        // Eine bestätigte Bestellung behält ihr Angebot — es war die Bedingung der Bestätigung.
        if (order && CONFIRMED_ORDER_STATUSES.has(order.status)) {
            throw bomError('STATUS_INVALID', 'Das Angebot einer bestätigten Bestellung bleibt.', { status: 409 });
        }
        await this.purchases.setQuoteFile(tenantId, purchaseOrderId, null, actor.id);
        if (link.quoteFileRef) await this.documents.remove(link.quoteFileRef).catch(() => undefined);
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
    async receive(tenantId: string, actor: BomActor, purchaseOrderId: string, body: unknown): Promise<{
        bom: BomDto | null;
        status: string;
        allocations: BomReceiptAllocationDto[];
    }> {
        const link = await this.requireLink(tenantId, purchaseOrderId);
        await this.assertCanPurchase(tenantId, actor, link);
        if (link.kind !== 'ORDER') throw bomError('ORDER_ONLY', 'Ware kommt über eine Bestellung, nicht über eine Anfrage.', { status: 409 });
        const order = (await this.purchases.orders(tenantId, [purchaseOrderId]))[0];
        if (!order) throw bomError('PURCHASE_NOT_FOUND', 'Bestellung nicht gefunden.', { status: 404 });
        if (!['TO_BE_STOCKED', 'PENDING'].includes(order.status)) {
            throw bomError('STATUS_INVALID', 'Erst die Bestellung bestätigen — dann kommt die Ware.', { status: 409 });
        }
        const bom = await this.boms.get(tenantId, link.bomId);
        if (!bom) throw bomError('BOM_NOT_FOUND', 'BOM nicht gefunden.', { status: 404 });
        const productOfLine = new Map(bom.lines.map((line) => [line.id, line.productId]));
        // Eine Zeile, die eine Revision entfernt hat, deren Bestellung aber blieb (der
        // Lieferant hat nicht storniert): ihre Ware kommt trotzdem ins Depo — frei.
        if (order.items.some((item) => typeof item.bomLineId === 'string' && !productOfLine.has(item.bomLineId))) {
            for (const revision of await this.revisions.listForBoms(tenantId, [bom.id])) {
                for (const line of revision.lines) if (!productOfLine.has(line.id)) productOfLine.set(line.id, line.productId);
            }
        }

        const raw = (body as Record<string, unknown> | null)?.lines;
        if (!Array.isArray(raw) || !raw.length) throw bomError('RECEIPT_INVALID', 'Keine Menge erfasst.');
        const plan: Array<{ index: number; quantity: number; serials: string[]; productId: string; serialRequired: boolean }> = [];
        const productIds = new Set<string>();
        const seenIndexes = new Set<number>();
        for (const entry of raw) {
            const value = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
            const index = Math.trunc(Number(value.index));
            const item = order.items[index];
            const bomLineId = typeof item?.bomLineId === 'string' ? item.bomLineId : null;
            const productId = bomLineId ? productOfLine.get(bomLineId) : undefined;
            if (!item || !productId || seenIndexes.has(index)) {
                throw bomError('RECEIPT_INVALID', `Position ${index + 1} gehört zu keiner BOM-Zeile.`, { params: { row: index + 1 } });
            }
            seenIndexes.add(index);
            const serials = Array.isArray(value.serials)
                ? [...new Set(value.serials.map((serial) => String(serial ?? '').trim()).filter(Boolean))]
                : [];
            const quantity = serials.length ? serials.length : round3(Number(value.quantity) || 0);
            const remaining = round3((Number(item.quantity) || 0) - (Number(item.receivedQuantity) || 0));
            if (quantity <= 0 || quantity > remaining + EPS) {
                throw bomError('RECEIPT_INVALID', `Position ${index + 1}: höchstens ${remaining}.`, { params: { row: index + 1, max: remaining } });
            }
            plan.push({ index, quantity, serials, productId, serialRequired: false });
            productIds.add(productId);
        }
        const products = await this.stock.products(tenantId, [...productIds]);
        for (const entry of plan) {
            const product = products.get(entry.productId);
            if (!product) throw bomError('PRODUCT_NOT_FOUND', 'Die Depo-Karte gibt es nicht mehr.', { status: 404 });
            entry.serialRequired = product.serialRequired;
            if (product.serialRequired && (!entry.serials.length || entry.serials.length !== entry.quantity)) {
                throw bomError('SERIAL_REQUIRED', `Position ${entry.index + 1}: je Stück eine Seriennummer.`, { params: { row: entry.index + 1 } });
            }
            if (product.serialRequired) {
                const taken = await this.warehouseProducts.existingSerials(tenantId, entry.productId, entry.serials);
                if (taken.length) {
                    throw bomError('SERIAL_TAKEN', `Seriennummer ${taken[0]} steht schon an der Karte.`, { status: 409, params: { serial: taken[0] ?? '' } });
                }
            }
        }

        // Wie die Reservierung VOR der Buchung stand — der Zuwachs danach zeigt, wohin die Ware ging.
        const before = await this.reservations.facts(tenantId, [...productIds]);

        // Erst ins Depo, dann in die Bestellung: fällt das Depo aus, bleibt die Bestellung offen.
        const booked: Array<{ index: number; quantity: number }> = [];
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
            } else {
                const result = await this.warehouseProducts.adjustQuantity(tenantId, entry.productId, entry.quantity, actor.id);
                if (result !== 'ok') throw bomError('RECEIPT_INVALID', 'Der Bestand der Karte liess sich nicht buchen.', { status: 409 });
            }
            booked.push({ index: entry.index, quantity: entry.quantity });
        }
        const receipt = await this.writer.applyReceipt({ tenantId, userId: actor.id, purchaseOrderId, received: booked });
        const serialResult = await this.reservations.assignFreeSerialsDetailed(tenantId, [...productIds]);
        // Das Protokoll darf den Wareneingang nie scheitern lassen — die Ware ist gebucht.
        const allocations = await this.recordGoodsIn(tenantId, actor, order.id, order.referenceNumber, plan, products, before, serialResult.assigned)
            .catch((error: unknown) => {
                console.warn('[production-bom] goods-in log failed', (error as Error)?.message);
                return [] as BomReceiptAllocationDto[];
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
    private async recordGoodsIn(
        tenantId: string,
        actor: BomActor,
        purchaseOrderId: string,
        referenceNumber: string,
        plan: Array<{ quantity: number; serials: string[]; productId: string; serialRequired: boolean }>,
        products: Map<string, { erpCode: string | null; name: string }>,
        before: Awaited<ReturnType<BomReservationService['facts']>>,
        assigned: Array<{ serialNumber: string; productId: string; demand: BomDemand }>,
    ): Promise<BomReceiptAllocationDto[]> {
        const productIds = [...new Set(plan.map((entry) => entry.productId))];
        const after = await this.reservations.facts(tenantId, productIds);
        const receiptId = `R${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.slice(0, 32);
        const receivedAt = new Date();
        const rows: Array<Omit<BomGoodsIn, 'id' | 'tenantId'>> = [];
        const push = (productId: string, demand: BomDemand | null, quantity: number, serials: string[]) => {
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
                quantity: round3(quantity),
                serials,
                receivedById: actor.id,
                receivedAt,
            });
        };
        for (const productId of productIds) {
            const entries = plan.filter((entry) => entry.productId === productId);
            if (entries.some((entry) => entry.serialRequired)) {
                const received = new Set(entries.flatMap((entry) => entry.serials));
                const byLine = new Map<string, { demand: BomDemand; serials: string[] }>();
                for (const entry of assigned) {
                    if (entry.productId !== productId || !received.has(entry.serialNumber)) continue;
                    const group = byLine.get(entry.demand.lineId) ?? { demand: entry.demand, serials: [] };
                    group.serials.push(entry.serialNumber);
                    byLine.set(entry.demand.lineId, group);
                    received.delete(entry.serialNumber);
                }
                for (const group of byLine.values()) push(productId, group.demand, group.serials.length, group.serials);
                if (received.size) push(productId, null, received.size, [...received]);
                continue;
            }
            const quantity = round3(entries.reduce((sum, entry) => sum + entry.quantity, 0));
            const demands = after.demands.filter((demand) => demand.productId === productId);
            for (const part of receiptAllocation(quantity, demands, before.coverage.lines, after.coverage.lines)) {
                push(productId, part.demand, part.quantity, []);
            }
        }
        if (this.goodsIn) await this.goodsIn.add(tenantId, rows);

        const bomIds = [...new Set(rows.map((row) => row.bomId).filter((id): id is string => Boolean(id)))];
        const projectIds = rows.map((row) => row.productionProjectId).filter((id): id is string => Boolean(id));
        const itemIds = rows.map((row) => row.productionItemId).filter((id): id is string => Boolean(id));
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
    async fillTable(tenantId: string, actor: BomActor, purchaseOrderId: string, body: unknown): Promise<TableAiResult> {
        const link = await this.requireLink(tenantId, purchaseOrderId);
        await this.assertCanPurchase(tenantId, actor, link);
        const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const columns = tableAiColumns(input.columns);
        if (!columns.length) throw bomError('AI_COLUMNS_REQUIRED', 'Die Vorlage hat keine Spalte, die gefüllt werden kann.');
        const prompt = typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt.slice(0, AI_PROMPT_MAX_CHARS) : null;
        const images = (Array.isArray(input.images) ? input.images : [])
            .slice(0, 6)
            .flatMap((entry) => {
                const value = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
                const data = String(value.data ?? '');
                const mimeType = String(value.mimeType ?? '').toLowerCase() || 'image/png';
                return data && mimeType.startsWith('image/') ? [{ data, mimeType }] : [];
            });
        const text = typeof input.text === 'string' && input.text.trim() ? input.text : null;
        const document = typeof input.data === 'string' && input.data
            ? { data: input.data, fileName: typeof input.fileName === 'string' ? input.fileName : null, mimeType: typeof input.mimeType === 'string' ? input.mimeType : null }
            : null;
        if (!images.length && !prompt && !text && !document) {
            throw bomError('AI_SOURCE_REQUIRED', 'Zeilen, Bild, Excel oder PDF des Lieferanten fehlen.');
        }
        const order = (await this.purchases.orders(tenantId, [purchaseOrderId]))[0];
        if (!order) throw bomError('PURCHASE_NOT_FOUND', 'Bestellung nicht gefunden.', { status: 404 });
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
        } catch (error) {
            const code = (error as { code?: string })?.code;
            if (code === 'AI_NOT_CONFIGURED' || code === 'GPT_NOT_CONFIGURED') {
                throw bomError('AI_NOT_CONFIGURED', 'Die KI ist nicht eingerichtet.', { status: 503 });
            }
            if (code === 'AI_SOURCE_REQUIRED' || code === 'AI_SOURCE_UNREADABLE') {
                throw bomError(code, (error as Error).message, { status: 422 });
            }
            if (code === 'AI_COLUMNS_REQUIRED') throw bomError(code, (error as Error).message);
            throw bomError('AI_FAILED', (error as Error)?.message || 'Die KI hat nicht geantwortet.', {
                status: Number((error as { status?: number })?.status) || 502,
                ...(code ? { params: { reason: code } } : {}),
            });
        }
    }
}
