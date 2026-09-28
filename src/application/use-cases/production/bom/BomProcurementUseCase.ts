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
    IBomRevisionRepository,
    IBomProductionDirectory,
    IBomPurchaseRepository,
    IBomStockReader,
} from '../../../../domain/repositories/IProductionBomRepository';
import { bomError, CONFIRMED_ORDER_STATUSES, PRICE_REQUEST_STATUSES, round3 } from '../../../../domain/services/productionBom';
import {
    procurementKindFrom,
    procurementLinesFrom,
    procurementProgress,
    procurementStatusAfter,
    type ProcurementDocFact,
    type ProcurementProgress,
} from '../../../../domain/services/productionBomProcurement';
import type { BomReservationService } from './BomReservationService';
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

/** Eine freigegebene BOM-Revision, wie der Einkauf sie sieht — MIT Lieferant der betroffenen Bestellungen. */
export interface ProcurementRevisionDto {
    bomId: string;
    bomNumber: string;
    revision: number;
    reason: string | null;
    approvedAt: string | null;
    approvedByName: string | null;
    project: { id: string; projectNumber: string; projectName: string } | null;
    device: { id: string; name: string } | null;
    changes: { added: number; removed: number; increased: number; decreased: number; edited: number };
    orderActions: Array<{
        purchaseOrderId: string;
        referenceNumber: string;
        supplierName: string;
        action: string;
        orderRevision: number | null;
        atSupplier: boolean;
        statusAfter: string;
        lines: number;
    }>;
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

interface SpendingTotal { currency: string; ordered: number; confirmed: number; received: number }

export interface ProcurementSpendingDto {
    totals: SpendingTotal[];
    suppliers: Array<{
        key: string;
        supplierName: string;
        orders: number;
        confirmedOrders: number;
        requests: number;
        totals: SpendingTotal[];
        lastAt: string | null;
    }>;
    projects: Array<{
        productionProjectId: string;
        projectNumber: string;
        projectName: string;
        orders: number;
        totals: SpendingTotal[];
    }>;
    documents: Array<ProcurementDocumentDto & {
        bomId: string;
        bomNumber: string | null;
        projectNumber: string | null;
        projectName: string | null;
        deviceName: string | null;
    }>;
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

/** Was an einer Bestellung schon da ist, in Geld (Positionssumme × gelieferter Anteil). */
const receivedValue = (order: BomPurchaseOrderRow): number => {
    let sum = 0;
    for (const item of order.items) {
        const quantity = Number(item.quantity) || 0;
        const received = Number(item.receivedQuantity) || 0;
        const total = Number(item.lineTotal) || 0;
        if (quantity > EPS) sum += total * Math.min(1, received / quantity);
    }
    return round3(sum);
};

const addTotal = (list: SpendingTotal[], currency: string, patch: Partial<Omit<SpendingTotal, 'currency'>>): void => {
    const key = (currency || 'CHF').toUpperCase();
    let entry = list.find((total) => total.currency === key);
    if (!entry) {
        entry = { currency: key, ordered: 0, confirmed: 0, received: 0 };
        list.push(entry);
    }
    entry.ordered = round3(entry.ordered + (patch.ordered ?? 0));
    entry.confirmed = round3(entry.confirmed + (patch.confirmed ?? 0));
    entry.received = round3(entry.received + (patch.received ?? 0));
};

const docDto = (kind: 'ORDER' | 'REQUEST', order: BomPurchaseOrderRow): ProcurementDocumentDto => {
    const status = String(order.status).toUpperCase();
    return {
        purchaseOrderId: order.id,
        referenceNumber: order.referenceNumber,
        kind,
        status,
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
 *     sieht alle Talepler, macht mit den bekannten Assistenten Preisanfragen
 *     und Bestellungen daraus (DeviceBomsUseCase, `procurementRequestId`),
 *     schliesst sie und verfolgt Lieferanten und Ausgaben.
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
        private revisionRepository: IBomRevisionRepository | null = null,
    ) {}

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
        const bom = await this.devices.requireBom(tenantId, bomId);
        await this.devices.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        if (bom.consumedAt) throw bomError('STATUS_INVALID', 'Die BOM ist abgebucht.', { status: 409 });

        const open = (await this.requests.list(tenantId, { bomIds: [bom.id] }))
            .filter((entry) => entry.kind === kind && OPEN_STATUSES.has(entry.status));
        const pending = new Set(open.flatMap((entry) => entry.lines.map((line) => line.bomLineId)));

        let lines: Bom['lines'];
        let revision = bom.revision;
        const allowed = new Map<string, number>();
        if (kind === 'PRICE') {
            const working = await this.devices.workingLinesOf(tenantId, bom);
            if (!working.draft) {
                throw bomError('REQUEST_DRAFT_ONLY', 'Preise fragt die BOM im Entwurf an — oder in einer Revision im Entwurf.', { status: 409 });
            }
            lines = working.lines;
            revision = working.revision;
            for (const line of lines) if (!pending.has(line.id)) allowed.set(line.id, 0);
        } else {
            if (bom.status !== 'APPROVED') {
                throw bomError('STATUS_INVALID', 'Bestellt wird aus einer freigegebenen BOM.', { status: 409 });
            }
            lines = bom.lines;
            const facts = await this.reservations.facts(tenantId, lines.map((line) => line.productId));
            for (const line of lines) {
                const missing = facts.coverage.lines.get(line.id)?.missing ?? 0;
                if (missing > EPS && !pending.has(line.id)) allowed.set(line.id, round3(missing));
            }
        }
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
        return { request: dto!, bom: await this.devices.get(tenantId, bom.id) };
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
        return { bom: await this.devices.get(tenantId, bom.id) };
    }

