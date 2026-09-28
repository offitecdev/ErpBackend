import type { Bom } from '../../../../domain/entities/ProductionBom';
import type {
    IBomProductionDirectory,
    IBomRepository,
    IBomStockReader,
} from '../../../../domain/repositories/IProductionBomRepository';
import { bomError, CONFIRMED_ORDER_STATUSES } from '../../../../domain/services/productionBom';
import {
    costingLine,
    costingTotals,
    currencyOf,
    mergeTotals,
    unitPriceOfItem,
    type CostingLine,
    type CostingLineFacts,
    type CostingPrice,
    type CostingTotal,
} from '../../../../domain/services/productionBomCosting';
import type { BomActor } from './BomTemplatesUseCase';
import type { DeviceBomsUseCase } from './DeviceBomsUseCase';

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

export interface CostingDeviceDto {
    id: string;
    name: string;
    positionNumber: string | null;
    bomNumbers: string[];
    lines: CostingLine[];
    totals: CostingTotal[];
    /** Kalemler ohne Alışpreis (weder Karte noch Preisanfrage). */
    missingPrice: number;
    /** Kalemler mit bestätigtem Bestellpreis. */
    actualLines: number;
}

export interface CostingProjectSummaryDto {
    id: string;
    projectNumber: string;
    projectName: string;
    customerName: string | null;
    deliveryDate: string | null;
    devices: number;
    lines: number;
    missingPrice: number;
    actualLines: number;
    totals: CostingTotal[];
}

export interface CostingProjectDto extends CostingProjectSummaryDto {
    deviceList: CostingDeviceDto[];
}

/**
 * ── KALKÜLASYON (27.09.2026 abends, Vorgabe Samet) ───────────────────────────
 *
 * «Bu da direkt başka bir sayfada olması lazım, bomda değil … temiz olsun, çok
 *  detay olmasın.» Aus allen BOMs eines Projekts (Haupt- und Alt-BOMs, Mekanik
 * und Elektrik) je Gerät die Materialliste mit Menge, Alışpreis und Summe —
 * geplant (Depo-Karte, sonst Preisanfrage) gegen gerçek (bestätigte
 * Bestellungen). Preise sieht nur, wer den Einkauf sieht (Buchhaltung,
 * Administratorrolle) oder die Seite «Kalkülasyon» hat.
 */
export class BomCostingUseCase {
    constructor(
        private boms: IBomRepository,
        private stock: IBomStockReader,
        private directory: IBomProductionDirectory,
        private devices: DeviceBomsUseCase,
    ) {}

    private assertCanSee(actor: BomActor): void {
        if (actor.isAdmin || actor.canSeeProcurement || actor.canSeeCosting) return;
        throw bomError('FORBIDDEN', 'Die Kalkulation sehen Buchhaltung und Administratorrolle.', { status: 403 });
    }

    async projects(tenantId: string, actor: BomActor): Promise<{ projects: CostingProjectSummaryDto[] }> {
        this.assertCanSee(actor);
        const boms = await this.boms.listForProjects(tenantId, null);
        const built = await this.build(tenantId, boms);
        const projects = built.map(({ deviceList: _devices, ...summary }) => summary)
            .sort((a, b) => (a.deliveryDate ?? '9999').localeCompare(b.deliveryDate ?? '9999') || b.projectNumber.localeCompare(a.projectNumber));
        return { projects };
    }

    async project(tenantId: string, actor: BomActor, projectId: string): Promise<CostingProjectDto> {
        this.assertCanSee(actor);
        const boms = await this.boms.listForProjects(tenantId, [projectId]);
        const [built] = await this.build(tenantId, boms);
        if (built) return built;
        const [project, dates] = await Promise.all([
            this.directory.project(tenantId, projectId),
            this.directory.deliveryDates(tenantId, [projectId]),
        ]);
        if (!project) throw bomError('NOT_FOUND', 'Projekt nicht gefunden.', { status: 404 });
        return {
            id: project.id,
            projectNumber: project.projectNumber,
            projectName: project.projectName,
            customerName: project.customerName,
            deliveryDate: iso(dates.get(project.id) ?? null),
            devices: 0,
            lines: 0,
            missingPrice: 0,
            actualLines: 0,
            totals: [],
            deviceList: [],
        };
    }

