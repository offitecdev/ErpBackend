import type {
    IProductionSettingsRepository,
    ITenantDirectory,
    TenantDirectoryEntry,
} from '../../../domain/repositories/IProductionRepository';
import { productionError } from './productionErrors';
import type { SyncProductionProjectsUseCase, ProductionSyncResult } from './SyncProductionProjectsUseCase';

export interface TransferCompanyDto {
    id: string;
    name: string;
    /** Die Firmengruppe (Wurzel des Firmenbaums). */
    groupId: string;
    groupName: string;
    isRoot: boolean;
}

export interface ProductionSettingsDto {
    /** Ist das Modul in dieser Firma eingeschaltet (Firmenkategorie)? */
    enabled: boolean;
    /** Gespeicherte Auswahl — leer heisst: die eigene Firma. */
    sourceTenantIds: string[];
    /** Woraus tatsächlich gelesen wird. */
    effectiveSourceTenantIds: string[];
    lastSyncedAt: string | null;
    companies: TransferCompanyDto[];
}

const MAX_SOURCES = 50;

const rootOf = (tenants: Map<string, TenantDirectoryEntry>, id: string): TenantDirectoryEntry | null => {
    let current = tenants.get(id) ?? null;
    const seen = new Set<string>();
    while (current?.parentTenantId && !seen.has(current.id)) {
        seen.add(current.id);
        const parent = tenants.get(current.parentTenantId);
        if (!parent) break;
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
export class ProductionSettingsUseCase {
    constructor(
        private settings: IProductionSettingsRepository,
        private tenants: ITenantDirectory,
        private sync: SyncProductionProjectsUseCase,
    ) {}

    async get(tenantId: string, enabled: boolean): Promise<ProductionSettingsDto> {
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

    async save(
        tenantId: string,
        input: unknown,
        userId: string,
        enabled: boolean,
    ): Promise<{ settings: ProductionSettingsDto; sync: ProductionSyncResult }> {
        if (!Array.isArray(input)) throw productionError('SOURCE_INVALID', 'Die Quellfirmen fehlen.');
        const wanted = [...new Set(input.map((value) => String(value ?? '').trim()).filter(Boolean))];
        if (wanted.length > MAX_SOURCES) throw productionError('SOURCE_INVALID', 'Zu viele Quellfirmen.');
        const directory = await this.tenants.list();
        const active = new Set(directory.filter((tenant) => tenant.isActive).map((tenant) => tenant.id));
        const unknown = wanted.filter((id) => !active.has(id));
        if (unknown.length) {
            throw productionError('SOURCE_INVALID', 'Eine gewählte Firma besteht nicht oder ist nicht aktiv.', { details: unknown });
        }
        await this.settings.save(tenantId, wanted, userId);
        const sync = await this.sync.execute(tenantId, { force: true });
        return { settings: await this.get(tenantId, enabled), sync };
    }
}
