import type { BomProcurementRequest } from '../../../../domain/entities/ProductionBom';
import type {
    BomPurchaseOrderRow,
    IBomGoodsInRepository,
    IBomRevisionRepository,
    IBomProcurementRepository,
    IBomProductionDirectory,
    IBomPurchaseRepository,
    IBomStockReader,
} from '../../../../domain/repositories/IProductionBomRepository';
import type { IProcurementJournal } from '../../../../domain/repositories/IProcurementJournal';
import type { ISupplierEmailBook } from '../../../../domain/repositories/ISupplierEmailBook';
import { cardEmailOf, cleanSupplierEmail } from '../../../../domain/services/supplierEmails';
import { bomError, CONFIRMED_ORDER_STATUSES, round3 } from '../../../../domain/services/productionBom';
import {
    docStateOf,
    newestFirst,
    receiptEvents,
    revisionEvents,
    stageOf,
    type ProcurementDocFacts,
    type ProcurementDocState,
    type ProcurementEvent,
    type ProcurementStage,
} from '../../../../domain/services/procurementFlow';
import type { BomPurchaseOrderWriter } from '../../../../infrastructure/services/productionBomPurchaseWriter';
import { localizePurchaseCode, PURCHASE_DOC_LANGS } from '../../../../shared/purchaseDocumentCode';
import type { BomProcurementUseCase, ProcurementRequestDto } from './BomProcurementUseCase';
import type { BomActor } from './BomTemplatesUseCase';
import type { DeviceBomsUseCase } from './DeviceBomsUseCase';
import type { BomDto } from './bomReadModel';

const PAGE_SIZE = 20;

export interface ProcurementEventDto {
    action: ProcurementEvent['action'];
    at: string;
    actorName: string | null;
    data: Record<string, unknown>;
}

export interface ProcurementFeedRow {
    id: string;
    requestNumber: string;
    kind: BomProcurementRequest['kind'];
    /**
     * Ein Preistalep, aus dem schon bestellt wurde (30.09.2026: «fiyat
     * talebinden satın almaya dönüşünce direkt labelı o oluyor») — die Liste
     * zeigt ihn als Bestellung und öffnet die Bestellung.
     */
    ordered: boolean;
    status: BomProcurementRequest['status'];
    project: { number: string; name: string } | null;
    device: { name: string; position: string | null } | null;
    bomNumber: string | null;
    deliveryDate: string | null;
    docs: Array<{ purchaseOrderId: string; code: string; kind: 'ORDER' | 'REQUEST'; state: ProcurementDocState; supplierName: string }>;
    stage: ProcurementStage;
    last: ProcurementEventDto;
}

export interface ProcurementDocView {
    purchaseOrderId: string;
    code: string;
    kind: 'ORDER' | 'REQUEST';
    state: ProcurementDocState;
    supplierId: string | null;
    supplierName: string;
    currency: string;
    totalNet: number;
    lineCount: number;
    quoteNumber: string | null;
    hasQuoteFile: boolean;
    /** Das Angebot des Lieferanten (29.09.2026: nur ein PDF zählt für den Vergleich). */
    quoteFile: { name: string; type: string | null } | null;
    /** Wann der Beleg zuletzt hinausging (30.09.2026: die Automatik sendet selbst). */
    sentAt: string | null;
    /** Die Preisanfrage, aus deren Angebot diese Bestellung entstand. */
    sourcePurchaseOrderId: string | null;
    /** Wie oft eine BOM-Revision die Bestellung geändert hat — «Revizyon 8 onayla». */
    orderRevision: number;
    /**
     * An wen der Beleg geht (30.09.2026): seine Adresse, sonst die der Karten
     * der Zeilen, sonst die der Lieferantenliste — null = keine bekannt (die
     * Seite fragt danach).
     */
    supplierEmail: string | null;
}

const fold = (value: unknown): string => String(value ?? '').toLocaleLowerCase('tr-TR');
const eventDto = (event: ProcurementEvent): ProcurementEventDto => ({
    action: event.action,
    at: event.at.toISOString(),
    actorName: event.actorName,
    data: event.data,
});