    /** Alle Projekte der BOMs auf einmal: Karten, Belege und Namen je ein Rundgang. */
    private async build(tenantId: string, boms: Bom[]): Promise<CostingProjectDto[]> {
        if (!boms.length) return [];
        const productIds = [...new Set(boms.flatMap((bom) => bom.lines.map((line) => line.productId)))];
        const projectIds = [...new Set(boms.map((bom) => bom.productionProjectId))];
        const itemIds = [...new Set(boms.map((bom) => bom.productionItemId))];
        const [products, purchases, projects, devices, dates] = await Promise.all([
            this.stock.products(tenantId, productIds),
            this.devices.purchasesOf(tenantId, boms.map((bom) => bom.id)),
            this.directory.projects(tenantId, projectIds),
            this.directory.devices(tenantId, itemIds),
            this.directory.deliveryDates(tenantId, projectIds),
        ]);

        // Je BOM-Zeile: günstigste Preisanfrage und bestätigte Bestellpositionen.
        const quoteByLine = new Map<string, CostingPrice>();
        const ordersByLine = new Map<string, CostingLineFacts['orders']>();
        for (const { link, order } of purchases) {
            const status = String(order.status).toUpperCase();
            const currency = currencyOf(order.currency);
            for (const item of order.items) {
                const lineId = typeof item.bomLineId === 'string' ? item.bomLineId : null;
                if (!lineId) continue;
                const price = unitPriceOfItem(item);
                if (!price) continue;
                if (link.kind === 'REQUEST') {
                    const best = quoteByLine.get(lineId);
                    if (!best || price.unit < best.unit) quoteByLine.set(lineId, { unit: price.unit, currency });
                } else if (CONFIRMED_ORDER_STATUSES.has(status)) {
                    const list = ordersByLine.get(lineId) ?? [];
                    list.push({ ...price, currency });
                    ordersByLine.set(lineId, list);
                }
            }
        }

        const result: CostingProjectDto[] = [];
        for (const projectId of projectIds) {
            const projectBoms = boms.filter((bom) => bom.productionProjectId === projectId);
            const deviceList: CostingDeviceDto[] = [];
            for (const itemId of [...new Set(projectBoms.map((bom) => bom.productionItemId))]) {
                const deviceBoms = projectBoms
                    .filter((bom) => bom.productionItemId === itemId)
                    .sort((a, b) => a.area.localeCompare(b.area) || (a.kind === b.kind ? 0 : a.kind === 'MAIN' ? -1 : 1) || a.sortOrder - b.sortOrder);
                // Dieselbe Karte in mehreren BOMs des Geräts ist EIN Kalem (Menge summiert).
                const grouped = new Map<string, CostingLineFacts>();
                for (const bom of deviceBoms) {
                    for (const line of bom.lines) {
                        const key = `${line.productId}:${line.unit}`;
                        const product = products.get(line.productId);
                        const facts = grouped.get(key) ?? {
                            key,
                            productId: line.productId,
                            erpCode: product?.erpCode ?? line.erpCode,
                            name: product?.name ?? line.name,
                            unit: line.unit,
                            quantity: 0,
                            card: product?.purchasePrice && product.purchasePrice > 0
                                ? { unit: product.purchasePrice, currency: currencyOf(product.currency) }
                                : null,
                            quote: null,
                            orders: [],
                        };
                        facts.quantity += line.quantity;
                        const quote = quoteByLine.get(line.id);
                        if (quote && (!facts.quote || quote.unit < facts.quote.unit)) facts.quote = quote;
                        facts.orders.push(...(ordersByLine.get(line.id) ?? []));
                        grouped.set(key, facts);
                    }
                }
                const lines = [...grouped.values()].map(costingLine);
                const device = devices.get(itemId);
                deviceList.push({
                    id: itemId,
                    name: device?.name ?? '—',
                    positionNumber: device?.positionNumber ?? null,
                    bomNumbers: deviceBoms.map((bom) => bom.bomNumber),
                    lines,
                    totals: costingTotals(lines),
                    missingPrice: lines.filter((line) => !line.plan).length,
                    actualLines: lines.filter((line) => line.actual).length,
                });
            }
            deviceList.sort((a, b) => (a.positionNumber ?? '').localeCompare(b.positionNumber ?? '', undefined, { numeric: true }) || a.name.localeCompare(b.name));
            const project = projects.get(projectId);
            result.push({
                id: projectId,
                projectNumber: project?.projectNumber ?? '—',
                projectName: project?.projectName ?? '',
                customerName: project?.customerName ?? null,
                deliveryDate: iso(dates.get(projectId) ?? null),
                devices: deviceList.length,
                lines: deviceList.reduce((sum, device) => sum + device.lines.length, 0),
                missingPrice: deviceList.reduce((sum, device) => sum + device.missingPrice, 0),
                actualLines: deviceList.reduce((sum, device) => sum + device.actualLines, 0),
                totals: mergeTotals(deviceList.map((device) => device.totals)),
                deviceList,
            });
        }
        return result;
    }
}
