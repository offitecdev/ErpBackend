import { nanoid } from 'nanoid';
import type {
    IProductionDemandReader,
    IProductionProjectRepository,
    IProductionSettingsRepository,
    ISalesSourceReader,
    ITenantDirectory,
} from '../../../domain/repositories/IProductionRepository';
import { planProductionSnapshot, restrictToOrderedDevices } from '../../../domain/services/production';

/**
 * ── DER ABGLEICH: VERKAUF → PRODUKTION ──────────────────────────────────────
 *
 * Liest die Aufträge der Quellfirmen (Einstellungen → Firmenübertragungen;
 * ohne Einstellung die eigene Firma) und legt sie als Produktionsprojekte mit
 * Aufträgen und Geräten ab. Ids bleiben über jeden Abgleich hinweg dieselben;
 * was die Quelle nicht mehr trägt, wird stillgelegt, nie gelöscht.
 *
 * Er läuft, wenn eine Seite des Moduls aufgeht und der letzte Abgleich älter
 * als fünf Minuten ist, und sofort auf Knopfdruck oder nach dem Speichern der
 * Firmenübertragungen. Zwei gleichzeitige Aufrufe derselben Firma teilen sich
 * einen Lauf.
 */

export const PRODUCTION_SYNC_STALE_MS = 5 * 60_000;

export interface ProductionSyncResult {
    synced: boolean;
    lastSyncedAt: string | null;
    projects?: number;
    orders?: number;
    items?: number;
}

const running = new Map<string, Promise<ProductionSyncResult>>();

export class SyncProductionProjectsUseCase {
    constructor(
        private settings: IProductionSettingsRepository,
        private projects: IProductionProjectRepository,
        private reader: ISalesSourceReader,
        private tenants: ITenantDirectory,
        /**
         * SİPARİŞ BAZLI (Vorgabe Samet, 24.09.2026): «Projelerim'e cihazlar
         * otomatik/toplu çekilmemeli» — aktif kalan yalnızca onaylı iç
         * siparişle gelen cihazdır (bkz. restrictToOrderedDevices).
         */
        private demand?: IProductionDemandReader,
    ) {}

    /** Die Firmen, aus denen gelesen wird — nur bestehende, aktive. */
    async sourcesFor(tenantId: string, configured: string[]): Promise<string[]> {
        const active = new Set((await this.tenants.list()).filter((tenant) => tenant.isActive).map((tenant) => tenant.id));
        const wanted = configured.length ? configured : [tenantId];
        return wanted.filter((id) => active.has(id));
    }

    async execute(tenantId: string, options: { force?: boolean } = {}): Promise<ProductionSyncResult> {
        const settings = await this.settings.get(tenantId);
        const last = settings?.lastSyncedAt ?? null;
        if (!options.force && last && Date.now() - last.getTime() < PRODUCTION_SYNC_STALE_MS) {
            return { synced: false, lastSyncedAt: last.toISOString() };
        }
        const pending = running.get(tenantId);
        if (pending) return pending;

        const run = (async (): Promise<ProductionSyncResult> => {
            const demand = this.demand ? await this.demand.read(tenantId) : null;
            // Sipariş gönderen proje şirketleri kendiliğinden kaynak sayılır.
            const configured = settings?.sourceTenantIds ?? [];
            const sources = await this.sourcesFor(tenantId, demand?.sourceTenantIds.length
                ? [...new Set([...(configured.length ? configured : [tenantId]), ...demand.sourceTenantIds])]
                : configured);
            const [snapshot, existing] = await Promise.all([
                this.reader.read(sources),
                this.projects.existingIds(tenantId),
            ]);
            const fullPlan = planProductionSnapshot(snapshot, existing, () => nanoid(12));
            const plan = demand ? restrictToOrderedDevices(fullPlan, demand) : fullPlan;
            const now = new Date();
            await this.projects.applySnapshot(tenantId, plan, now);
            await this.settings.markSynced(tenantId, now);
            return {
                synced: true,
                lastSyncedAt: now.toISOString(),
                projects: plan.projects.length,
                orders: plan.orders.length,
                items: plan.items.length,
            };
        })().finally(() => running.delete(tenantId));

        running.set(tenantId, run);
        return run;
    }
}