/** Wann die jüngste Revision einer Bestellung entstand. */
const latestRevisionAt = (rows: Array<{ createdAt: Date }> | undefined): Date | null =>
    (rows ?? []).reduce<Date | null>((latest, row) => (!latest || row.createdAt > latest ? row.createdAt : latest), null);

/** Ein Beleg, wie der Stand eines Talep ihn braucht. */
const factsOf = (input: {
    purchaseOrderId: string;
    kind: 'ORDER' | 'REQUEST';
    status: string;
    emailSentAt: Date | null;
    orderRevision: number;
    revisedAt?: Date | null;
    hasQuoteFile: boolean;
    quoteNumber: string | null;
    items: Array<Record<string, unknown>>;
}): ProcurementDocFacts => ({
    purchaseOrderId: input.purchaseOrderId,
    kind: input.kind,
    state: docStateOf(input),
    hasQuote: Boolean(input.quoteNumber?.trim()) && input.hasQuoteFile,
    lines: input.items.flatMap((item) => (typeof item.bomLineId === 'string' && item.bomLineId
        ? [{ bomLineId: item.bomLineId, quantity: Number(item.quantity) || 0, received: Number(item.receivedQuantity) || 0 }]
        : [])),
});

/**
 * ── SATIN ALMA · DER SCHREIBTISCH (28.09.2026, Vorgabe Samet) ───────────────
 *
 * «Oraya tıkla buraya tıkla … stepleri azaltalım; talep numarası, sipariş
 *  numarası, proje, cihaz daha net; son işlem hep gözüksün; 20'li sayfa.»
 *
 * Die Liste kommt seitenweise vom Server, jede Zeile mit ihrem Stand, dem
 * EINEN nächsten Schritt und dem letzten Handgriff. Dazu die Handgriffe, die
 * die Seite ohne Umweg macht: Preise aus dem Angebot schreiben, eine
 * bestätigte Bestellung oder verschickte Anfragen im Verlauf festhalten und
 * die Auswahl eines Preisvergleichs an die Depo-Karten geben.
 */
export class ProcurementDeskUseCase {
    constructor(
        private requests: IBomProcurementRepository,
        private goodsIn: IBomGoodsInRepository,
        private purchases: IBomPurchaseRepository,
        private journal: IProcurementJournal,
        private procurement: BomProcurementUseCase,
        private devices: DeviceBomsUseCase,
        private directory: IBomProductionDirectory,
        private stock: IBomStockReader,
        private writer: BomPurchaseOrderWriter,
        /** Die Archivzeilen revidierter Bestellungen — sie erscheinen als «revize edildi» (29.09.2026). */
        private revisions: IBomRevisionRepository | null = null,
        /** Die Lieferantenliste als Adressbuch — an wen ein Beleg ginge (30.09.2026). */
        private emails: ISupplierEmailBook | null = null,
    ) {}

    /* ── Die Liste ─────────────────────────────────────────────────────── */