    /* ── Was die BOM vom Talep und vom Wareneingang sieht ───────────────── */

    /** Talepler und eingegangene Ware der BOMs — für die DTOs der BOM (ohne Lieferant, ohne Preis). */
    async forBoms(
        tenantId: string,
        bomIds: string[],
        docs: Array<{ kind: 'ORDER' | 'REQUEST'; order: BomPurchaseOrderRow }>,
    ): Promise<{ requests: Map<string, BomProcurementSummaryDto[]>; goodsIn: Map<string, BomGoodsInDto[]> }> {
        // Solange die Tabellen fehlen (Migration noch nicht aufgespielt), bleibt die BOM lesbar.
        const tolerant = <T>(promise: Promise<T[]>): Promise<T[]> => promise.catch((error: unknown) => {
            if (/doesn't exist|does not exist|P2021/i.test((error as Error)?.message ?? '')) return [];
            throw error;
        });
        const [requests, goods] = await Promise.all([
            tolerant(this.requests.list(tenantId, { bomIds })),
            tolerant(this.goodsIn.forBoms(tenantId, bomIds)),
        ]);
        const personIds = [...new Set([
            ...requests.map((entry) => entry.createdById),
            ...goods.map((entry) => entry.receivedById),
        ].filter((id): id is string => Boolean(id)))];
        const names = personIds.length ? await this.directory.personNames(personIds) : new Map<string, string>();
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

    async list(tenantId: string, actor: BomActor, query: Record<string, unknown> = {}): Promise<{
        requests: ProcurementRequestDto[];
        counts: Record<BomProcurementStatus, number>;
        canProcure: boolean;
    }> {
        this.assertCanSee(actor);
        const all = await this.requests.list(tenantId);
        const counts: Record<BomProcurementStatus, number> = { OPEN: 0, IN_PROGRESS: 0, DONE: 0, CANCELLED: 0 };
        for (const entry of all) counts[entry.status] += 1;
        const wanted = String(query.status ?? '').split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
        const shown = wanted.length ? all.filter((entry) => wanted.includes(entry.status)) : all;
        return { requests: await this.dtos(tenantId, shown), counts, canProcure: actor.isAdmin || actor.canProcure };
    }

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

    /** Eine BOM VOLL (mit Lieferanten und Preisen) für die Belege des Einkaufs — mit Projekt und Gerät. */
    async bomFor(tenantId: string, actor: BomActor, bomId: string): Promise<{
        bom: BomDto;
        project: ProcurementRequestDto['project'];
        device: ProcurementRequestDto['device'];
        canProcure: boolean;
    }> {
        this.assertCanSee(actor);
        const raw = await this.devices.requireBom(tenantId, bomId);
        const [bom, project, device, dates] = await Promise.all([
            this.devices.get(tenantId, raw.id),
            this.directory.project(tenantId, raw.productionProjectId),
            this.directory.device(tenantId, raw.productionItemId),
            this.directory.deliveryDates(tenantId, [raw.productionProjectId]),
        ]);
        return {
            bom,
            project: project
                ? {
                    id: project.id,
                    projectNumber: project.projectNumber,
                    projectName: project.projectName,
                    customerName: project.customerName,
                    deliveryDate: iso(dates.get(project.id) ?? null),
                }
                : null,
            device: device ? { id: device.id, name: device.name, positionNumber: device.positionNumber } : null,
            canProcure: actor.isAdmin || actor.canProcure,
        };
    }

    /** `close` (erledigt) · `reopen` · `cancel` (verwerfen) — nur der Einkauf. */
    async setStatus(tenantId: string, actor: BomActor, requestId: string, action: string): Promise<{ request: ProcurementRequestDto }> {
        this.assertCanProcure(actor);
        const request = await this.requireRequest(tenantId, requestId);
        if (action === 'close') {
            if (request.status === 'CANCELLED') throw bomError('STATUS_INVALID', 'Ein verworfener Talep bleibt verworfen.', { status: 409 });
            await this.requests.update(tenantId, request.id, { status: 'DONE', closedById: actor.id, closedAt: new Date() });
        } else if (action === 'cancel') {
            if (request.status === 'DONE') throw bomError('STATUS_INVALID', 'Ein erledigter Talep wird nicht verworfen.', { status: 409 });
            await this.requests.update(tenantId, request.id, { status: 'CANCELLED', closedById: actor.id, closedAt: new Date() });
        } else if (action === 'reopen') {
            const docs = await this.docFacts(tenantId, [request.bomId]);
            const status = procurementStatusAfter('OPEN', procurementProgress(request, docs));
            await this.requests.update(tenantId, request.id, { status: status === 'DONE' ? 'IN_PROGRESS' : status, closedById: null, closedAt: null });
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
    async attachDocuments(tenantId: string, requestId: string, bomId: string, purchaseOrderIds: string[]): Promise<void> {
        const request = await this.requests.get(tenantId, requestId);
        if (!request || request.bomId !== bomId || !purchaseOrderIds.length) return;
        const ids = [...new Set([...request.purchaseOrderIds, ...purchaseOrderIds])];
        const docs = await this.docFacts(tenantId, [bomId]);
        const status = procurementStatusAfter(request.status, procurementProgress({ ...request, purchaseOrderIds: ids }, docs));
        await this.requests.update(tenantId, request.id, { purchaseOrderIds: ids, status });
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

    /* ── Revisionen: was BOM-Änderungen mit den Bestellungen machten ───── */

    /**
     * «Revizyonlarda … satın alma kısmında üretimde orada görebilelim» (27.09.2026):
     * die BOM zeigt bei einer Revision keinen Lieferanten — hier sieht der
     * Einkauf jede freigegebene Revision mit den betroffenen Bestellungen.
     */
    async revisions(tenantId: string, actor: BomActor): Promise<{ revisions: ProcurementRevisionDto[] }> {
        this.assertCanSee(actor);
        if (!this.revisionRepository) return { revisions: [] };
        const list = await this.revisionRepository.listApproved(tenantId, 200);
        if (!list.length) return { revisions: [] };
        const boms = await this.devices.bomsByIds(tenantId, list.map((entry) => entry.bomId));
        const bomById = new Map(boms.map((bom) => [bom.id, bom]));
        const personIds = [...new Set(list.map((entry) => entry.approvedById).filter((id): id is string => Boolean(id)))];
        const [projects, devices, names] = await Promise.all([
            this.directory.projects(tenantId, boms.map((bom) => bom.productionProjectId)),
            this.directory.devices(tenantId, boms.map((bom) => bom.productionItemId)),
            personIds.length ? this.directory.personNames(personIds) : Promise.resolve(new Map<string, string>()),
        ]);
        const revisions = list.flatMap((entry): ProcurementRevisionDto[] => {
            const bom = bomById.get(entry.bomId);
            if (!bom) return [];
            const project = projects.get(bom.productionProjectId);
            const device = devices.get(bom.productionItemId);
            const count = (kind: string) => entry.changes.filter((change) => change.kind === kind).length;
            return [{
                bomId: bom.id,
                bomNumber: bom.bomNumber,
                revision: entry.revision,
                reason: entry.reason,
                approvedAt: iso(entry.approvedAt),
                approvedByName: entry.approvedById ? names.get(entry.approvedById) ?? null : null,
                project: project ? { id: project.id, projectNumber: project.projectNumber, projectName: project.projectName } : null,
                device: device ? { id: device.id, name: device.name } : null,
                changes: { added: count('ADDED'), removed: count('REMOVED'), increased: count('INCREASED'), decreased: count('DECREASED'), edited: count('EDITED') },
                orderActions: entry.orderActions.map((action) => ({
                    purchaseOrderId: action.purchaseOrderId,
                    referenceNumber: action.referenceNumber,
                    supplierName: action.supplierName,
                    action: action.action,
                    orderRevision: action.orderRevision,
                    atSupplier: action.atSupplier,
                    statusAfter: action.statusAfter,
                    lines: action.lines.length,
                })),
            }];
        });
        return { revisions };
    }

    /* ── Ausgaben und Lieferanten ──────────────────────────────────────── */

    async spending(tenantId: string, actor: BomActor): Promise<ProcurementSpendingDto> {
        this.assertCanSee(actor);
        const links = await this.requests.purchaseLinks(tenantId);
        const orders = await this.purchases.orders(tenantId, links.map((link) => link.purchaseOrderId));
        const byId = new Map(orders.map((order) => [order.id, order]));
        const live = links.filter((link) => byId.has(link.purchaseOrderId));
        const [projects, devices, boms] = await Promise.all([
            this.directory.projects(tenantId, live.map((link) => link.productionProjectId)),
            this.directory.devices(tenantId, live.map((link) => link.productionItemId)),
            this.bomNumbers(tenantId, live.map((link) => link.bomId)),
        ]);
        const totals: SpendingTotal[] = [];
        const suppliers = new Map<string, ProcurementSpendingDto['suppliers'][number]>();
        const projectRows = new Map<string, ProcurementSpendingDto['projects'][number]>();
        const documents: ProcurementSpendingDto['documents'] = [];
        for (const link of live) {
            const order = byId.get(link.purchaseOrderId)!;
            const doc = docDto(link.kind, order);
            const project = projects.get(link.productionProjectId) ?? null;
            documents.push({
                ...doc,
                bomId: link.bomId,
                bomNumber: boms.get(link.bomId) ?? null,
                projectNumber: project?.projectNumber ?? null,
                projectName: project?.projectName ?? null,
                deviceName: devices.get(link.productionItemId)?.name ?? null,
            });
            const key = order.supplierId ? `id:${order.supplierId}` : `name:${(order.supplierName || '').trim().toLocaleLowerCase('tr-TR')}`;
            const supplier = suppliers.get(key) ?? {
                key,
                supplierName: order.supplierName || '—',
                orders: 0,
                confirmedOrders: 0,
                requests: 0,
                totals: [],
                lastAt: null,
            };
            if (!supplier.lastAt || supplier.lastAt < doc.createdAt) supplier.lastAt = doc.createdAt;
            suppliers.set(key, supplier);
            // Preisanfragen und nie bestellte Entwürfe sind keine Ausgabe.
            if (link.kind === 'REQUEST' || PRICE_REQUEST_STATUSES.has(doc.status) || doc.status === 'CANCELLED') {
                if (link.kind === 'REQUEST') supplier.requests += 1;
                continue;
            }
            const value = { ordered: order.totalNet, confirmed: doc.confirmed ? order.totalNet : 0, received: receivedValue(order) };
            supplier.orders += 1;
            if (doc.confirmed) supplier.confirmedOrders += 1;
            addTotal(supplier.totals, order.currency, value);
            addTotal(totals, order.currency, value);
            const projectRow = projectRows.get(link.productionProjectId) ?? {
                productionProjectId: link.productionProjectId,
                projectNumber: project?.projectNumber ?? '—',
                projectName: project?.projectName ?? '',
                orders: 0,
                totals: [],
            };
            projectRow.orders += 1;
            addTotal(projectRow.totals, order.currency, value);
            projectRows.set(link.productionProjectId, projectRow);
        }
        const firstTotal = (list: SpendingTotal[]) => list.reduce((sum, entry) => sum + entry.ordered, 0);
        return {
            totals,
            suppliers: [...suppliers.values()].sort((a, b) => firstTotal(b.totals) - firstTotal(a.totals) || a.supplierName.localeCompare(b.supplierName)),
            projects: [...projectRows.values()].sort((a, b) => firstTotal(b.totals) - firstTotal(a.totals)),
            documents: documents.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        };
    }

    /* ── Hilfen ────────────────────────────────────────────────────────── */

    private async requireRequest(tenantId: string, id: string): Promise<BomProcurementRequest> {
        const request = await this.requests.get(tenantId, id);
        if (!request) throw bomError('REQUEST_NOT_FOUND', 'Talep nicht gefunden.', { status: 404 });
        return request;
    }

    private async bomNumbers(tenantId: string, bomIds: string[]): Promise<Map<string, string>> {
        const unique = [...new Set(bomIds.filter(Boolean))];
        if (!unique.length) return new Map();
        const boms = await this.devices.bomsByIds(tenantId, unique);
        return new Map(boms.map((bom) => [bom.id, bom.bomNumber]));
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
