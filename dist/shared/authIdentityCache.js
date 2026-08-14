"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAuthIdentity = exports.clearAuthIdentityCache = exports.invalidateAuthIdentity = void 0;
/**
 * `requireAuth`'ın her istekte okuduğu hesap durumunun kısa ömürlü önbelleği.
 *
 * Token geçerli olsa bile hesabın GÜNCEL durumu (pasif / banlı / silinmiş /
 * parola değişmiş) her yetkili istekte kontrol ediliyor. Doğru davranış, ama
 * veritabanı uzak olduğu için bu tek satırlık okuma her isteğe ~90 ms ekliyordu
 * — uygulamadaki en pahalı sabit maliyet.
 *
 * Hesap durumunu değiştiren TEK yol `EmployeeRepository` (update/create), o da
 * burayı geçersiz kılıyor; yani ban/pasifleştirme/parola değişimi anında etkili
 * kalır. TTL sadece bu süreç dışından (elle SQL, ikinci bir instance) yapılan
 * değişiklikler için üst sınırdır. Yetki önbelleği (`RoleRepository`) zaten
 * 60 sn ile aynı ödünleşimi yapıyor; burada daha kısa bir pencere seçildi.
 */
const prisma_client_1 = __importDefault(require("../infrastructure/database/prisma.client"));
const AUTH_IDENTITY_TTL_MS = 30_000;
const cache = new Map();
const inFlight = new Map();
const invalidateAuthIdentity = (employeeId) => {
    cache.delete(employeeId);
    inFlight.delete(employeeId);
};
exports.invalidateAuthIdentity = invalidateAuthIdentity;
const clearAuthIdentityCache = () => {
    cache.clear();
    inFlight.clear();
};
exports.clearAuthIdentityCache = clearAuthIdentityCache;
const getAuthIdentity = async (employeeId) => {
    const cached = cache.get(employeeId);
    if (cached && cached.expiresAt > Date.now())
        return cached.identity;
    const pending = inFlight.get(employeeId);
    if (pending)
        return cached ? cached.identity : pending;
    const request = prisma_client_1.default.employee
        .findUnique({
        where: { id: employeeId },
        select: {
            isActive: true,
            deletedAt: true,
            bannedAt: true,
            passwordChangedAt: true,
            allowedTenantIds: true,
        },
    })
        .then((employee) => {
        // Bulunamayan hesap ÖNBELLEKLENMEZ: silinmiş/olmayan bir id için
        // 401 dönmek zaten hızlı yol, ve yeni açılan hesabın ilk isteği
        // negatif bir kayda takılmamalı. Eski kaydı da düşür ki bayat
        // kimlik süresiz servis edilmesin.
        if (employee) {
            cache.set(employeeId, {
                expiresAt: Date.now() + AUTH_IDENTITY_TTL_MS,
                identity: employee,
            });
        }
        else {
            cache.delete(employeeId);
        }
        return employee ?? null;
    })
        .finally(() => {
        inFlight.delete(employeeId);
    });
    inFlight.set(employeeId, request);
    // Süresi dolmuş kayıt bekletmez: bayat kimlik hemen döner, tazeleme arkada
    // biter (stale-while-revalidate). Uygulama içi ban/pasifleştirme yine
    // `invalidateAuthIdentity` ile kaydı SİLDİĞİ için bir sonraki istek bloklu
    // taze okumaya düşer — anında etki bozulmaz; TTL yalnızca süreç dışı
    // değişikliklerde ~tazeleme süresi kadar esner.
    return cached ? cached.identity : request;
};
exports.getAuthIdentity = getAuthIdentity;
//# sourceMappingURL=authIdentityCache.js.map