    async feed(tenantId: string, actor: BomActor, query: Record<string, unknown> = {}): Promise<{
        items: ProcurementFeedRow[];
        total: number;
        page: number;
        pageSize: number;
        canProcure: boolean;
    }> {
        this.procurement.assertCanSee(actor);
        const canProcure = actor.isAdmin || actor.canProcure;
        const all = await this.requests.list(tenantId);
        if (!all.length) return { items: [], total: 0, page: 1, pageSize: PAGE_SIZE, canProcure };
        const bomIds = [...new Set(all.map((request) => request.bomId))];
        const [purchases, receipts, latest, boms, projects, devices, revised] = await Promise.all([
            this.devices.purchasesOf(tenantId, bomIds),
            this.goodsIn.forBoms(tenantId, bomIds),
            this.journal.latest(tenantId, all.map((request) => request.id)),
            this.devices.bomsByIds(tenantId, bomIds),
            this.directory.projects(tenantId, all.map((request) => request.productionProjectId)),
            this.directory.devices(tenantId, all.map((request) => request.productionItemId)),
            this.revisions ? this.revisions.purchaseRevisionsForBoms(tenantId, bomIds).catch(() => []) : Promise.resolve([]),
        ]);
        const orderFacts = new Map(purchases.map(({ order }) => [order.id, { code: order.referenceNumber, supplier: order.supplierName }]));
        const revisedByOrder = new Map<string, typeof revised>();
        for (const row of revised) revisedByOrder.set(row.purchaseOrderId, [...(revisedByOrder.get(row.purchaseOrderId) ?? []), row]);
        const docById = new Map(purchases.map((entry) => [entry.order.id, entry]));
        const bomNumber = new Map(boms.map((bom) => [bom.id, bom.bomNumber]));
        const receiptsByOrder = new Map<string, typeof receipts>();
        for (const row of receipts) {
            if (!row.purchaseOrderId) continue;
            receiptsByOrder.set(row.purchaseOrderId, [...(receiptsByOrder.get(row.purchaseOrderId) ?? []), row]);
        }

        const needle = fold(query.search).trim().slice(0, 80);
        // «Fiyat talebi hangisi, satın alma hangisi» (29.09.2026): die Liste lässt sich nach Art filtern.
        const kind = query.kind === 'PRICE' || query.kind === 'ORDER' ? query.kind : null;
        const rows = all.flatMap((request) => {
            const mine = request.purchaseOrderIds.flatMap((id) => docById.get(id) ?? []);
            // «Siparişlere girdiğimizde … siparişler çıkması lazım»: ein Preistalep mit Bestellungen zählt als Bestellung.
            const ordered = mine.some(({ link }) => link.kind === 'ORDER');
            const shownKind = request.kind === 'ORDER' || ordered ? 'ORDER' : 'PRICE';
            if (kind && shownKind !== kind) return [];
            const project = projects.get(request.productionProjectId) ?? null;
            const device = devices.get(request.productionItemId) ?? null;
            if (needle) {
                const haystack = [
                    request.requestNumber,
                    project?.projectNumber,
                    project?.projectName,
                    device?.name,
                    bomNumber.get(request.bomId),
                    ...request.lines.flatMap((line) => [line.name, line.erpCode, line.modelNumber]),
                    ...mine.flatMap(({ order }) => [order.supplierName, ...PURCHASE_DOC_LANGS.map((lang) => localizePurchaseCode(order.referenceNumber, lang))]),
                ].map(fold);
                if (!haystack.some((value) => value.includes(needle))) return [];
            }
            // Der letzte Handgriff: Verlauf, Wareneingang (auch vom Depo) oder der Talep selbst.
            const derived = request.purchaseOrderIds.flatMap((id) => [
                ...receiptEvents(receiptsByOrder.get(id) ?? []),
                ...revisionEvents(revisedByOrder.get(id) ?? [], orderFacts),
            ]);
            const created: ProcurementEvent = {
                action: 'REQUEST_CREATED',
                at: request.createdAt,
                actorId: request.createdById,
                actorName: null,
                data: { count: request.lines.length },
            };
            const stored = latest.get(request.id);
            const last = newestFirst([...(stored ? [stored] : []), ...derived, created])[0]!;
            return [{ request, mine, project, device, last, ordered }];
        });
        rows.sort((a, b) => b.last.at.getTime() - a.last.at.getTime());

        const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
        const wanted = Math.floor(Number(query.page));
        const page = Math.min(Math.max(Number.isFinite(wanted) ? wanted : 1, 1), pages);
        const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        // Abgeleitete Einträge kennen nur die Kennung — die Namen kommen nur für die Seite.
        const personIds = [...new Set(shown.flatMap((row) => (!row.last.actorName && row.last.actorId ? [row.last.actorId] : [])))];
        const [names, delivery] = await Promise.all([
            personIds.length ? this.directory.personNames(personIds) : Promise.resolve(new Map<string, string>()),
            this.directory.deliveryDates(tenantId, shown.map((row) => row.request.productionProjectId)),
        ]);

        const items = shown.map(({ request, mine, project, device, last, ordered }): ProcurementFeedRow => {
            const facts = mine.map(({ link, order }) => factsOf({
                purchaseOrderId: order.id,
                kind: link.kind,
                status: order.status,
                emailSentAt: order.emailSentAt,
                orderRevision: link.orderRevision,
                revisedAt: latestRevisionAt(revisedByOrder.get(order.id)),
                hasQuoteFile: Boolean(link.quoteFileRef),
                quoteNumber: order.quoteNumber,
                items: order.items,
            }));
            const actorName = last.actorName ?? (last.actorId ? names.get(last.actorId) ?? null : null);
            const date = delivery.get(request.productionProjectId) ?? null;
            return {
                id: request.id,
                requestNumber: request.requestNumber,
                kind: request.kind,
                ordered,
                status: request.status,
                project: project ? { number: project.projectNumber, name: project.projectName } : null,
                device: device ? { name: device.name, position: device.positionNumber } : null,
                bomNumber: bomNumber.get(request.bomId) ?? null,
                deliveryDate: date ? date.toISOString() : null,
                docs: mine.map(({ link, order }, index) => ({
                    purchaseOrderId: order.id,
                    code: order.referenceNumber,
                    kind: link.kind,
                    state: facts[index]!.state,
                    supplierName: order.supplierName,
                })),
                stage: stageOf(request, facts),
                last: eventDto({ ...last, actorName }),
            };
        });
        return { items, total: rows.length, page, pageSize: PAGE_SIZE, canProcure };
    }

