"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findTenantRootIdCached = exports.collectDescendantIds = exports.getAllTenants = exports.invalidateTenantTree = void 0;
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
const prisma_client_1 = __importDefault(require("../infrastructure/database/prisma.client"));
const TENANT_TREE_TTL_MS = 60_000;
let cache = null;
// Aynı anda gelen isteklerin hepsi ayrı sorgu açmasın: uçuştaki yükleme
// paylaşılır (soğuk başlangıçta N istek = 1 sorgu).
let inFlight = null;
const invalidateTenantTree = () => {
    cache = null;
    inFlight = null;
};
exports.invalidateTenantTree = invalidateTenantTree;
const getAllTenants = async () => {
    if (cache && cache.expiresAt > Date.now())
        return cache.tenants;
    if (inFlight)
        return inFlight;
    inFlight = prisma_client_1.default.tenant
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
exports.getAllTenants = getAllTenants;
/** Ağacın kökünden aşağı doğru tüm aktif alt tenant'lar (kök dahil). */
const collectDescendantIds = (tenants, rootId) => {
    const result = new Set([rootId]);
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
exports.collectDescendantIds = collectDescendantIds;
/**
 * Verilen tenant'ın şirket ağacındaki kökü. Zincirdeki herhangi bir tenant
 * pasifse null döner — eski `findUnique` döngüsüyle aynı davranış, ama sıfır
 * sorgu ile.
 */
const findTenantRootIdCached = async (tenantId) => {
    const tenants = await (0, exports.getAllTenants)();
    const byId = new Map(tenants.map((tenant) => [tenant.id, tenant]));
    let current = byId.get(tenantId);
    if (!current?.isActive)
        return null;
    for (let depth = 0; current.parentTenantId && depth < 20; depth += 1) {
        const parent = byId.get(current.parentTenantId);
        if (!parent?.isActive)
            return null;
        current = parent;
    }
    return current.id;
};
exports.findTenantRootIdCached = findTenantRootIdCached;
//# sourceMappingURL=tenantTree.js.map