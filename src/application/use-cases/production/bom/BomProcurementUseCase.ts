import type {
    Bom,
    BomGoodsIn,
    BomProcurementLine,
    BomProcurementRequest,
    BomProcurementStatus,
} from '../../../../domain/entities/ProductionBom';
import type {
    BomPurchaseOrderRow,
    IBomGoodsInRepository,
    IBomProcurementRepository,
    IBomProductionDirectory,
    IBomPurchaseRepository,
    IBomStockReader,
} from '../../../../domain/repositories/IProductionBomRepository';
import type { IProcurementJournal } from '../../../../domain/repositories/IProcurementJournal';
import { bomError, CONFIRMED_ORDER_STATUSES, round3 } from '../../../../domain/services/productionBom';
import type { ProcurementEventAction } from '../../../../domain/services/procurementFlow';
import {
    priceRequestedLineIds,
    procurementKindFrom,
    procurementLinesFrom,
    procurementProgress,
    procurementStatusAfter,
    type ProcurementDocFact,
    type ProcurementProgress,
} from '../../../../domain/services/productionBomProcurement';
import type { BomReservationService } from './BomReservationService';
import type { BomActivityDto } from './bomReadModel';
import type { BomActor } from './BomTemplatesUseCase';
import type { DeviceBomsUseCase } from './DeviceBomsUseCase';
import type { BomDto } from './bomReadModel';

const EPS = 1e-9;
const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/** Ein Beleg des Einkaufs, wie «Satın alma» ihn zeigt (MIT Lieferant und Betrag). */
export interface ProcurementDocumentDto {
    purchaseOrderId: string;
    referenceNumber: string;
    /** REQUEST = Preisanfrage, ORDER = Bestellung. */
    kind: 'ORDER' | 'REQUEST';
    status: string;
    supplierId: string | null;
    supplierName: string;
    currency: string;
    totalNet: number;
    confirmed: boolean;
    /** Anteil der gelieferten Menge (0 … 1). */
    received: number;
    createdAt: string;
    updatedAt: string;
}

export interface ProcurementRequestDto {
    id: string;
    requestNumber: string;
    kind: BomProcurementRequest['kind'];
    status: BomProcurementStatus;
    note: string | null;
    bomRevision: number;
    createdAt: string;
    createdByName: string | null;
    closedAt: string | null;
    closedByName: string | null;
    /** Letzter Handgriff an Talep ODER einem seiner Belege — neu/bearbeitet steht oben (28.09.2026). */
    lastActivityAt: string;
    bom: { id: string; bomNumber: string; kind: Bom['kind']; status: Bom['status']; area: Bom['area']; revision: number; templateName: string; consumed: boolean } | null;
    project: { id: string; projectNumber: string; projectName: string; customerName: string | null; deliveryDate: string | null } | null;
    device: { id: string; name: string; positionNumber: string | null } | null;
    lines: Array<BomProcurementLine & {
        /** Steht in einem Beleg der passenden Art (PRICE → Preisanfrage, ORDER → Bestellung). */
        covered: boolean;
        /** Was der Zeile JETZT fehlt (nur freigegebene BOM) — null = unbekannt. */
        missingNow: number | null;
    }>;
    progress: ProcurementProgress;
    documents: ProcurementDocumentDto[];
}

/** Der Talep, wie die BOM ihn sieht — OHNE Lieferant und Preis (nur der Weg). */
export interface BomProcurementSummaryDto {
    id: string;
    requestNumber: string;
    kind: BomProcurementRequest['kind'];
    status: BomProcurementStatus;
    bomRevision: number;
    createdAt: string;
    createdByName: string | null;
    note: string | null;
    lines: Array<{ bomLineId: string; quantity: number }>;
    progress: ProcurementProgress;
}

/** Eingegangene Ware an einer BOM (Gelen mallar). */
export interface BomGoodsInDto {
    id: string;
    receiptId: string;
    source: BomGoodsIn['source'];
    referenceNumber: string | null;
    lineId: string | null;
    productId: string;
    erpCode: string | null;
    name: string;
    quantity: number;
    serials: string[];
    receivedAt: string;
    receivedByName: string | null;
}