    /* ── Ein Talep ─────────────────────────────────────────────────────── */

    /** Der Talep mit seiner BOM (voll), dazu Stand, Belege mit ihrem Stand und der ganze Verlauf. */
    async detail(tenantId: string, actor: BomActor, requestId: string): Promise<{
        request: ProcurementRequestDto;
        bom: BomDto;
        canProcure: boolean;
        stage: ProcurementStage;
        docs: ProcurementDocView[];
        history: ProcurementEventDto[];
    }> {
        const base = await this.procurement.get(tenantId, actor, requestId);
        const purchaseById = new Map(base.bom.purchases.map((purchase) => [purchase.purchaseOrderId, purchase]));
        const revised = base.bom.purchases.some((purchase) => purchase.orderRevision > 0) && this.revisions
            ? await this.revisions.purchaseRevisionsForBoms(tenantId, [base.bom.id]).catch(() => [])
            : [];
        const recipients = base.canProcure ? await this.recipientsOf(tenantId, requestId, base.request.documents) : new Map<string, string | null>();
        const docs = base.request.documents.map((doc): { view: ProcurementDocView; facts: ProcurementDocFacts } => {
            const purchase = purchaseById.get(doc.purchaseOrderId);
            const items = (purchase?.lines ?? []).map((line) => ({
                bomLineId: line.bomLineId,
                quantity: line.quantity,
                receivedQuantity: line.received,
                grossPrice: line.grossPrice,
                netPrice: line.netPrice,
            }));
            const facts = factsOf({
                purchaseOrderId: doc.purchaseOrderId,
                kind: doc.kind,
                status: doc.status,
                emailSentAt: purchase?.emailSentAt ? new Date(purchase.emailSentAt) : null,
                orderRevision: purchase?.orderRevision ?? 0,
                revisedAt: latestRevisionAt(revised.filter((row) => row.purchaseOrderId === doc.purchaseOrderId)),
                hasQuoteFile: Boolean(purchase?.quoteFile),
                quoteNumber: purchase?.quoteNumber ?? null,
                items,
            });
            return {
                facts,
                view: {
                    purchaseOrderId: doc.purchaseOrderId,
                    code: doc.referenceNumber,
                    kind: doc.kind,
                    state: facts.state,
                    supplierId: doc.supplierId,
                    supplierName: doc.supplierName,
                    currency: doc.currency,
                    totalNet: doc.totalNet,
                    lineCount: purchase?.lineCount ?? items.length,
                    quoteNumber: purchase?.quoteNumber ?? null,
                    hasQuoteFile: Boolean(purchase?.quoteFile),
                    quoteFile: purchase?.quoteFile ? { name: purchase.quoteFile.name, type: purchase.quoteFile.type } : null,
                    sentAt: purchase?.emailSentAt ?? null,
                    sourcePurchaseOrderId: purchase?.sourcePurchaseOrderId ?? null,
                    orderRevision: purchase?.orderRevision ?? 0,
                    supplierEmail: recipients.get(doc.purchaseOrderId) ?? null,
                },
            };
        });

        const codes = new Map(base.request.documents.map((doc) => [doc.referenceNumber, doc.purchaseOrderId]));
        const receipts = receiptEvents(base.bom.goodsIn.flatMap((row) => {
            const purchaseOrderId = row.referenceNumber ? codes.get(row.referenceNumber) : undefined;
            return purchaseOrderId
                ? [{ receiptId: row.receiptId, purchaseOrderId, referenceNumber: row.referenceNumber, receivedAt: new Date(row.receivedAt), receivedByName: row.receivedByName }]
                : [];
        }));
        const created: ProcurementEvent = {
            action: 'REQUEST_CREATED',
            at: new Date(base.request.createdAt),
            actorName: base.request.createdByName,
            data: { count: base.request.lines.length },
        };
        const stored = await this.journal.forRequest(tenantId, requestId);
        return {
            ...base,
            stage: stageOf(base.request, docs.map((doc) => doc.facts)),
            docs: docs.map((doc) => doc.view),
            history: newestFirst([...stored, ...receipts, created]).map(eventDto),
        };
    }

