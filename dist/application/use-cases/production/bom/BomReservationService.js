"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BomReservationService = void 0;
const productionBom_1 = require("../../../../domain/services/productionBom");
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
class BomReservationService {
    boms;
    stock;
    purchases;
    directory;
    constructor(boms, stock, purchases, directory) {
        this.boms = boms;
        this.stock = stock;
        this.purchases = purchases;
        this.directory = directory;
    }
    async facts(tenantId, productIds) {
        const unique = [...new Set(productIds.filter(Boolean))];
        const [rows, products, serials, incoming] = await Promise.all([
            this.boms.openDemandRows(tenantId, unique),
            this.stock.products(tenantId, unique),
            this.stock.serials(tenantId, unique),
            this.purchases.incoming(tenantId, unique),
        ]);
        const deliveryDates = await this.directory.deliveryDates(tenantId, rows.map((row) => row.productionProjectId));
        const demands = rows.map((row) => ({
            lineId: row.lineId,
            bomId: row.bomId,
            productId: row.productId,
            productionProjectId: row.productionProjectId,
            productionItemId: row.productionItemId,
            openQuantity: Math.max(0, (0, productionBom_1.round3)(row.quantity - row.consumedQuantity)),
            deliveryDate: deliveryDates.get(row.productionProjectId) ?? null,
            approvedAt: row.approvedAt,
            bomSortOrder: row.bomSortOrder,
            lineSortOrder: row.lineSortOrder,
        }));
        const coverage = (0, productionBom_1.computeCoverage)({ demands, products, serials, incoming });
        return { coverage, products, demands, serials, incoming, deliveryDates };
    }
    /**
     * Freie Seriennummern → wartende Zeilen, frühester Termin zuerst («mal
     * varsa direkt otomatik rezerve edilecek … okutulduğunda rezerveye
     * gidecek»). Liefert, wie viele Nummern eine Zuordnung bekamen.
     */
    async assignFreeSerials(tenantId, productIds) {
        return (await this.assignFreeSerialsDetailed(tenantId, productIds)).count;
    }
    /**
     * Wie `assignFreeSerials`, liefert aber jede Zuordnung mit Nummer und
     * wartender Zeile — daraus entsteht «Gelen mallar» (27.09.2026 abends).
     */
    async assignFreeSerialsDetailed(tenantId, productIds) {
        const unique = [...new Set(productIds.filter(Boolean))];
        if (!unique.length)
            return { count: 0, assigned: [], products: new Map() };
        const facts = await this.facts(tenantId, unique);
        const assignments = [];
        for (const productId of unique) {
            const product = facts.products.get(productId);
            if (!product?.serialRequired)
                continue;
            const demands = facts.demands.filter((demand) => demand.productId === productId);
            if (!demands.length)
                continue;
            const free = facts.serials.filter((serial) => serial.productId === productId && !serial.productionItemId && !serial.productionProjectId);
            if (!free.length)
                continue;
            assignments.push(...(0, productionBom_1.serialAssignments)(demands, facts.coverage.lines, free));
        }
        if (!assignments.length)
            return { count: 0, assigned: [], products: facts.products };
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
    async releaseForDevice(tenantId, bom) {
        const productIds = [...new Set(bom.lines.map((line) => line.productId))];
        if (!productIds.length)
            return;
        const facts = await this.facts(tenantId, productIds);
        const release = [];
        for (const productId of productIds) {
            const product = facts.products.get(productId);
            if (!product?.serialRequired)
                continue;
            const onDevice = facts.serials.filter((serial) => serial.productId === productId && serial.productionItemId === bom.productionItemId);
            if (!onDevice.length)
                continue;
            const stillNeeded = facts.demands
                .filter((demand) => demand.productId === productId && demand.productionItemId === bom.productionItemId)
                .reduce((sum, demand) => sum + demand.openQuantity, 0);
            release.push(...(0, productionBom_1.serialsToRelease)(onDevice, stillNeeded).map((serial) => serial.id));
        }
        if (release.length)
            await this.stock.releaseSerials(tenantId, release);
        await this.assignFreeSerials(tenantId, productIds);
    }
    /** Offene Menge der Zeilen einer BOM (für den Entwurf ohne Reservierung). */
    static openQuantities(bom) {
        return new Map(bom.lines.map((line) => [line.id, (0, productionBom_1.openOf)(line)]));
    }
}
exports.BomReservationService = BomReservationService;
//# sourceMappingURL=BomReservationService.js.map