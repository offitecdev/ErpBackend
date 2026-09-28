import type { BomDemand, BomGoodsIn } from '../../../../domain/entities/ProductionBom';
import type { IBomProductionDirectory } from '../../../../domain/repositories/IProductionBomRepository';
import type { IBomGoodsInLedger, IBomStockReceiptRepository } from '../../../../domain/repositories/IBomStockReceiptRepository';
import { byPriority, computeCoverage, round3 } from '../../../../domain/services/productionBom';
import { receiptAllocation } from '../../../../domain/services/productionBomProcurement';
import {
    planOrderReversal,
    planReceiptReversal,
    planStockReceipt,
    serialsForCredits,
    splitAllocation,
    type StockReceiptCredit,
} from '../../../../domain/services/productionBomStockReceipt';
import {
    DEPOT_RECEIPT_PREFIX,
    goodsInUndoInvalid,
    type WarehouseGoodsInHandler,
    type WarehouseGoodsInRequest,
    type WarehouseGoodsInResult,
    type WarehouseGoodsInUndoRequest,
} from '../../../../shared/warehouseGoodsIn';
import type { BomReservationService } from './BomReservationService';

const EPS = 1e-9;

/** Was dieser Anwendungsfall vom Schreiber der Bestellungen braucht (BomPurchaseOrderWriter). */
export interface BomReceiptWriter {
    applyReceipt(input: {
        tenantId: string;
        userId: string;
        purchaseOrderId: string;
        received: Array<{ index: number; quantity: number }>;
    }): Promise<{ status: string }>;
    revertReceipt(input: {
        tenantId: string;
        userId: string;
        purchaseOrderId: string;
        reverted: Array<{ index: number; quantity: number }>;
    }): Promise<{ status: string }>;
}

type GoodsRow = Omit<BomGoodsIn, 'id' | 'tenantId'>;

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
export class BomStockReceiptUseCase implements WarehouseGoodsInHandler {
    /** Je Karte eine Buchung nach der anderen — zwei Scans schreiben nie zugleich dieselbe Bestellung. */
    private queues = new Map<string, Promise<unknown>>();

    constructor(
        private ledger: IBomStockReceiptRepository,
        private goodsIn: IBomGoodsInLedger,
        private reservations: BomReservationService,
        private writer: BomReceiptWriter,
        private directory: IBomProductionDirectory,
        private available: (tenantId: string) => Promise<boolean>,
    ) {}