    /**
     * An wen jeder Beleg des Talep ginge — dieselbe Reihenfolge wie beim Senden
     * (ProcurementDispatchUseCase): die Adresse des Belegs, die der Karten der
     * Zeilen (Preisanfrage), die der Lieferantenliste.
     */
    private async recipientsOf(
        tenantId: string,
        requestId: string,
        documents: Array<{ purchaseOrderId: string; kind: 'ORDER' | 'REQUEST'; supplierId: string | null; supplierName: string }>,
    ): Promise<Map<string, string | null>> {
        const result = new Map<string, string | null>();
        if (!documents.length) return result;
        try {
            const [rows, request] = await Promise.all([
                this.purchases.orders(tenantId, documents.map((doc) => doc.purchaseOrderId)),
                this.requests.get(tenantId, requestId),
            ]);
            const productIds = request?.lines.map((line) => line.productId) ?? [];
            const products = productIds.length ? await this.stock.products(tenantId, productIds) : new Map();
            for (const doc of documents) {
                const row = rows.find((entry) => entry.id === doc.purchaseOrderId);
                const supplier = { supplierId: row?.supplierId ?? doc.supplierId, supplierName: row?.supplierName ?? doc.supplierName };
                let email = cleanSupplierEmail(row?.supplierEmail);
                if (!email && doc.kind === 'REQUEST') email = cardEmailOf(supplier, productIds, products);
                if (!email && this.emails) email = await this.emails.emailOf(tenantId, { supplierId: supplier.supplierId, name: supplier.supplierName });
                result.set(doc.purchaseOrderId, email);
            }
        } catch (error) {
            console.warn('[satın alma] Empfänger nicht gelesen:', requestId, (error as Error)?.message);
        }
        return result;
    }

    /* ── Handgriffe ────────────────────────────────────────────────────── */

