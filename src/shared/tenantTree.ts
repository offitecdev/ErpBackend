/**
 * Tenant tablosunun paylaşılan, kısa ömürlü önbelleği.
 *
 * Veritabanı UZAK bir sunucuda: her SQL ifadesi ~100 ms ağ turu demek, sorgu
 * ne kadar ucuz olursa olsun. Şirket ağacı neredeyse hiç değişmiyor ama
 * `getServiceTenantScope` / `getCompanyTreeTenantIds` / `tenantRootId` bunu
 * istek başına (bazen istek başına birkaç kez) yeniden okuyordu — tek başına
 * her çağrıda ~170 ms.
 *
 * Tablo küçük olduğu için tamamı tek seferde alınır; kök/alt ağaç hesapları
 * bellekte yapılır. Tenant yazan her yol `invalidateTenantTree()` çağırır, o
 * yüzden TTL yalnızca bu süreç dışından yapılan değişiklikler için bir tavan.
 */
import prisma from '../infrastructure/database/prisma.client';

export type TenantNode = {
    id: string;
    parentTenantId: string | null;
    isActive: boolean;
};

const TENANT_TREE_TTL_MS = 60_000;

let cache: { expiresAt: number; tenants: TenantNode[] } | null = null;
// Aynı anda gelen isteklerin hepsi ayrı sorgu açmasın: uçuştaki yükleme
// paylaşılır (soğuk başlangıçta N istek = 1 sorgu).
let inFlight: Promise<TenantNode[]> | null = null;

export const invalidateTenantTree = (): void => {
    cache = null;
    inFlight = null;
};

export const getAllTenants = async (): Promise<TenantNode[]> => {
    if (cache && cache.expiresAt > Date.now()) return cache.tenants;
    if (inFlight) return inFlight;

    inFlight = prisma.tenant
        .findMany({ select: { id: true, parentTenantId: true, isActive: true } })
        .then((tenants) => {
            cache = { expiresAt: Date.now() + TENANT_TREE_TTL_MS, tenants };
            return tenants;
        })
        .finally(() => {
            inFlight = null;
        });

    return inFlight;
};

/** Ağacın kökünden aşağı doğru tüm aktif alt tenant'lar (kök dahil). */
export const collectDescendantIds = (tenants: TenantNode[], rootId: string): string[] => {
    const result = new Set<string>([rootId]);
    let changed = true;

    while (changed) {
        changed = false;
        for (const tenant of tenants) {
            if (tenant.parentTenantId && result.has(tenant.parentTenantId) && !result.has(tenant.id)) {
                result.add(tenant.id);
                changed = true;
            }
        }
    }

    return Array.from(result);
};

/**
 * Verilen tenant'ın şirket ağacındaki kökü. Zincirdeki herhangi bir tenant
 * pasifse null döner — eski `findUnique` döngüsüyle aynı davranış, ama sıfır
 * sorgu ile.
 */
export const findTenantRootIdCached = async (tenantId: string): Promise<string | null> => {
    const tenants = await getAllTenants();
    const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));

    let current = byId.get(tenantId);
    if (!current?.isActive) return null;

    for (let depth = 0; current.parentTenantId && depth < 20; depth += 1) {
        const parent = byId.get(current.parentTenantId);
        if (!parent?.isActive) return null;
        current = parent;
    }

    return current.id;
};
