import type {
    IProductionSupplierLinkRepository,
    ProductionSupplierLink,
    ProductionSupplierOption,
} from '../../../domain/repositories/IProductionRepository';
import { productionError } from './productionErrors';
import type { SyncProductionProjectsUseCase } from './SyncProductionProjectsUseCase';

export interface ProductionSupplierLinksDto {
    /** Je Produktionsfirma im Firmenbaum: welcher eigene Lieferant sie ist. */
    producers: Array<{ id: string; name: string; supplierId: string | null }>;
    suppliers: ProductionSupplierOption[];
}

/**
 * ── MODUL-EINSTELLUNGEN › PRODUKTION › PRODUKTIONSLIEFERANT ─────────────────
 *
 * Vorgabe Samet (02.10.2026): «Modül ayarları üretimde üretim tedarikçisi seç
 * diye bir alan olsun … seçilen tedarikçi seçilirse bizim üretim olan
 * şirkette proje olarak açılsın.»
 *
 * Die bestellende Firma wählt je Produktionsfirma ihres Firmenbaums den
 * Lieferanten, der diese Produktionsfirma IST. Eine bestätigte Bestellung bei
 * diesem Lieferanten öffnet danach das Projekt in der Produktionsfirma (siehe
 * shared/producerOrders.ts, Weg 3). Nach dem Speichern gleichen die
 * betroffenen Produktionsfirmen sofort ab — bereits bestätigte Bestellungen
 * erscheinen dort ohne Umweg.
 */
export class ProductionSupplierLinksUseCase {
    constructor(
        private links: IProductionSupplierLinkRepository,
        private sync: SyncProductionProjectsUseCase,
    ) {}

    async get(tenantId: string): Promise<ProductionSupplierLinksDto> {
        const [links, producers, suppliers] = await Promise.all([
            this.links.list(tenantId),
            this.links.producers(tenantId),
            this.links.suppliers(tenantId),
        ]);
        const byProducer = new Map(links.map((link) => [link.producerTenantId, link.supplierId]));
        return {
            producers: producers.map((producer) => ({ ...producer, supplierId: byProducer.get(producer.id) ?? null })),
            suppliers,
        };
    }

    async save(tenantId: string, input: unknown, userId: string): Promise<ProductionSupplierLinksDto> {
        if (!Array.isArray(input)) throw productionError('SUPPLIER_INVALID', 'Die Zuordnung fehlt.');
        const [producers, suppliers, previous] = await Promise.all([
            this.links.producers(tenantId),
            this.links.suppliers(tenantId),
            this.links.list(tenantId),
        ]);
        const producerIds = new Set(producers.map((producer) => producer.id));
        const supplierIds = new Set(suppliers.map((supplier) => supplier.id));

        const wanted: ProductionSupplierLink[] = [];
        for (const entry of input) {
            const producerTenantId = String((entry as any)?.producerTenantId ?? '').trim();
            const supplierId = String((entry as any)?.supplierId ?? '').trim();
            // Ohne Lieferant: für diese Produktionsfirma ist nichts eingestellt.
            if (!producerTenantId || !supplierId) continue;
            if (!producerIds.has(producerTenantId)) {
                throw productionError('SUPPLIER_INVALID', 'Die gewählte Produktionsfirma besteht nicht oder ist nicht aktiv.', { details: [producerTenantId] });
            }
            if (!supplierIds.has(supplierId)) {
                throw productionError('SUPPLIER_INVALID', 'Der gewählte Lieferant gehört nicht zu dieser Firma.', { details: [supplierId] });
            }
            if (wanted.some((link) => link.producerTenantId === producerTenantId)) continue;
            if (wanted.some((link) => link.supplierId === supplierId)) {
                throw productionError('SUPPLIER_DUPLICATE', 'Ein Lieferant kann nur einer Produktionsfirma zugeordnet sein.', { details: [supplierId] });
            }
            wanted.push({ producerTenantId, supplierId });
        }

        await this.links.replace(tenantId, wanted, userId);

        // Alte UND neue Produktionsfirmen: eine weggenommene Zuordnung räumt
        // dort die Geräte wieder ab. Im Hintergrund — Speichern wartet nicht.
        const affected = new Set([...previous, ...wanted].map((link) => link.producerTenantId));
        for (const producerTenantId of affected) {
            void this.sync.execute(producerTenantId, { force: true }).catch((error: any) => {
                console.warn('[production] producer sync after supplier link failed', producerTenantId, error?.message);
            });
        }
        return this.get(tenantId);
    }
}