const OPEN_STATUSES = new Set<BomProcurementStatus>(['OPEN', 'IN_PROGRESS']);

const lineIdsOf = (order: BomPurchaseOrderRow): Set<string> =>
    new Set(order.items.map((item) => (typeof item.bomLineId === 'string' ? item.bomLineId : '')).filter(Boolean));

/** Anteil der gelieferten Menge einer Bestellung. */
const receivedShare = (order: BomPurchaseOrderRow): number => {
    let ordered = 0;
    let received = 0;
    for (const item of order.items) {
        ordered += Math.max(0, Number(item.quantity) || 0);
        received += Math.max(0, Number(item.receivedQuantity) || 0);
    }
    return ordered > EPS ? Math.min(1, round3(received / ordered)) : 0;
};

const docDto = (kind: 'ORDER' | 'REQUEST', order: BomPurchaseOrderRow): ProcurementDocumentDto => {
    const status = String(order.status).toUpperCase();
    return {
        purchaseOrderId: order.id,
        referenceNumber: order.referenceNumber,
        kind,
        status,
        supplierId: order.supplierId,
        supplierName: order.supplierName,
        currency: order.currency,
        totalNet: order.totalNet,
        confirmed: kind === 'ORDER' && CONFIRMED_ORDER_STATUSES.has(status),
        received: receivedShare(order),
        createdAt: order.createdAt.toISOString(),
        updatedAt: (order.updatedAt ?? order.createdAt).toISOString(),
    };
};

/**
 * ── SATIN ALMA (27.09.2026 abends, Vorgabe Samet) ────────────────────────────
 *
 * «Fiyat talepleri ve siparişleri muhasebe ve yöneticiler yapacak ve o
 *  ekranları o görmeliler … bom'da sadece sipariş ve fiyat talep istekleri
 *  oluşsun, revizyonlar yapılsın ama tedarikçi ve fiyatlar gözükmesin,
 *  başka bir sayfada talep olarak gelsin … o harcamalar ve tedarikçileri
 *  oradan takip edelim.»
 *
 * Zwei Seiten desselben Talep:
 *   · die BOM (wer die Stufe BOM bearbeitet) stellt ihn — PRICE im Entwurf
 *     (oder in einer Revision im Entwurf), ORDER aus der freigegebenen BOM
 *     für das, was fehlt — und kann einen noch unberührten zurückziehen;
 *   · der Einkauf (Buchhaltung, Administratorrolle: Seite «Satın alma»)
 *     macht Preisanfragen und Bestellungen daraus (DeviceBomsUseCase,
 *     `procurementRequestId`) und schliesst sie. Die Liste, der Stand und
 *     der Verlauf stehen seit dem 28.09.2026 im ProcurementDeskUseCase.
 */
export class BomProcurementUseCase {
    constructor(
        private requests: IBomProcurementRepository,
        private goodsIn: IBomGoodsInRepository,
        private purchases: IBomPurchaseRepository,
        private stock: IBomStockReader,
        private directory: IBomProductionDirectory,
        private reservations: BomReservationService,
        private devices: DeviceBomsUseCase,
        private journal: IProcurementJournal | null = null,
    ) {}

    /** Eine Spur im Verlauf («son işlem») — sie hält die Handlung nie auf. */
    private async note(
        tenantId: string,
        actor: BomActor | null,
        request: BomProcurementRequest,
        action: ProcurementEventAction,
        data: Record<string, unknown> = {},
    ): Promise<void> {
        if (!this.journal) return;
        await this.journal.record(tenantId, {
            requestId: request.id,
            requestNumber: request.requestNumber,
            action,
            actorId: actor?.id ?? null,
            actorName: actor?.name ?? null,
            data,
        }).catch((error: unknown) => console.warn('[satın alma] Verlauf nicht geschrieben:', (error as Error)?.message));
    }

    /** Den Einkauf sehen: Administratorrolle oder Seite «Satın alma» (Stufe 1). */
    assertCanSee(actor: BomActor): void {
        if (actor.isAdmin || actor.canSeeProcurement) return;
        throw bomError('FORBIDDEN', 'Den Einkauf sehen nur Buchhaltung und Administratorrolle.', { status: 403 });
    }