    private inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
        const previous = this.queues.get(key) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(work);
        const settled = next.catch(() => undefined);
        this.queues.set(key, settled);
        void settled.then(() => {
            if (this.queues.get(key) === settled) this.queues.delete(key);
        });
        return next;
    }

    async book(request: WarehouseGoodsInRequest): Promise<WarehouseGoodsInResult | null> {
        if (!(await this.available(request.tenantId))) return null;
        return this.inTurn(`${request.tenantId}:${request.productId}`, () => this.bookNow(request));
    }

    private async bookNow(request: WarehouseGoodsInRequest): Promise<WarehouseGoodsInResult> {
        const { tenantId, userId, productId } = request;
        const serials = [...new Set(request.serials.map((serial) => serial.trim()).filter(Boolean))];
        const quantity = serials.length ? serials.length : round3(request.quantity);
        const raw = await this.ledger.receivableLines(tenantId, productId);
        const dates = raw.length
            ? await this.directory.deliveryDates(tenantId, [...new Set(raw.map((line) => line.productionProjectId))])
            : new Map<string, Date | null>();
        const plan = planStockReceipt(
            quantity,
            raw.map((line) => ({ ...line, deliveryDate: dates.get(line.productionProjectId) ?? null })),
            request.supplier ? { supplierId: request.supplier.supplierId, supplierName: request.supplier.name } : null,
        );

        // Seriennummern gehen gleich an die wartende Zeile (wie sonst das Depo-Ereignis).
        const serialResult = serials.length ? await this.reservations.assignFreeSerialsDetailed(tenantId, [productId]) : null;
        if (!plan.credits.length && !serialResult) return { credits: [], free: plan.free, reservations: [] };

        const statuses = new Map<string, string>();
        for (const credit of plan.credits) {
            const receipt = await this.writer.applyReceipt({ tenantId, userId, purchaseOrderId: credit.purchaseOrderId, received: credit.lines });
            statuses.set(credit.purchaseOrderId, receipt.status);
        }

        const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const receiptIds = new Map(plan.credits.map((credit, index) => [
            credit.purchaseOrderId,
            `${DEPOT_RECEIPT_PREFIX}${stamp}${index.toString(36)}`.slice(0, 32),
        ]));
        const creditedSerials = serialsForCredits(plan.credits.map((credit) => ({ key: credit.purchaseOrderId, quantity: credit.quantity })), serials);
        const assignedBySerial = new Map((serialResult?.assigned ?? [])
            .filter((entry) => entry.productId === productId)
            .map((entry) => [entry.serialNumber, entry]));

        // Das Protokoll darf die Buchung nie scheitern lassen — Depo und Bestellung stehen schon.
        try {
            const rows = serialResult
                ? this.serialRows({ request, plan: plan.credits, creditedSerials, serials, stamp, receiptIds, assigned: serialResult.assigned, products: serialResult.products })
                : await this.quantityRows({ request, quantity, plan: plan.credits, receiptIds });
            if (rows.length) await this.goodsIn.add(tenantId, rows);
        } catch (error) {
            console.warn('[production-bom] depot goods-in log failed', (error as Error)?.message);
        }

        const reservedDemands = serials
            .map((serial) => assignedBySerial.get(serial)?.demand)
            .filter((demand): demand is BomDemand => Boolean(demand));
        const projectIds = [...new Set([...plan.credits, ...reservedDemands].map((entry) => entry.productionProjectId))];
        const itemIds = [...new Set([...plan.credits, ...reservedDemands].map((entry) => entry.productionItemId))];
        const [projects, devices] = await Promise.all([
            projectIds.length ? this.directory.projects(tenantId, projectIds) : Promise.resolve(new Map<string, { projectNumber: string; projectName: string }>()),
            itemIds.length ? this.directory.devices(tenantId, itemIds) : Promise.resolve(new Map<string, { name: string }>()),
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
                    ordered: round3(own.reduce((sum, line) => sum + line.quantity, 0)),
                    received: round3(own.reduce((sum, line) => sum + line.received, 0) + credit.quantity),
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
    private async quantityRows(input: {
        request: WarehouseGoodsInRequest;
        quantity: number;
        plan: StockReceiptCredit[];
        receiptIds: Map<string, string>;
    }): Promise<GoodsRow[]> {
        const { request, plan, receiptIds } = input;
        const credited = round3(plan.reduce((sum, credit) => sum + credit.quantity, 0));
        if (credited <= EPS) return [];
        const after = await this.reservations.facts(request.tenantId, [request.productId]);
        const product = after.products.get(request.productId);
        const products = new Map(after.products);
        if (product) products.set(request.productId, { ...product, quantity: Math.max(0, round3(product.quantity - input.quantity)) });
        const before = computeCoverage({ demands: after.demands, products, serials: after.serials, incoming: after.incoming });
        const demands = after.demands.filter((demand) => demand.productId === request.productId);
        const parts = receiptAllocation(credited, demands, before.lines, after.coverage.lines);
        const creditOf = new Map(plan.map((credit) => [credit.purchaseOrderId, credit]));
        const receivedAt = new Date();
        return splitAllocation(plan.map((credit) => ({ key: credit.purchaseOrderId, quantity: credit.quantity })), parts)
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
    private serialRows(input: {
        request: WarehouseGoodsInRequest;
        plan: StockReceiptCredit[];
        creditedSerials: Map<string, string[]>;
        serials: string[];
        stamp: string;
        receiptIds: Map<string, string>;
        assigned: Array<{ serialNumber: string; productId: string; demand: BomDemand }>;
        products: Map<string, { erpCode: string | null; name: string }>;
    }): GoodsRow[] {
        const { request, plan, creditedSerials, receiptIds } = input;
        const product = input.products.get(request.productId) ?? null;
        const creditOfSerial = new Map<string, StockReceiptCredit>();
        for (const credit of plan) {
            for (const serial of creditedSerials.get(credit.purchaseOrderId) ?? []) creditOfSerial.set(serial, credit);
        }
        const demandOfSerial = new Map(input.assigned
            .filter((entry) => entry.productId === request.productId)
            .map((entry) => [entry.serialNumber, entry.demand]));
        const groups = new Map<string, { credit: StockReceiptCredit | null; demand: BomDemand | null; serials: string[] }>();
        const add = (credit: StockReceiptCredit | null, demand: BomDemand | null, serial: string) => {
            const key = `${credit?.purchaseOrderId ?? '-'}:${demand?.lineId ?? '-'}`;
            const group = groups.get(key) ?? { credit, demand, serials: [] };
            group.serials.push(serial);
            groups.set(key, group);
        };
        for (const serial of input.serials) {
            const credit = creditOfSerial.get(serial) ?? null;
            const demand = demandOfSerial.get(serial) ?? null;
            // Weder Bestellung noch wartende Zeile: freier Bestand, nichts zu protokollieren.
            if (credit || demand) add(credit, demand, serial);
        }
        for (const [serial, demand] of demandOfSerial) {
            if (!input.serials.includes(serial)) add(null, demand, serial);
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

    private row(input: {
        receiptId: string;
        credit: StockReceiptCredit | null;
        demand: BomDemand | null;
        quantity: number;
        serials: string[];
        request: WarehouseGoodsInRequest;
        product: { erpCode: string | null; name: string } | null;
        receivedAt: Date;
    }): GoodsRow {
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
            quantity: round3(input.quantity),
            serials: input.serials,
            receivedById: input.credit ? input.request.userId : null,
            receivedAt: input.receivedAt,
        };
    }

    /* ── «Geri al» ──────────────────────────────────────────────────────── */

    async undo(request: WarehouseGoodsInUndoRequest, commitStock: () => Promise<void>): Promise<void> {
        const entries = request.entries.filter((entry) => entry.receiptId && (entry.quantity > EPS || entry.serials.length));
        if (!entries.length) {
            await commitStock();
            return;
        }
        await this.inTurn(`${request.tenantId}:${request.productId}`, () => this.undoNow({ ...request, entries }, commitStock));
    }

    private async undoNow(request: WarehouseGoodsInUndoRequest, commitStock: () => Promise<void>): Promise<void> {
        const { tenantId, userId, productId } = request;
        const facts = await this.reservations.facts(tenantId, [productId]);
        const ranked = facts.demands.filter((demand) => demand.productId === productId).sort(byPriority);
        const rankOf = new Map(ranked.map((demand, index) => [demand.lineId, index]));
        const rank = (lineId: string | null): number => (lineId === null ? Number.POSITIVE_INFINITY : rankOf.get(lineId) ?? ranked.length);

        // 1) Prüfen — noch ist nichts geschrieben.
        const orderLines = new Map<string, Array<{ index: number; quantity: number; received: number }>>();
        const plans: Array<{
            purchaseOrderId: string;
            changes: Array<{ id: string; quantity: number; serials: string[] }>;
            reverted: Array<{ index: number; quantity: number }>;
        }> = [];
        for (const entry of request.entries) {
            if (!entry.receiptId.startsWith(DEPOT_RECEIPT_PREFIX)) throw goodsInUndoInvalid('Das ist keine Buchung aus dem Depo.');
            const rows = (await this.goodsIn.forReceipt(tenantId, entry.receiptId))
                .filter((row) => row.productId === productId && row.source === 'ORDER' && row.purchaseOrderId);
            const purchaseOrderId = rows[0]?.purchaseOrderId ?? null;
            if (!purchaseOrderId || rows.some((row) => row.purchaseOrderId !== purchaseOrderId)) {
                throw goodsInUndoInvalid('Diese Buchung gibt es nicht (mehr).');
            }
            const changes = planReceiptReversal(rows, entry.quantity, entry.serials, rank);
            if (!changes) throw goodsInUndoInvalid('So viel trägt diese Buchung nicht.');
            const quantity = entry.serials.length ? entry.serials.length : round3(entry.quantity);
            const lines = orderLines.get(purchaseOrderId) ?? await this.ledger.orderLines(tenantId, purchaseOrderId, productId);
            const reverted = planOrderReversal(lines, quantity);
            // Mehrere Rücknahmen an derselben Bestellung rechnen mit dem Stand nach der vorigen.
            orderLines.set(purchaseOrderId, lines.map((line) => {
                const taken = reverted.find((entryLine) => entryLine.index === line.index)?.quantity ?? 0;
                return { ...line, received: round3(line.received - taken) };
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
            } catch (error) {
                console.warn('[production-bom] depot goods-in undo failed', plan.purchaseOrderId, (error as Error)?.message);
            }
        }
    }
}
