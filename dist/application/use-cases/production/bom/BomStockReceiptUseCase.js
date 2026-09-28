"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BomStockReceiptUseCase = void 0;
const productionBom_1 = require("../../../../domain/services/productionBom");
const productionBomProcurement_1 = require("../../../../domain/services/productionBomProcurement");
const productionBomStockReceipt_1 = require("../../../../domain/services/productionBomStockReceipt");
const warehouseGoodsIn_1 = require("../../../../shared/warehouseGoodsIn");
const EPS = 1e-9;
/**
 * ── «ÜRÜN EKLE» BUCHT DEN WARENEINGANG (28.09.2026, Vorgabe Samet) ─────────
 *
 * «Hiç sormadan, proje teslim tarihi en önce olan ürünün siparişine otomatik
 *  çeksin stoktan.» Das Depo hat die Stücke schon gebucht; hier gehen sie an
 * die bestätigten BOM-Bestellungen, die auf die Karte warten (frühester
 * Liefertermin des Projekts zuerst, `planStockReceipt`), genau wie der
 * Wareneingang auf der Seite «Satın alma»: Menge an der Position, fertige
 * Bestellung «Stoğa aktarıldı», Protokoll «Gelen mallar» (Quelle ORDER, an
 * die Zeile, der die Reservierung die Ware gab). Seriennummern gehen dabei
 * wie bisher an die wartende Zeile.
 *
 * «Geri al» nimmt genau eine solche Buchung zurück — erst geprüft, dann das
 * Depo, dann Bestellung und Protokoll.
 *
 * Eine Berechtigung «Satın alma» braucht es dafür nicht: wer im Depo einbuchen
 * darf, nimmt Ware an — das ist die Arbeit des Depos.
 */