    /** Im Einkauf handeln: Administratorrolle oder Seite «Satın alma» Stufe 2. */
    assertCanProcure(actor: BomActor): void {
        if (actor.isAdmin || actor.canProcure) return;
        throw bomError('FORBIDDEN', 'Preisanfragen und Bestellungen macht die Buchhaltung.', { status: 403 });
    }

    /* ── Die BOM stellt einen Talep ────────────────────────────────────── */

    /**
     * `{ kind: 'PRICE' | 'ORDER', lines: [{ lineId, quantity, note }], note }`.
     * PRICE nur im Entwurf (auch in einer Revision im Entwurf) — «bom
     * onaylandıktan sonra fiyat talebi alınamaz» —, ORDER nur aus der
     * freigegebenen BOM und nie unter dem, was fehlt. Eine Zeile, die schon in
     * einem offenen Talep derselben Art steht, kommt nicht in einen zweiten.
     */
    async createFromBom(tenantId: string, actor: BomActor, bomId: string, body: unknown): Promise<{ request: BomProcurementSummaryDto; bom: BomDto }> {
        const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const kind = procurementKindFrom(input.kind);
        if (!kind) throw bomError('KIND_INVALID', 'PRICE oder ORDER.');
        /* «Bomda artık sipariş talebi yok, sadece fiyat talebi var» (Samet,
           30.09.2026): bestellt wird aus dem Fiyat talebi (Vergleich → Bestellung). */
        if (kind !== 'PRICE') throw bomError('ORDER_REQUEST_RETIRED', 'Die BOM stellt nur noch Fiyat talepleri.', { status: 409 });
        const bom = await this.devices.requireBom(tenantId, bomId);
        await this.devices.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        if (bom.consumedAt) throw bomError('STATUS_INVALID', 'Die BOM ist abgebucht.', { status: 409 });
        /* «BOM liste onaylanmadan fiyat talep edilemesin» (Samet, 30.09.2026): angefragt
           wird aus der freigegebenen BOM — und aus ihren freigegebenen Zeilen, nicht aus
           einer Revision im Entwurf (die gibt erst die Administratorrolle frei). */
        if (bom.status !== 'APPROVED') {
            throw bomError('BOM_NOT_APPROVED', 'Preisanfragen gibt es nur aus einer freigegebenen BOM.', {
                status: 409,
                params: { bom: bom.bomNumber ?? '' },
            });
        }

        const all = await this.requests.list(tenantId, { bomIds: [bom.id] });
        const lines: Bom['lines'] = bom.lines;
        const revision = bom.revision;
        const asked = priceRequestedLineIds(all);
        const allowed = new Map<string, number>();
        for (const line of lines) if (!asked.has(line.id) && line.quantity > EPS) allowed.set(line.id, 0);
        if (!lines.length) throw bomError('REQUEST_EMPTY', 'Die BOM hat keine Zeilen.');
        const picked = procurementLinesFrom(input.lines, allowed);
        const byId = new Map(lines.map((line) => [line.id, line]));
        const products = await this.stock.products(tenantId, picked.map((entry) => byId.get(entry.lineId)!.productId));
        const note = String(input.note ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000) || null;
        const request = await this.requests.create(tenantId, {
            bomId: bom.id,
            productionProjectId: bom.productionProjectId,
            productionItemId: bom.productionItemId,
            area: bom.area,
            kind,
            bomRevision: revision,
            note,
            lines: picked.map((entry) => {
                const line = byId.get(entry.lineId)!;
                const product = products.get(line.productId);
                return {
                    bomLineId: line.id,
                    productId: line.productId,
                    erpCode: product?.erpCode ?? line.erpCode,
                    name: product?.name ?? line.name,
                    brand: product?.brand ?? line.brand,
                    modelNumber: product?.modelNumber ?? line.modelNumber,
                    unit: line.unit,
                    quantity: entry.quantity,
                    note: entry.note,
                };
            }),
        }, actor.id);
        const [dto] = await this.summaries(tenantId, [request], [], new Map([[actor.id, actor.name ?? '']]));
        /* «Fiyat talepleri artık otomatik gönderiliyor» (30.09.2026): je Lieferant
           der Karten eine Preisanfrage, als PDF aus dem Postfach der Produktion —
           im Hintergrund; die BOM wartet nicht darauf und sieht keinen Lieferanten. */
        this.onRequestCreated?.(tenantId, request.id, actor);
        return { request: dto!, bom: await this.devices.get(tenantId, bom.id) };
    }

