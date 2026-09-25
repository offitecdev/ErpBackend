"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readTenantCompanyType = exports.companyRequiresArticleKindAndSupplier = exports.parseCompanyType = exports.COMPANY_TYPES = void 0;
/**
 * ŞİRKET TÜRÜ (23.09.2026) — şirket kategorileri ekranında her şirkete
 * seçilir: A = PRODUCTION (Üretim), B = PROJECT (Proje), C = SALES (Satış).
 * Kodda İngilizce değer durur; arayüz etiketi çeviriden gelir. Frontend'deki
 * `lib/companyType.ts` ile aynı listeyi taşır.
 *
 * Türün şimdilik tek etkisi yeni ürün formudur: proje ve satış şirketlerinde
 * ürün türü (Üretilecek / Satın Alınacak / Ek Hizmet) ile en az bir tedarikçi
 * zorunludur; üretim şirketinde — ve türü henüz seçilmemiş şirkette — yalnızca
 * ürün adı.
 */
const prisma_client_1 = __importDefault(require("../infrastructure/database/prisma.client"));
exports.COMPANY_TYPES = ['PRODUCTION', 'PROJECT', 'SALES'];
const parseCompanyType = (value) => {
    const raw = String(value ?? '').trim().toUpperCase();
    return exports.COMPANY_TYPES.includes(raw) ? raw : null;
};
exports.parseCompanyType = parseCompanyType;
/** Yeni üründe tür + tedarikçi zorunlu mu? Proje ve satış şirketlerinde evet. */
const companyRequiresArticleKindAndSupplier = (type) => type === 'PROJECT' || type === 'SALES';
exports.companyRequiresArticleKindAndSupplier = companyRequiresArticleKindAndSupplier;
/** Şirketin kayıtlı türü; seçilmemişse null. */
const readTenantCompanyType = async (tenantId) => {
    const tenant = await prisma_client_1.default.tenant.findUnique({
        where: { id: tenantId },
        select: { companyType: true },
    });
    return (0, exports.parseCompanyType)(tenant?.companyType);
};
exports.readTenantCompanyType = readTenantCompanyType;
//# sourceMappingURL=companyType.js.map