class BomStockReceiptUseCase {
    ledger;
    goodsIn;
    reservations;
    writer;
    directory;
    available;
    /** Je Karte eine Buchung nach der anderen — zwei Scans schreiben nie zugleich dieselbe Bestellung. */
    queues = new Map();
    constructor(ledger, goodsIn, reservations, writer, directory, available) {
        this.ledger = ledger;
        this.goodsIn = goodsIn;
        this.reservations = reservations;
        this.writer = writer;
        this.directory = directory;
        this.available = available;
    }
    inTurn(key, work) {
        const previous = this.queues.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(work);
        const settled = next.catch(() => undefined);
        this.queues.set(key, settled);
        void settled.then(() => {
            if (this.queues.get(key) === settled)
                this.queues.delete(key);
        });
        return next;
    }
    async book(request) {
        if (!(await this.available(request.tenantId)))
            return null;
        return this.inTurn(`${request.tenantId}:${request.productId}`, () => this.bookNow(request));
    }
    async bookNow(request) {
        const { tenantId, userId, productId } = request;
        const serials = [...new Set(request.serials.map((serial) => serial.trim()).filter(Boolean))];
        const quantity = serials.length ? serials.length : (0, productionBom_1.round3)(request.quantity);
        const raw = await this.ledger.receivableLines(tenantId, productId);
        const dates = raw.length
            ? await this.directory.deliveryDates(tenantId, [...new Set(raw.map((line) => line.productionProjectId))])
            : new Map();
        const plan = (0, productionBomStockReceipt_1.planStockReceipt)(quantity, raw.map((line) => ({ ...line, deliveryDate: dates.get(line.productionProjectId) ?? null })), request.supplier ? { supplierId: request.supplier.supplierId, supplierName: request.supplier.name } : null);
        // Seriennummern gehen gleich an die wartende Zeile (wie sonst das Depo-Ereignis).
        const serialResult = serials.length ? await this.reservations.assignFreeSerialsDetailed(tenantId, [productId]) : null;
        if (!plan.credits.length && !serialResult)
            return { credits: [], free: plan.free, reservations: [] };
        const statuses = new Map();
        for (const credit of plan.credits) {
            const receipt = await this.writer.applyReceipt({ tenantId, userId, purchaseOrderId: credit.purchaseOrderId, received: credit.lines });
            statuses.set(credit.purchaseOrderId, receipt.status);
        }
        const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const receiptIds = new Map(plan.credits.map((credit, index) => [
            credit.purchaseOrderId,
            `${warehouseGoodsIn_1.DEPOT_RECEIPT_PREFIX}${stamp}${index.toString(36)}`.slice(0, 32),
        ]));
        const creditedSerials = (0, productionBomStockReceipt_1.serialsForCredits)(plan.credits.map((credit) => ({ key: credit.purchaseOrderId, quantity: credit.quantity })), serials);
        const assignedBySerial = new Map((serialResult?.assigned ?? [])
            .filter((entry) => entry.productId === productId)
            .map((entry) => [entry.serialNumber, entry]));
        // Das Protokoll darf die Buchung nie scheitern lassen — Depo und Bestellung stehen schon.
        try {
            const rows = serialResult
                ? this.serialRows({ request, plan: plan.credits, creditedSerials, serials, stamp, receiptIds, assigned: serialResult.assigned, products: serialResult.products })
                : await this.quantityRows({ request, quantity, plan: plan.credits, receiptIds });
            if (rows.length)
                await this.goodsIn.add(tenantId, rows);
        }
        catch (error) {
            console.warn('[production-bom] depot goods-in log failed', error?.message);
        }
        const reservedDemands = serials
            .map((serial) => assignedBySerial.get(serial)?.demand)
            .filter((demand) => Boolean(demand));
        const projectIds = [...new Set([...plan.credits, ...reservedDemands].map((entry) => entry.productionProjectId))];
        const itemIds = [...new Set([...plan.credits, ...reservedDemands].map((entry) => entry.productionItemId))];
        const [projects, devices] = await Promise.all([
            projectIds.length ? this.directory.projects(tenantId, projectIds) : Promise.resolve(new Map()),
            itemIds.length ? this.directory.devices(tenantId, itemIds) : Promise.resolve(new Map()),
        ]);
        return {
            credits: plan.credits.map((credit) => {
                const own = raw.filter((line) => line.purchaseOrderId === credit.purchaseOrderId);
                const project = projects.get(credit.productionProjectId);
                return {
                    receiptId: receiptIds.get(credit.purchaseOrderId) ?? '',
                    purchaseOrderId: credit.purchaseOrderId,
                    referenceNumber: credit.referenceNumber,
                    quantity: credit.quantity,
                    serials: creditedSerials.get(credit.purchaseOrderId) ?? [],
                    ordered: (0, productionBom_1.round3)(own.reduce((sum, line) => sum + line.quantity, 0)),
                    received: (0, productionBom_1.round3)(own.reduce((sum, line) => sum + line.received, 0) + credit.quantity),
                    completed: statuses.get(credit.purchaseOrderId) === 'COMPLETED',
                    projectNumber: project?.projectNumber ?? null,
                    projectName: project?.projectName ?? null,
                    deviceName: devices.get(credit.productionItemId)?.name ?? null,
                };
            }),
            free: plan.free,
            reservations: serials.map((serialNumber) => {
                const demand = assignedBySerial.get(serialNumber)?.demand;
                const project = demand ? projects.get(demand.productionProjectId) : undefined;
                return {
                    serialNumber,
                    projectNumber: project?.projectNumber ?? null,
                    projectName: project?.projectName ?? null,
                    deviceName: demand ? devices.get(demand.productionItemId)?.name ?? null : null,
                };
            }),
        };
    }
    /**
     * Menge ohne Seriennummern: wohin die Reservierung die gebuchten Stücke gab
     * (Zuwachs zwischen vorher und nachher, frühester Termin zuerst) — jede
     * Bestellung bekommt davon ihren Teil.
     */
    async quantityRows(input) {
        const { request, plan, receiptIds } = input;
        const credited = (0, productionBom_1.round3)(plan.reduce((sum, credit) => sum + credit.quantity, 0));
        if (credited <= EPS)
            return [];
        const after = await this.reservations.facts(request.tenantId, [request.productId]);
        const product = after.products.get(request.productId);
        const products = new Map(after.products);
        if (product)
            products.set(request.productId, { ...product, quantity: Math.max(0, (0, productionBom_1.round3)(product.quantity - input.quantity)) });
        const before = (0, productionBom_1.computeCoverage)({ demands: after.demands, products, serials: after.serials, incoming: after.incoming });
        const demands = after.demands.filter((demand) => demand.productId === request.productId);
        const parts = (0, productionBomProcurement_1.receiptAllocation)(credited, demands, before.lines, after.coverage.lines);
        const creditOf = new Map(plan.map((credit) => [credit.purchaseOrderId, credit]));
        const receivedAt = new Date();
        return (0, productionBomStockReceipt_1.splitAllocation)(plan.map((credit) => ({ key: credit.purchaseOrderId, quantity: credit.quantity })), parts)
            .map((part) => this.row({
            receiptId: receiptIds.get(part.key) ?? '',
            credit: creditOf.get(part.key) ?? null,
            demand: part.demand,
            quantity: part.quantity,
            serials: [],
            request,
            product: product ?? null,
            receivedAt,
        }));
    }
    /**
     * Seriennummern: die ersten gehen an die Bestellungen (in ihrer
     * Reihenfolge), jede steht an der Zeile, der sie reserviert wurde. Ältere
     * freie Nummern, die diese Buchung mit zuordnete, protokolliert das Depo
     * wie bisher als «aus dem Bestand».
     */
    serialRows(input) {
        const { request, plan, creditedSerials, receiptIds } = input;
        const product = input.products.get(request.productId) ?? null;
        const creditOfSerial = new Map();
        for (const credit of plan) {
            for (const serial of creditedSerials.get(credit.purchaseOrderId) ?? [])
                creditOfSerial.set(serial, credit);
        }
        const demandOfSerial = new Map(input.assigned
            .filter((entry) => entry.productId === request.productId)
            .map((entry) => [entry.serialNumber, entry.demand]));
        const groups = new Map();
        const add = (credit, demand, serial) => {
            const key = `${credit?.purchaseOrderId ?? '-'}:${demand?.lineId ?? '-'}`;
            const group = groups.get(key) ?? { credit, demand, serials: [] };
            group.serials.push(serial);
            groups.set(key, group);
        };
        for (const serial of input.serials) {
            const credit = creditOfSerial.get(serial) ?? null;
            const demand = demandOfSerial.get(serial) ?? null;
            // Weder Bestellung noch wartende Zeile: freier Bestand, nichts zu protokollieren.
            if (credit || demand)
                add(credit, demand, serial);
        }
        for (const [serial, demand] of demandOfSerial) {
            if (!input.serials.includes(serial))
                add(null, demand, serial);
        }
        const receivedAt = new Date();
        const stockReceiptId = `S${input.stamp}`.slice(0, 32);
        return [...groups.values()].map((group) => this.row({
            receiptId: group.credit ? receiptIds.get(group.credit.purchaseOrderId) ?? '' : stockReceiptId,
            credit: group.credit,
            demand: group.demand,
            quantity: group.serials.length,
            serials: group.serials,
            request,
            product,
            receivedAt,
        }));
    }
    row(input) {
        return {
            receiptId: input.receiptId,
            source: input.credit ? 'ORDER' : 'STOCK',
            purchaseOrderId: input.credit?.purchaseOrderId ?? null,
            referenceNumber: input.credit?.referenceNumber ?? null,
            productId: input.request.productId,
            erpCode: input.product?.erpCode ?? null,
            name: input.product?.name ?? '—',
            bomId: input.demand?.bomId ?? null,
            lineId: input.demand?.lineId ?? null,
            productionProjectId: input.demand?.productionProjectId ?? null,
            productionItemId: input.demand?.productionItemId ?? null,
            quantity: (0, productionBom_1.round3)(input.quantity),
            serials: input.serials,
            receivedById: input.credit ? input.request.userId : null,
            receivedAt: input.receivedAt,
        };
    }
    /* ── «Geri al» ──────────────────────────────────────────────────────── */
    async undo(request, commitStock) {
        const entries = request.entries.filter((entry) => entry.receiptId && (entry.quantity > EPS || entry.serials.length));
        if (!entries.length) {
            await commitStock();
            return;
        }
        await this.inTurn(`${request.tenantId}:${request.productId}`, () => this.undoNow({ ...request, entries }, commitStock));
    }
    async undoNow(request, commitStock) {
        const { tenantId, userId, productId } = request;
        const facts = await this.reservations.facts(tenantId, [productId]);
        const ranked = facts.demands.filter((demand) => demand.productId === productId).sort(productionBom_1.byPriority);
        const rankOf = new Map(ranked.map((demand, index) => [demand.lineId, index]));
        const rank = (lineId) => (lineId === null ? Number.POSITIVE_INFINITY : rankOf.get(lineId) ?? ranked.length);
        // 1) Prüfen — noch ist nichts geschrieben.
        const orderLines = new Map();
        const plans = [];
        for (const entry of request.entries) {
            if (!entry.receiptId.startsWith(warehouseGoodsIn_1.DEPOT_RECEIPT_PREFIX))
                throw (0, warehouseGoodsIn_1.goodsInUndoInvalid)('Das ist keine Buchung aus dem Depo.');
            const rows = (await this.goodsIn.forReceipt(tenantId, entry.receiptId))
                .filter((row) => row.productId === productId && row.source === 'ORDER' && row.purchaseOrderId);
            const purchaseOrderId = rows[0]?.purchaseOrderId ?? null;
            if (!purchaseOrderId || rows.some((row) => row.purchaseOrderId !== purchaseOrderId)) {
                throw (0, warehouseGoodsIn_1.goodsInUndoInvalid)('Diese Buchung gibt es nicht (mehr).');
            }
            const changes = (0, productionBomStockReceipt_1.planReceiptReversal)(rows, entry.quantity, entry.serials, rank);
            if (!changes)
                throw (0, warehouseGoodsIn_1.goodsInUndoInvalid)('So viel trägt diese Buchung nicht.');
            const quantity = entry.serials.length ? entry.serials.length : (0, productionBom_1.round3)(entry.quantity);
            const lines = orderLines.get(purchaseOrderId) ?? await this.ledger.orderLines(tenantId, purchaseOrderId, productId);
            const reverted = (0, productionBomStockReceipt_1.planOrderReversal)(lines, quantity);
            // Mehrere Rücknahmen an derselben Bestellung rechnen mit dem Stand nach der vorigen.
            orderLines.set(purchaseOrderId, lines.map((line) => {
                const taken = reverted.find((entryLine) => entryLine.index === line.index)?.quantity ?? 0;
                return { ...line, received: (0, productionBom_1.round3)(line.received - taken) };
            }));
            plans.push({ purchaseOrderId, changes, reverted });
        }
        // 2) Das Depo — scheitert es (Bestand unter 0), bleibt alles, wie es war.
        await commitStock();
        // 3) Protokoll und Bestellung.
        for (const plan of plans) {
            try {
                await this.goodsIn.shrink(tenantId, plan.changes);
                if (plan.reverted.length) {
                    await this.writer.revertReceipt({ tenantId, userId, purchaseOrderId: plan.purchaseOrderId, reverted: plan.reverted });
                }
            }
            catch (error) {
                console.warn('[production-bom] depot goods-in undo failed', plan.purchaseOrderId, error?.message);
            }
        }
    }
}
exports.BomStockReceiptUseCase = BomStockReceiptUseCase;
//# sourceMappingURL=BomStockReceiptUseCase.js.map