    /** Die Automatik des Einkaufs (ProcurementAutomationUseCase) — nach dem Bau angeschlossen. */
    private onRequestCreated: ((tenantId: string, requestId: string, actor: BomActor) => void) | null = null;

    attachAutomation(listener: (tenantId: string, requestId: string, actor: BomActor) => void): void {
        this.onRequestCreated = listener;
    }

    /** Die BOM zieht einen Talep zurück, solange der Einkauf nichts daraus gemacht hat. */
    async cancelFromBom(tenantId: string, actor: BomActor, requestId: string): Promise<{ bom: BomDto }> {
        const request = await this.requireRequest(tenantId, requestId);
        const bom = await this.devices.requireBom(tenantId, request.bomId);
        await this.devices.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        if (request.status !== 'OPEN' || request.purchaseOrderIds.length) {
            throw bomError('REQUEST_IN_PROGRESS', 'Der Einkauf arbeitet schon daran — zurückziehen geht nicht mehr.', { status: 409 });
        }
        await this.requests.update(tenantId, request.id, { status: 'CANCELLED', closedById: actor.id, closedAt: new Date() });
        await this.note(tenantId, actor, request, 'REQUEST_WITHDRAWN');
        return { bom: await this.devices.get(tenantId, bom.id) };
    }

    /* ── Was die BOM vom Talep und vom Wareneingang sieht ───────────────── */

