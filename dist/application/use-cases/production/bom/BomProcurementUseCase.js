"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BomProcurementUseCase = void 0;
const productionBom_1 = require("../../../../domain/services/productionBom");
const productionBomProcurement_1 = require("../../../../domain/services/productionBomProcurement");
const EPS = 1e-9;
const iso = (value) => (value ? value.toISOString() : null);
const OPEN_STATUSES = new Set(['OPEN', 'IN_PROGRESS']);
const lineIdsOf = (order) => new Set(order.items.map((item) => (typeof item.bomLineId === 'string' ? item.bomLineId : '')).filter(Boolean));
/** Anteil der gelieferten Menge einer Bestellung. */
const receivedShare = (order) => {
    let ordered = 0;
    let received = 0;
    for (const item of order.items) {
        ordered += Math.max(0, Number(item.quantity) || 0);
        received += Math.max(0, Number(item.receivedQuantity) || 0);
    }
    return ordered > EPS ? Math.min(1, (0, productionBom_1.round3)(received / ordered)) : 0;
};
const docDto = (kind, order) => {
    const status = String(order.status).toUpperCase();
    return {
        purchaseOrderId: order.id,
        referenceNumber: order.referenceNumber,
        kind,
        status,
        supplierName: order.supplierName,
        currency: order.currency,
        totalNet: order.totalNet,
        confirmed: kind === 'ORDER' && productionBom_1.CONFIRMED_ORDER_STATUSES.has(status),
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
class BomProcurementUseCase {
    requests;
    goodsIn;
    purchases;
    stock;
    directory;
    reservations;
    devices;
    journal;
    constructor(requests, goodsIn, purchases, stock, directory, reservations, devices, journal = null) {
        this.requests = requests;
        this.goodsIn = goodsIn;
        this.purchases = purchases;
        this.stock = stock;
        this.directory = directory;
        this.reservations = reservations;
        this.devices = devices;
        this.journal = journal;
    }
    /** Eine Spur im Verlauf («son işlem») — sie hält die Handlung nie auf. */
    async note(tenantId, actor, request, action, data = {}) {
        if (!this.journal)
            return;
        await this.journal.record(tenantId, {
            requestId: request.id,
            requestNumber: request.requestNumber,
            action,
            actorId: actor?.id ?? null,
            actorName: actor?.name ?? null,
            data,
        }).catch((error) => console.warn('[satın alma] Verlauf nicht geschrieben:', error?.message));
    }
    /** Den Einkauf sehen: Administratorrolle oder Seite «Satın alma» (Stufe 1). */
    assertCanSee(actor) {
        if (actor.isAdmin || actor.canSeeProcurement)
            return;
        throw (0, productionBom_1.bomError)('FORBIDDEN', 'Den Einkauf sehen nur Buchhaltung und Administratorrolle.', { status: 403 });
    }
    /** Im Einkauf handeln: Administratorrolle oder Seite «Satın alma» Stufe 2. */
    assertCanProcure(actor) {
        if (actor.isAdmin || actor.canProcure)
            return;
        throw (0, productionBom_1.bomError)('FORBIDDEN', 'Preisanfragen und Bestellungen macht die Buchhaltung.', { status: 403 });
    }
    /* ── Die BOM stellt einen Talep ────────────────────────────────────── */
    /**
     * `{ kind: 'PRICE' | 'ORDER', lines: [{ lineId, quantity, note }], note }`.
     * PRICE nur im Entwurf (auch in einer Revision im Entwurf) — «bom
     * onaylandıktan sonra fiyat talebi alınamaz» —, ORDER nur aus der
     * freigegebenen BOM und nie unter dem, was fehlt. Eine Zeile, die schon in
     * einem offenen Talep derselben Art steht, kommt nicht in einen zweiten.
     */
    async createFromBom(tenantId, actor, bomId, body) {
        const input = (body && typeof body === 'object' ? body : {});
        const kind = (0, productionBomProcurement_1.procurementKindFrom)(input.kind);
        if (!kind)
            throw (0, productionBom_1.bomError)('KIND_INVALID', 'PRICE oder ORDER.');
        const bom = await this.devices.requireBom(tenantId, bomId);
        await this.devices.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        if (bom.consumedAt)
            throw (0, productionBom_1.bomError)('STATUS_INVALID', 'Die BOM ist abgebucht.', { status: 409 });
        const open = (await this.requests.list(tenantId, { bomIds: [bom.id] }))
            .filter((entry) => entry.kind === kind && OPEN_STATUSES.has(entry.status));
        const pending = new Set(open.flatMap((entry) => entry.lines.map((line) => line.bomLineId)));
        let lines;
        let revision = bom.revision;
        const allowed = new Map();
        if (kind === 'PRICE') {
            const working = await this.devices.workingLinesOf(tenantId, bom);
            if (!working.draft) {
                throw (0, productionBom_1.bomError)('REQUEST_DRAFT_ONLY', 'Preise fragt die BOM im Entwurf an — oder in einer Revision im Entwurf.', { status: 409 });
            }
            lines = working.lines;
            revision = working.revision;
            const remaining = (0, productionBomProcurement_1.remainingPriceRequestQuantities)(lines, revision, open);
            for (const line of lines)
                if ((remaining.get(line.id) ?? 0) > EPS)
                    allowed.set(line.id, 0);
        }
        else {
            if (bom.status !== 'APPROVED') {
                throw (0, productionBom_1.bomError)('STATUS_INVALID', 'Bestellt wird aus einer freigegebenen BOM.', { status: 409 });
            }
            lines = bom.lines;
            const facts = await this.reservations.facts(tenantId, lines.map((line) => line.productId));
            for (const line of lines) {
                const missing = facts.coverage.lines.get(line.id)?.missing ?? 0;
                if (missing > EPS && !pending.has(line.id))
                    allowed.set(line.id, (0, productionBom_1.round3)(missing));
            }
        }
        if (!lines.length)
            throw (0, productionBom_1.bomError)('REQUEST_EMPTY', 'Die BOM hat keine Zeilen.');
        const picked = (0, productionBomProcurement_1.procurementLinesFrom)(input.lines, allowed);
        const byId = new Map(lines.map((line) => [line.id, line]));
        const products = await this.stock.products(tenantId, picked.map((entry) => byId.get(entry.lineId).productId));
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
                const line = byId.get(entry.lineId);
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
        return { request: dto, bom: await this.devices.get(tenantId, bom.id) };
    }
    /** Die BOM zieht einen Talep zurück, solange der Einkauf nichts daraus gemacht hat. */
    async cancelFromBom(tenantId, actor, requestId) {
        const request = await this.requireRequest(tenantId, requestId);
        const bom = await this.devices.requireBom(tenantId, request.bomId);
        await this.devices.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        if (request.status !== 'OPEN' || request.purchaseOrderIds.length) {
            throw (0, productionBom_1.bomError)('REQUEST_IN_PROGRESS', 'Der Einkauf arbeitet schon daran — zurückziehen geht nicht mehr.', { status: 409 });
        }
        await this.requests.update(tenantId, request.id, { status: 'CANCELLED', closedById: actor.id, closedAt: new Date() });
        await this.note(tenantId, actor, request, 'REQUEST_WITHDRAWN');
        return { bom: await this.devices.get(tenantId, bom.id) };
    }
    /* ── Was die BOM vom Talep und vom Wareneingang sieht ───────────────── */
    /** Talepler und eingegangene Ware der BOMs — für die DTOs der BOM (ohne Lieferant, ohne Preis). */
    async forBoms(tenantId, bomIds, docs) {
        // Solange die Tabellen fehlen (Migration noch nicht aufgespielt), bleibt die BOM lesbar.
        const tolerant = (promise) => promise.catch((error) => {
            if (/doesn't exist|does not exist|P2021/i.test(error?.message ?? ''))
                return [];
            throw error;
        });
        const [requests, goods] = await Promise.all([
            tolerant(this.requests.list(tenantId, { bomIds })),
            tolerant(this.goodsIn.forBoms(tenantId, bomIds)),
        ]);
        const personIds = [...new Set([
                ...requests.map((entry) => entry.createdById),
                ...goods.map((entry) => entry.receivedById),
            ].filter((id) => Boolean(id)))];
        const names = personIds.length ? await this.directory.personNames(personIds) : new Map();
        const summaries = await this.summaries(tenantId, requests, docs, names);
        const byBom = new Map();
        requests.forEach((request, index) => {
            const list = byBom.get(request.bomId) ?? [];
            list.push(summaries[index]);
            byBom.set(request.bomId, list);
        });
        const goodsByBom = new Map();
        for (const entry of goods) {
            if (!entry.bomId)
                continue;
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
    async summaries(_tenantId, requests, docs, names) {
        const facts = docs.map(({ kind, order }) => ({
            purchaseOrderId: order.id,
            kind,
            confirmed: kind === 'ORDER' && productionBom_1.CONFIRMED_ORDER_STATUSES.has(String(order.status).toUpperCase()),
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
            progress: (0, productionBomProcurement_1.procurementProgress)(request, facts),
        }));
    }
    /* ── Der Einkauf: «Satın alma» ─────────────────────────────────────── */
    /** Ein Talep mit seiner BOM (VOLL — mit Lieferanten und Preisen, für die Assistenten). */
    async get(tenantId, actor, requestId) {
        this.assertCanSee(actor);
        const request = await this.requireRequest(tenantId, requestId);
        const [[dto], bom] = await Promise.all([
            this.dtos(tenantId, [request]),
            this.devices.get(tenantId, request.bomId),
        ]);
        return { request: dto, bom, canProcure: actor.isAdmin || actor.canProcure };
    }
    /** `close` (erledigt) · `reopen` · `cancel` (verwerfen) — nur der Einkauf. */
    async setStatus(tenantId, actor, requestId, action) {
        this.assertCanProcure(actor);
        const request = await this.requireRequest(tenantId, requestId);
        if (action === 'close') {
            if (request.status === 'CANCELLED')
                throw (0, productionBom_1.bomError)('STATUS_INVALID', 'Ein verworfener Talep bleibt verworfen.', { status: 409 });
            await this.requests.update(tenantId, request.id, { status: 'DONE', closedById: actor.id, closedAt: new Date() });
            await this.note(tenantId, actor, request, 'REQUEST_CLOSED');
        }
        else if (action === 'cancel') {
            if (request.status === 'DONE')
                throw (0, productionBom_1.bomError)('STATUS_INVALID', 'Ein erledigter Talep wird nicht verworfen.', { status: 409 });
            await this.requests.update(tenantId, request.id, { status: 'CANCELLED', closedById: actor.id, closedAt: new Date() });
            await this.note(tenantId, actor, request, 'REQUEST_CANCELLED');
        }
        else if (action === 'reopen') {
            const docs = await this.docFacts(tenantId, [request.bomId]);
            const status = (0, productionBomProcurement_1.procurementStatusAfter)('OPEN', (0, productionBomProcurement_1.procurementProgress)(request, docs));
            await this.requests.update(tenantId, request.id, { status: status === 'DONE' ? 'IN_PROGRESS' : status, closedById: null, closedAt: null });
            await this.note(tenantId, actor, request, 'REQUEST_REOPENED');
        }
        else {
            throw (0, productionBom_1.bomError)('NOT_FOUND', 'Unbekannte Handlung.', { status: 404 });
        }
        const [dto] = await this.dtos(tenantId, [(await this.requireRequest(tenantId, request.id))]);
        return { request: dto };
    }
    /**
     * Die Belege, die aus einem Talep entstanden (Assistent «Sipariş oluştur»
     * / «Fiyat talebi» mit `procurementRequestId`): an den Talep hängen und
     * seinen Stand nachziehen — alle Zeilen in einem Beleg = erledigt.
     */
    async attachDocuments(tenantId, requestId, bomId, purchaseOrderIds, actor = null) {
        const request = await this.requests.get(tenantId, requestId);
        if (!request || request.bomId !== bomId || !purchaseOrderIds.length)
            return;
        const ids = [...new Set([...request.purchaseOrderIds, ...purchaseOrderIds])];
        const docs = await this.docFacts(tenantId, [bomId]);
        const status = (0, productionBomProcurement_1.procurementStatusAfter)(request.status, (0, productionBomProcurement_1.procurementProgress)({ ...request, purchaseOrderIds: ids }, docs));
        await this.requests.update(tenantId, request.id, { purchaseOrderIds: ids, status });
        const orders = await this.purchases.orders(tenantId, purchaseOrderIds);
        await this.note(tenantId, actor, request, request.kind === 'PRICE' ? 'PRICE_REQUESTS_CREATED' : 'ORDERS_CREATED', {
            codes: orders.map((order) => order.referenceNumber),
        });
    }
    /** Ein Talep, aus dem der Einkauf gerade Belege macht: er muss zur BOM gehören und offen sein. */
    async assertUsable(tenantId, requestId, bomId, kind) {
        const request = await this.requireRequest(tenantId, requestId);
        if (request.bomId !== bomId || request.kind !== kind) {
            throw (0, productionBom_1.bomError)('REQUEST_MISMATCH', 'Der Talep gehört nicht zu diesem Vorgang.', { status: 409 });
        }
        if (request.status === 'CANCELLED')
            throw (0, productionBom_1.bomError)('STATUS_INVALID', 'Der Talep ist verworfen.', { status: 409 });
        return request;
    }
    /* ── Hilfen ────────────────────────────────────────────────────────── */
    async requireRequest(tenantId, id) {
        const request = await this.requests.get(tenantId, id);
        if (!request)
            throw (0, productionBom_1.bomError)('REQUEST_NOT_FOUND', 'Talep nicht gefunden.', { status: 404 });
        return request;
    }
    async docFacts(tenantId, bomIds) {
        const purchases = await this.devices.purchasesOf(tenantId, bomIds);
        return purchases.map(({ link, order }) => ({
            purchaseOrderId: order.id,
            kind: link.kind,
            confirmed: link.kind === 'ORDER' && productionBom_1.CONFIRMED_ORDER_STATUSES.has(String(order.status).toUpperCase()),
            lineIds: lineIdsOf(order),
        }));
    }
    async dtos(tenantId, requests) {
        if (!requests.length)
            return [];
        const bomIds = [...new Set(requests.map((entry) => entry.bomId))];
        const personIds = [...new Set(requests.flatMap((entry) => [entry.createdById, entry.closedById]).filter((id) => Boolean(id)))];
        const [boms, purchases, projects, devices, deliveryDates, names] = await Promise.all([
            this.devices.bomsByIds(tenantId, bomIds),
            this.devices.purchasesOf(tenantId, bomIds),
            this.directory.projects(tenantId, requests.map((entry) => entry.productionProjectId)),
            this.directory.devices(tenantId, requests.map((entry) => entry.productionItemId)),
            this.directory.deliveryDates(tenantId, requests.map((entry) => entry.productionProjectId)),
            personIds.length ? this.directory.personNames(personIds) : Promise.resolve(new Map()),
        ]);
        const bomById = new Map(boms.map((bom) => [bom.id, bom]));
        // Was den Zeilen JETZT fehlt — nur für freigegebene BOMs gerechnet.
        const activeProducts = requests
            .filter((entry) => bomById.get(entry.bomId)?.status === 'APPROVED')
            .flatMap((entry) => entry.lines.map((line) => line.productId));
        const coverage = activeProducts.length ? (await this.reservations.facts(tenantId, activeProducts)).coverage.lines : null;
        const facts = purchases.map(({ link, order }) => ({
            purchaseOrderId: order.id,
            kind: link.kind,
            confirmed: link.kind === 'ORDER' && productionBom_1.CONFIRMED_ORDER_STATUSES.has(String(order.status).toUpperCase()),
            lineIds: lineIdsOf(order),
        }));
        const docById = new Map(purchases.map(({ link, order }) => [order.id, docDto(link.kind, order)]));
        return requests.map((request) => {
            const bom = bomById.get(request.bomId) ?? null;
            const project = projects.get(request.productionProjectId) ?? null;
            const device = devices.get(request.productionItemId) ?? null;
            const progress = (0, productionBomProcurement_1.procurementProgress)(request, facts);
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
                    missingNow: coverage && bom?.status === 'APPROVED' ? (0, productionBom_1.round3)(coverage.get(line.bomLineId)?.missing ?? 0) : null,
                })),
                progress,
                documents,
            };
        });
    }
}
exports.BomProcurementUseCase = BomProcurementUseCase;
//# sourceMappingURL=BomProcurementUseCase.js.map