    /**
     * Was die Seite selbst erledigt hat (Status über den Bestellweg, Mail mit
     * dem PDF aus dem Browser), hier geprüft und im Verlauf festgehalten:
     * `ORDER_CONFIRMED` (bestätigte Bestellungen) oder `PRICE_REQUESTS_SENT`.
     */
    async report(tenantId: string, actor: BomActor, requestId: string, body: unknown): Promise<{ ok: true }> {
        this.procurement.assertCanProcure(actor);
        const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const action = String(input.action ?? '');
        if (action !== 'ORDER_CONFIRMED' && action !== 'PRICE_REQUESTS_SENT') {
            throw bomError('NOT_FOUND', 'Unbekannte Meldung.', { status: 404 });
        }
        const request = await this.requireRequest(tenantId, requestId);
        const wanted = new Set((Array.isArray(input.purchaseOrderIds) ? input.purchaseOrderIds : []).map(String));
        const mine = (await this.devices.purchasesOf(tenantId, [request.bomId]))
            .filter(({ order }) => wanted.has(order.id) && request.purchaseOrderIds.includes(order.id));
        const note = (data: Record<string, unknown>) => this.journal.record(tenantId, {
            requestId: request.id,
            requestNumber: request.requestNumber,
            action: action as 'ORDER_CONFIRMED' | 'PRICE_REQUESTS_SENT',
            actorId: actor.id,
            actorName: actor.name,
            data,
        });
        if (action === 'ORDER_CONFIRMED') {
            const confirmed = mine.filter(({ link, order }) => link.kind === 'ORDER' && CONFIRMED_ORDER_STATUSES.has(String(order.status).toUpperCase()));
            if (!confirmed.length) throw bomError('REQUEST_MISMATCH', 'Keine bestätigte Bestellung dieses Talep.', { status: 409 });
            for (const { order } of confirmed) {
                await note({ code: order.referenceNumber, supplier: order.supplierName, quoteNumber: order.quoteNumber, mailed: input.mailed === true });
            }
        } else {
            const sent = mine.filter(({ link, order }) => link.kind === 'REQUEST' && (order.emailSentAt || String(order.status).toUpperCase() === 'PRICE_REQUEST'));
            if (!sent.length) throw bomError('REQUEST_MISMATCH', 'Keine verschickte Preisanfrage dieses Talep.', { status: 409 });
            await note({ codes: sent.map(({ order }) => order.referenceNumber), suppliers: sent.map(({ order }) => order.supplierName) });
        }
        return { ok: true };
    }