    /** Counters and per-line facts used by the material list; no receipt serials or document details. */
    async activityForBoms(tenantId: string, bomIds: string[]) {
        type Activity = Pick<BomActivityDto, 'requestsCount' | 'goodsCount' | 'priceRequests' | 'received'>;
        const result = new Map<string, Activity>(bomIds.map((id) => [id, { requestsCount: 0, goodsCount: 0, priceRequests: {}, received: {} }]));
        const tolerant = <T>(promise: Promise<T[]>): Promise<T[]> => promise.catch((error: unknown) => {
            if (/doesn't exist|does not exist|P2021/i.test((error as Error)?.message ?? '')) return [];
            throw error;
        });
        const [requests, goods] = await Promise.all([
            tolerant(this.requests.activityForBoms(tenantId, bomIds)),
            tolerant(this.goodsIn.totalsForBoms(tenantId, bomIds)),
        ]);
        for (const request of requests) {
            const entry = result.get(request.bomId);
            if (!entry) continue;
            entry.requestsCount++;
            if (request.kind === 'PRICE' && request.status !== 'CANCELLED') {
                for (const id of request.lineIds) entry.priceRequests[id] ??= request.requestNumber;
            }
        }
        for (const goodsRow of goods) {
            const entry = result.get(goodsRow.bomId);
            if (!entry) continue;
            entry.goodsCount += goodsRow.count;
            if (goodsRow.lineId) entry.received[goodsRow.lineId] = (entry.received[goodsRow.lineId] ?? 0) + goodsRow.quantity;
        }
        return result;
    }

    /** Talepler und eingegangene Ware der BOMs — für die DTOs der BOM (ohne Lieferant, ohne Preis). */
    async forBoms(
        tenantId: string,
        bomIds: string[],
        docs: Array<{ kind: 'ORDER' | 'REQUEST'; order: BomPurchaseOrderRow }>,
        options: { section?: 'requests' | 'goods'; compact?: boolean } = {},
    ): Promise<{ requests: Map<string, BomProcurementSummaryDto[]>; goodsIn: Map<string, BomGoodsInDto[]> }> {
        // Solange die Tabellen fehlen (Migration noch nicht aufgespielt), bleibt die BOM lesbar.
        const tolerant = <T>(promise: Promise<T[]>): Promise<T[]> => promise.catch((error: unknown) => {
            if (/doesn't exist|does not exist|P2021/i.test((error as Error)?.message ?? '')) return [];
            throw error;
        });
        const [requests, goods] = await Promise.all([
            options.section === 'goods' ? Promise.resolve([]) : tolerant(this.requests.list(tenantId, { bomIds })),
            options.section === 'requests' ? Promise.resolve([]) : tolerant(this.goodsIn.forBoms(tenantId, bomIds)),
        ]);
        const personIds = [...new Set([
            ...requests.map((entry) => entry.createdById),
            ...goods.map((entry) => entry.receivedById),
        ].filter((id): id is string => Boolean(id)))];
        const names = personIds.length && !options.compact ? await this.directory.personNames(personIds) : new Map<string, string>();
        const summaries = await this.summaries(tenantId, requests, docs, names);
        const byBom = new Map<string, BomProcurementSummaryDto[]>();
        requests.forEach((request, index) => {
            const list = byBom.get(request.bomId) ?? [];
            list.push(summaries[index]!);
            byBom.set(request.bomId, list);
        });
        const goodsByBom = new Map<string, BomGoodsInDto[]>();
        for (const entry of goods) {
            if (!entry.bomId) continue;
            const list = goodsByBom.get(entry.bomId) ?? [];
            list.push({
                id: entry.id,
                receiptId: entry.receiptId,
                source: entry.source,
                referenceNumber: entry.referenceNumber,
                lineId: entry.lineId,
                productId: entry.productId,
                erpCode: entry.erpCode,
                name: entry.name,
                quantity: entry.quantity,
                serials: entry.serials,
                receivedAt: entry.receivedAt.toISOString(),
                receivedByName: entry.receivedById ? names.get(entry.receivedById) ?? null : null,
            });
            goodsByBom.set(entry.bomId, list);
        }
        return { requests: byBom, goodsIn: goodsByBom };
    }

    private async summaries(
        _tenantId: string,
        requests: BomProcurementRequest[],
        docs: Array<{ kind: 'ORDER' | 'REQUEST'; order: BomPurchaseOrderRow }>,
        names: Map<string, string>,
    ): Promise<BomProcurementSummaryDto[]> {
        const facts: ProcurementDocFact[] = docs.map(({ kind, order }) => ({
            purchaseOrderId: order.id,
            kind,
            confirmed: kind === 'ORDER' && CONFIRMED_ORDER_STATUSES.has(String(order.status).toUpperCase()),
            lineIds: lineIdsOf(order),
        }));
        return requests.map((request) => ({
            id: request.id,
            requestNumber: request.requestNumber,
            kind: request.kind,
            status: request.status,
            bomRevision: request.bomRevision,
            createdAt: request.createdAt.toISOString(),
            createdByName: request.createdById ? names.get(request.createdById) || null : null,
            note: request.note,
            lines: request.lines.map((line) => ({ bomLineId: line.bomLineId, quantity: line.quantity })),
            progress: procurementProgress(request, facts),
        }));
    }

    /* ── Der Einkauf: «Satın alma» ─────────────────────────────────────── */

    /** Ein Talep mit seiner BOM (VOLL — mit Lieferanten und Preisen, für die Assistenten). */
    async get(tenantId: string, actor: BomActor, requestId: string): Promise<{
        request: ProcurementRequestDto;
        bom: BomDto;
        canProcure: boolean;
    }> {
        this.assertCanSee(actor);
        const request = await this.requireRequest(tenantId, requestId);
        const [[dto], bom] = await Promise.all([
            this.dtos(tenantId, [request]),
            this.devices.get(tenantId, request.bomId),
        ]);
        return { request: dto!, bom, canProcure: actor.isAdmin || actor.canProcure };
    }

    /** `close` (erledigt) · `reopen` · `cancel` (verwerfen) — nur der Einkauf. */
    async setStatus(tenantId: string, actor: BomActor, requestId: string, action: string): Promise<{ request: ProcurementRequestDto }> {
        this.assertCanProcure(actor);
        const request = await this.requireRequest(tenantId, requestId);
        if (action === 'close') {
            if (request.status === 'CANCELLED') throw bomError('STATUS_INVALID', 'Ein verworfener Talep bleibt verworfen.', { status: 409 });
            await this.requests.update(tenantId, request.id, { status: 'DONE', closedById: actor.id, closedAt: new Date() });
            await this.note(tenantId, actor, request, 'REQUEST_CLOSED');
        } else if (action === 'cancel') {
            if (request.status === 'DONE') throw bomError('STATUS_INVALID', 'Ein erledigter Talep wird nicht verworfen.', { status: 409 });
            await this.requests.update(tenantId, request.id, { status: 'CANCELLED', closedById: actor.id, closedAt: new Date() });
            await this.note(tenantId, actor, request, 'REQUEST_CANCELLED');
        } else if (action === 'reopen') {
            const docs = await this.docFacts(tenantId, [request.bomId]);
            const status = procurementStatusAfter('OPEN', procurementProgress(request, docs), request.kind);
            await this.requests.update(tenantId, request.id, { status: status === 'DONE' ? 'IN_PROGRESS' : status, closedById: null, closedAt: null });
            await this.note(tenantId, actor, request, 'REQUEST_REOPENED');
        } else {
            throw bomError('NOT_FOUND', 'Unbekannte Handlung.', { status: 404 });
        }
        const [dto] = await this.dtos(tenantId, [(await this.requireRequest(tenantId, request.id))]);
        return { request: dto! };
    }

    /**
     * Die Belege, die aus einem Talep entstanden (Assistent «Sipariş oluştur»
     * / «Fiyat talebi» mit `procurementRequestId`): an den Talep hängen und
     * seinen Stand nachziehen — alle Zeilen in einem Beleg = erledigt.
     */
    async attachDocuments(
        tenantId: string,
        requestId: string,
        bomId: string,
        purchaseOrderIds: string[],
        actor: BomActor | null = null,
        /** Bestellungen aus dem Vergleich eines Preistalep (30.09.2026) — sonst die Art des Talep. */
        documentKind: 'ORDER' | 'REQUEST' | null = null,
    ): Promise<void> {
        const request = await this.requests.get(tenantId, requestId);
        if (!request || request.bomId !== bomId || !purchaseOrderIds.length) return;
        const ids = [...new Set([...request.purchaseOrderIds, ...purchaseOrderIds])];
        const docs = await this.docFacts(tenantId, [bomId]);
        const status = procurementStatusAfter(request.status, procurementProgress({ ...request, purchaseOrderIds: ids }, docs), request.kind);
        await this.requests.update(tenantId, request.id, { purchaseOrderIds: ids, status });
        const orders = await this.purchases.orders(tenantId, purchaseOrderIds);
        const kind = documentKind ?? (request.kind === 'PRICE' ? 'REQUEST' : 'ORDER');
        await this.note(tenantId, actor, request, kind === 'REQUEST' ? 'PRICE_REQUESTS_CREATED' : 'ORDERS_CREATED', {
            codes: orders.map((order) => order.referenceNumber),
        });
    }

    /** Ein Talep, aus dem der Einkauf gerade Belege macht: er muss zur BOM gehören und offen sein. */
    async assertUsable(tenantId: string, requestId: string, bomId: string, kind: 'PRICE' | 'ORDER'): Promise<BomProcurementRequest> {
        const request = await this.requireRequest(tenantId, requestId);
        if (request.bomId !== bomId || request.kind !== kind) {
            throw bomError('REQUEST_MISMATCH', 'Der Talep gehört nicht zu diesem Vorgang.', { status: 409 });
        }
        if (request.status === 'CANCELLED') throw bomError('STATUS_INVALID', 'Der Talep ist verworfen.', { status: 409 });
        return request;
    }

    /* ── Hilfen ────────────────────────────────────────────────────────── */

    private async requireRequest(tenantId: string, id: string): Promise<BomProcurementRequest> {
        const request = await this.requests.get(tenantId, id);
        if (!request) throw bomError('REQUEST_NOT_FOUND', 'Talep nicht gefunden.', { status: 404 });
        return request;
    }

    private async docFacts(tenantId: string, bomIds: string[]): Promise<ProcurementDocFact[]> {
        const purchases = await this.devices.purchasesOf(tenantId, bomIds);
        return purchases.map(({ link, order }) => ({
            purchaseOrderId: order.id,
            kind: link.kind,
            confirmed: link.kind === 'ORDER' && CONFIRMED_ORDER_STATUSES.has(String(order.status).toUpperCase()),
            lineIds: lineIdsOf(order),
        }));
    }

    private async dtos(tenantId: string, requests: BomProcurementRequest[]): Promise<ProcurementRequestDto[]> {
        if (!requests.length) return [];
        const bomIds = [...new Set(requests.map((entry) => entry.bomId))];
        const personIds = [...new Set(requests.flatMap((entry) => [entry.createdById, entry.closedById]).filter((id): id is string => Boolean(id)))];
        const [boms, purchases, projects, devices, deliveryDates, names] = await Promise.all([
            this.devices.bomsByIds(tenantId, bomIds),
            this.devices.purchasesOf(tenantId, bomIds),
            this.directory.projects(tenantId, requests.map((entry) => entry.productionProjectId)),
            this.directory.devices(tenantId, requests.map((entry) => entry.productionItemId)),
            this.directory.deliveryDates(tenantId, requests.map((entry) => entry.productionProjectId)),
            personIds.length ? this.directory.personNames(personIds) : Promise.resolve(new Map<string, string>()),
        ]);
        const bomById = new Map(boms.map((bom) => [bom.id, bom]));
        // Was den Zeilen JETZT fehlt — nur für freigegebene BOMs gerechnet.
        const activeProducts = requests
            .filter((entry) => bomById.get(entry.bomId)?.status === 'APPROVED')
            .flatMap((entry) => entry.lines.map((line) => line.productId));
        const coverage = activeProducts.length ? (await this.reservations.facts(tenantId, activeProducts)).coverage.lines : null;
        const facts: ProcurementDocFact[] = purchases.map(({ link, order }) => ({
            purchaseOrderId: order.id,
            kind: link.kind,
            confirmed: link.kind === 'ORDER' && CONFIRMED_ORDER_STATUSES.has(String(order.status).toUpperCase()),
            lineIds: lineIdsOf(order),
        }));
        const docById = new Map(purchases.map(({ link, order }) => [order.id, docDto(link.kind, order)]));
        return requests.map((request) => {
            const bom = bomById.get(request.bomId) ?? null;
            const project = projects.get(request.productionProjectId) ?? null;
            const device = devices.get(request.productionItemId) ?? null;
            const progress = procurementProgress(request, facts);
            const wanted = request.kind === 'PRICE' ? 'REQUEST' : 'ORDER';
            const mine = facts.filter((doc) => request.purchaseOrderIds.includes(doc.purchaseOrderId) && doc.kind === wanted);
            const documents = request.purchaseOrderIds.flatMap((id) => {
                const doc = docById.get(id);
                return doc ? [doc] : [];
            });
            const lastActivityAt = [request.updatedAt.toISOString(), ...documents.map((doc) => doc.updatedAt)]
                .reduce((latest, value) => (value > latest ? value : latest));
            return {
                id: request.id,
                requestNumber: request.requestNumber,
                kind: request.kind,
                status: request.status,
                note: request.note,
                bomRevision: request.bomRevision,
                createdAt: request.createdAt.toISOString(),
                createdByName: request.createdById ? names.get(request.createdById) ?? null : null,
                closedAt: iso(request.closedAt),
                closedByName: request.closedById ? names.get(request.closedById) ?? null : null,
                lastActivityAt,
                bom: bom
                    ? {
                        id: bom.id,
                        bomNumber: bom.bomNumber,
                        kind: bom.kind,
                        status: bom.status,
                        area: bom.area,
                        revision: bom.revision,
                        templateName: bom.templateName,
                        consumed: Boolean(bom.consumedAt),
                    }
                    : null,
                project: project
                    ? {
                        id: project.id,
                        projectNumber: project.projectNumber,
                        projectName: project.projectName,
                        customerName: project.customerName,
                        deliveryDate: iso(deliveryDates.get(project.id) ?? null),
                    }
                    : null,
                device: device ? { id: device.id, name: device.name, positionNumber: device.positionNumber } : null,
                lines: request.lines.map((line) => ({
                    ...line,
                    covered: mine.some((doc) => doc.lineIds.has(line.bomLineId)),
                    missingNow: coverage && bom?.status === 'APPROVED' ? round3(coverage.get(line.bomLineId)?.missing ?? 0) : null,
                })),
                progress,
                documents,
            };
        });
    }
}
