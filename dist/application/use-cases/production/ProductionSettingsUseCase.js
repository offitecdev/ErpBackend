"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProductionSettingsUseCase = void 0;
const productionErrors_1 = require("./productionErrors");
const MAX_SOURCES = 50;
const rootOf = (tenants, id) => {
    let current = tenants.get(id) ?? null;
    const seen = new Set();
    while (current?.parentTenantId && !seen.has(current.id)) {
        seen.add(current.id);
        const parent = tenants.get(current.parentTenantId);
        if (!parent)
            break;
        current = parent;
    }
    return current;
};
/**
 * ── EINSTELLUNGEN → FIRMENÜBERTRAGUNGEN ─────────────────────────────────────
 * Aus welcher Firma (bzw. Firmengruppe) die Produktion ihre Projekte bezieht
 * (Vorgabe Samet). Zur Wahl stehen alle aktiven Firmen der Installation,
 * nach Firmengruppe geordnet. Nach dem Speichern wird sofort abgeglichen.
 */
class ProductionSettingsUseCase {
    settings;
    tenants;
    sync;
    constructor(settings, tenants, sync) {
        this.settings = settings;
        this.tenants = tenants;
        this.sync = sync;
    }
    async get(tenantId, enabled) {
        const [settings, directory] = await Promise.all([this.settings.get(tenantId), this.tenants.list()]);
        const byId = new Map(directory.map((tenant) => [tenant.id, tenant]));
        const companies = directory
            .filter((tenant) => tenant.isActive)
            .map((tenant) => {
            const root = rootOf(byId, tenant.id) ?? tenant;
            return { id: tenant.id, name: tenant.name, groupId: root.id, groupName: root.name, isRoot: root.id === tenant.id };
        })
            .sort((a, b) => a.groupName.localeCompare(b.groupName) || Number(b.isRoot) - Number(a.isRoot) || a.name.localeCompare(b.name));
        const sourceTenantIds = settings?.sourceTenantIds ?? [];
        return {
            enabled,
            sourceTenantIds,
            effectiveSourceTenantIds: await this.sync.sourcesFor(tenantId, sourceTenantIds),
            lastSyncedAt: settings?.lastSyncedAt ? settings.lastSyncedAt.toISOString() : null,
            companies,
        };
    }
    async save(tenantId, input, userId, enabled) {
        if (!Array.isArray(input))
            throw (0, productionErrors_1.productionError)('SOURCE_INVALID', 'Die Quellfirmen fehlen.');
        const wanted = [...new Set(input.map((value) => String(value ?? '').trim()).filter(Boolean))];
        if (wanted.length > MAX_SOURCES)
            throw (0, productionErrors_1.productionError)('SOURCE_INVALID', 'Zu viele Quellfirmen.');
        const directory = await this.tenants.list();
        const active = new Set(directory.filter((tenant) => tenant.isActive).map((tenant) => tenant.id));
        const unknown = wanted.filter((id) => !active.has(id));
        if (unknown.length) {
            throw (0, productionErrors_1.productionError)('SOURCE_INVALID', 'Eine gewählte Firma besteht nicht oder ist nicht aktiv.', { details: unknown });
        }
        await this.settings.save(tenantId, wanted, userId);
        const sync = await this.sync.execute(tenantId, { force: true });
        return { settings: await this.get(tenantId, enabled), sync };
    }
}
exports.ProductionSettingsUseCase = ProductionSettingsUseCase;
//# sourceMappingURL=ProductionSettingsUseCase.js.map