import type {
    Bom,
    BomDemand,
    BomIncomingLine,
    BomSerialFact,
    BomStockProduct,
} from '../../../../domain/entities/ProductionBom';
import type {
    IBomProductionDirectory,
    IBomPurchaseRepository,
    IBomRepository,
    IBomStockReader,
} from '../../../../domain/repositories/IProductionBomRepository';
import {
    computeCoverage,
    openOf,
    round3,
    serialAssignments,
    serialsToRelease,
    type CoverageResult,
} from '../../../../domain/services/productionBom';

export interface CoverageFacts {
    coverage: CoverageResult;
    products: Map<string, BomStockProduct>;
    demands: BomDemand[];
    serials: BomSerialFact[];
    incoming: BomIncomingLine[];
    deliveryDates: Map<string, Date | null>;
}

/**
 * ── DIE RESERVIERUNG (27.09.2026) ────────────────────────────────────────────
 *
 * Holt die Tatsachen (offene Zeilen ALLER freigegebenen BOMs der Firma für
 * diese Karten, Bestand, Seriennummern, bestellte Ware, Liefertermine) und
 * lässt `computeCoverage` rechnen. Gespeichert wird nur, was physisch an
 * einer Nummer hängt: freie Seriennummern bekommen Projekt und Gerät der
 * wartenden Zeile mit dem frühesten Termin, nicht mehr gebrauchte werden
 * wieder frei.
 */
export class BomReservationService {
    constructor(
        private boms: IBomRepository,
        private stock: IBomStockReader,
        private purchases: IBomPurchaseRepository,
        private directory: IBomProductionDirectory,
    ) {}

    async facts(tenantId: string, productIds: string[]): Promise<CoverageFacts> {
        const unique = [...new Set(productIds.filter(Boolean))];
        const [rows, products, serials, incoming] = await Promise.all([
            this.boms.openDemandRows(tenantId, unique),
            this.stock.products(tenantId, unique),
            this.stock.serials(tenantId, unique),
            this.purchases.incoming(tenantId, unique),
        ]);
        const deliveryDates = await this.directory.deliveryDates(tenantId, rows.map((row) => row.productionProjectId));
        const demands: BomDemand[] = rows.map((row) => ({
            lineId: row.lineId,
            bomId: row.bomId,
            productId: row.productId,
            productionProjectId: row.productionProjectId,
            productionItemId: row.productionItemId,
            openQuantity: Math.max(0, round3(row.quantity - row.consumedQuantity)),
            deliveryDate: deliveryDates.get(row.productionProjectId) ?? null,
            approvedAt: row.approvedAt,
            bomSortOrder: row.bomSortOrder,
            lineSortOrder: row.lineSortOrder,
        }));
        const coverage = computeCoverage({ demands, products, serials, incoming });
        return { coverage, products, demands, serials, incoming, deliveryDates };
    }

    /**
     * Freie Seriennummern → wartende Zeilen, frühester Termin zuerst («mal
     * varsa direkt otomatik rezerve edilecek … okutulduğunda rezerveye
     * gidecek»). Liefert, wie viele Nummern eine Zuordnung bekamen.
     */
    async assignFreeSerials(tenantId: string, productIds: string[]): Promise<number> {
        return (await this.assignFreeSerialsDetailed(tenantId, productIds)).count;
    }

    /**
     * Wie `assignFreeSerials`, liefert aber jede Zuordnung mit Nummer und
     * wartender Zeile — daraus entsteht «Gelen mallar» (27.09.2026 abends).
     */
    async assignFreeSerialsDetailed(tenantId: string, productIds: string[]): Promise<{
        count: number;
        assigned: Array<{ serialId: string; serialNumber: string; productId: string; demand: BomDemand }>;
        products: Map<string, BomStockProduct>;
    }> {
        const unique = [...new Set(productIds.filter(Boolean))];
        if (!unique.length) return { count: 0, assigned: [], products: new Map() };
        const facts = await this.facts(tenantId, unique);
        const assignments: Array<{ serialId: string; demand: BomDemand }> = [];
        for (const productId of unique) {
            const product = facts.products.get(productId);
            if (!product?.serialRequired) continue;
            const demands = facts.demands.filter((demand) => demand.productId === productId);
            if (!demands.length) continue;
            const free = facts.serials.filter((serial) => serial.productId === productId && !serial.productionItemId && !serial.productionProjectId);
            if (!free.length) continue;
            assignments.push(...serialAssignments(demands, facts.coverage.lines, free));
        }
        if (!assignments.length) return { count: 0, assigned: [], products: facts.products };
        const serialById = new Map(facts.serials.map((serial) => [serial.id, serial]));
        const [projects, devices] = await Promise.all([
            this.directory.projects(tenantId, assignments.map((entry) => entry.demand.productionProjectId)),
            this.directory.devices(tenantId, assignments.map((entry) => entry.demand.productionItemId)),
        ]);
        const count = await this.stock.assignSerials(tenantId, assignments.map(({ serialId, demand }) => {
            const project = projects.get(demand.productionProjectId);
            const device = devices.get(demand.productionItemId);
            return {
                serialId,
                productionProjectId: demand.productionProjectId,
                productionItemId: demand.productionItemId,
                projectNumber: project?.projectNumber ?? null,
                projectName: project?.projectName ?? null,
                deviceName: device?.name ?? null,
            };
        }));
        return {
            count,
            products: facts.products,
            assigned: assignments.flatMap(({ serialId, demand }) => {
                const serial = serialById.get(serialId);
                return serial ? [{ serialId, serialNumber: serial.serialNumber, productId: serial.productId, demand }] : [];
            }),
        };
    }

    /**
     * Eine BOM verlässt die Freigabe (zurück in den Entwurf, gelöscht): die
     * Nummern ihres Geräts, die keine andere freigegebene Zeile desselben
     * Geräts mehr braucht, werden frei — und gehen gleich an die nächste
     * wartende Zeile.
     */
    async releaseForDevice(tenantId: string, bom: Pick<Bom, 'productionItemId' | 'lines'>): Promise<void> {
        const productIds = [...new Set(bom.lines.map((line) => line.productId))];
        if (!productIds.length) return;
        const facts = await this.facts(tenantId, productIds);
        const release: string[] = [];
        for (const productId of productIds) {
            const product = facts.products.get(productId);
            if (!product?.serialRequired) continue;
            const onDevice = facts.serials.filter((serial) => serial.productId === productId && serial.productionItemId === bom.productionItemId);
            if (!onDevice.length) continue;
            const stillNeeded = facts.demands
                .filter((demand) => demand.productId === productId && demand.productionItemId === bom.productionItemId)
                .reduce((sum, demand) => sum + demand.openQuantity, 0);
            release.push(...serialsToRelease(onDevice, stillNeeded).map((serial) => serial.id));
        }
        if (release.length) await this.stock.releaseSerials(tenantId, release);
        await this.assignFreeSerials(tenantId, productIds);
    }

    /** Offene Menge der Zeilen einer BOM (für den Entwurf ohne Reservierung). */
    static openQuantities(bom: Pick<Bom, 'lines'>): Map<string, number> {
        return new Map(bom.lines.map((line) => [line.id, openOf(line)]));
    }
}
