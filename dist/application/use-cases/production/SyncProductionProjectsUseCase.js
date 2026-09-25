"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SyncProductionProjectsUseCase = exports.PRODUCTION_SYNC_STALE_MS = void 0;
const nanoid_1 = require("nanoid");
const production_1 = require("../../../domain/services/production");
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
exports.PRODUCTION_SYNC_STALE_MS = 5 * 60_000;
const running = new Map();
class SyncProductionProjectsUseCase {
    settings;
    projects;
    reader;
    tenants;
    demand;
    constructor(settings, projects, reader, tenants, 
    /**
     * SİPARİŞ BAZLI (Vorgabe Samet, 24.09.2026): «Projelerim'e cihazlar
     * otomatik/toplu çekilmemeli» — aktif kalan yalnızca onaylı iç
     * siparişle gelen cihazdır (bkz. restrictToOrderedDevices).
     */
    demand) {
        this.settings = settings;
        this.projects = projects;
        this.reader = reader;
        this.tenants = tenants;
        this.demand = demand;
    }
    /** Die Firmen, aus denen gelesen wird — nur bestehende, aktive. */
    async sourcesFor(tenantId, configured) {
        const active = new Set((await this.tenants.list()).filter((tenant) => tenant.isActive).map((tenant) => tenant.id));
        const wanted = configured.length ? configured : [tenantId];
        return wanted.filter((id) => active.has(id));
    }
    async execute(tenantId, options = {}) {
        const settings = await this.settings.get(tenantId);
        const last = settings?.lastSyncedAt ?? null;
        if (!options.force && last && Date.now() - last.getTime() < exports.PRODUCTION_SYNC_STALE_MS) {
            return { synced: false, lastSyncedAt: last.toISOString() };
        }
        const pending = running.get(tenantId);
        if (pending)
            return pending;
        const run = (async () => {
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
            const fullPlan = (0, production_1.planProductionSnapshot)(snapshot, existing, () => (0, nanoid_1.nanoid)(12));
            const plan = demand ? (0, production_1.restrictToOrderedDevices)(fullPlan, demand) : fullPlan;
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
exports.SyncProductionProjectsUseCase = SyncProductionProjectsUseCase;
//# sourceMappingURL=SyncProductionProjectsUseCase.js.map