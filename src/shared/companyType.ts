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
import prisma from '../infrastructure/database/prisma.client';

export const COMPANY_TYPES = ['PRODUCTION', 'PROJECT', 'SALES'] as const;
export type CompanyType = typeof COMPANY_TYPES[number];

export const parseCompanyType = (value: unknown): CompanyType | null => {
    const raw = String(value ?? '').trim().toUpperCase();
    return (COMPANY_TYPES as readonly string[]).includes(raw) ? raw as CompanyType : null;
};

/** Yeni üründe tür + tedarikçi zorunlu mu? Proje ve satış şirketlerinde evet. */
export const companyRequiresArticleKindAndSupplier = (type: CompanyType | null): boolean =>
    type === 'PROJECT' || type === 'SALES';

/** Şirketin kayıtlı türü; seçilmemişse null. */
export const readTenantCompanyType = async (tenantId: string): Promise<CompanyType | null> => {
    const tenant = await (prisma as any).tenant.findUnique({
        where: { id: tenantId },
        select: { companyType: true },
    });
    return parseCompanyType(tenant?.companyType);
};