    /**
     * `prices: [{ index, unitPrice }]` — die Stückpreise aus dem Angebot bzw.
     * der Antwort des Lieferanten (`index` = Stelle in `PurchaseOrder.items`).
     * Eine bestätigte Bestellung behält ihre Preise.
     */
    async setPrices(tenantId: string, actor: BomActor, purchaseOrderId: string, body: unknown): Promise<{ ok: true }> {
        this.procurement.assertCanProcure(actor);
        const link = await this.purchases.linkForOrder(tenantId, purchaseOrderId);
        const order = link ? (await this.purchases.orders(tenantId, [purchaseOrderId]))[0] : undefined;
        if (!link || !order) throw bomError('PURCHASE_NOT_FOUND', 'Diese Bestellung stammt aus keiner BOM.', { status: 404 });
        if (link.kind === 'ORDER' && CONFIRMED_ORDER_STATUSES.has(String(order.status).toUpperCase())) {
            throw bomError('STATUS_INVALID', 'Eine bestätigte Bestellung behält ihre Preise.', { status: 409 });
        }
        const raw = (body as Record<string, unknown> | null)?.prices;
        const seen = new Set<number>();
        const prices = (Array.isArray(raw) ? raw : []).slice(0, 500).flatMap((entry) => {
            const value = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
            const index = Number(value.index);
            const unitPrice = Number(String(value.unitPrice ?? '').replace(',', '.'));
            if (!Number.isInteger(index) || index < 0 || index >= order.items.length || seen.has(index)) return [];
            if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1e9) return [];
            seen.add(index);
            return [{ index, unitPrice }];
        });
        if (!prices.length) throw bomError('PRICES_REQUIRED', 'Keine Preise erhalten.');
        const ok = await this.writer.setPrices(tenantId, actor.id, purchaseOrderId, prices);
        if (!ok) throw bomError('PURCHASE_NOT_FOUND', 'Bestellung nicht gefunden.', { status: 404 });
        if (link.kind === 'REQUEST') {
            const request = (await this.requests.list(tenantId, { bomIds: [link.bomId] }))
                .find((entry) => entry.purchaseOrderIds.includes(purchaseOrderId));
            if (request) {
                await this.journal.record(tenantId, {
                    requestId: request.id,
                    requestNumber: request.requestNumber,
                    action: 'REPLY_ADDED',
                    actorId: actor.id,
                    actorName: actor.name,
                    data: { code: order.referenceNumber, supplier: order.supplierName, count: prices.filter((price) => price.unitPrice > 0).length },
                });
            }
        }
        return { ok: true };
    }

    /**
     * «Seçimi kaydet»: `lines: [{ bomLineId, purchaseOrderId }]` — je Zeile die
     * gewählte Antwort. Ihr Lieferant wird der erste der Depo-Karte, ihr Preis
     * der Alışpreis; so kommt die spätere Bestellung mit beidem. Der Talep ist
     * damit erledigt.
     */
    async saveSelection(tenantId: string, actor: BomActor, requestId: string, body: unknown): Promise<{ ok: true }> {
        this.procurement.assertCanProcure(actor);
        const request = await this.requireRequest(tenantId, requestId);
        if (request.kind !== 'PRICE') throw bomError('KIND_INVALID', 'Nur ein Preistalep hat eine Auswahl.', { status: 409 });
        if (request.status === 'CANCELLED') throw bomError('STATUS_INVALID', 'Der Talep ist verworfen.', { status: 409 });
        const orders = new Map((await this.devices.purchasesOf(tenantId, [request.bomId]))
            .filter(({ link, order }) => link.kind === 'REQUEST' && request.purchaseOrderIds.includes(order.id))
            .map(({ order }) => [order.id, order] as const));
        const lines = new Map(request.lines.map((line) => [line.bomLineId, line]));
        const seen = new Set<string>();
        const picks: Array<{ line: BomProcurementRequest['lines'][number]; order: BomPurchaseOrderRow; price: number }> = [];
        for (const entry of Array.isArray((body as Record<string, unknown> | null)?.lines) ? (body as { lines: unknown[] }).lines : []) {
            const value = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
            const line = lines.get(String(value.bomLineId ?? ''));
            const order = orders.get(String(value.purchaseOrderId ?? ''));
            if (!line || !order || seen.has(line.bomLineId)) throw bomError('LINE_INVALID', 'Diese Auswahl gehört nicht zum Talep.');
            const item = order.items.find((candidate) => candidate.bomLineId === line.bomLineId);
            const price = Number(item?.grossPrice) || Number(item?.netPrice) || 0;
            if (price <= 0) throw bomError('PRICE_MISSING', 'Für diese Zeile hat der Lieferant keinen Preis genannt.', { params: { code: order.referenceNumber } });
            seen.add(line.bomLineId);
            picks.push({ line, order, price });
        }
        if (!picks.length) throw bomError('REQUEST_EMPTY', 'Keine Zeile gewählt.');
        for (const { line, order, price } of picks) {
            await this.stock.preferSupplier(tenantId, line.productId, { supplierId: order.supplierId, name: order.supplierName }, price, order.currency);
        }
        await this.requests.update(tenantId, request.id, { status: 'DONE', closedById: actor.id, closedAt: new Date() });
        await this.journal.record(tenantId, {
            requestId: request.id,
            requestNumber: request.requestNumber,
            action: 'SELECTION_SAVED',
            actorId: actor.id,
            actorName: actor.name,
            data: {
                suppliers: [...new Set(picks.map(({ order }) => order.supplierName))],
                count: picks.length,
                total: round3(picks.reduce((sum, { line, price }) => sum + price * line.quantity, 0)),
                currency: picks[0]!.order.currency,
            },
        });
        return { ok: true };
    }

    private async requireRequest(tenantId: string, id: string): Promise<BomProcurementRequest> {
        const request = await this.requests.get(tenantId, id);
        if (!request) throw bomError('REQUEST_NOT_FOUND', 'Talep nicht gefunden.', { status: 404 });
        return request;
    }
}
