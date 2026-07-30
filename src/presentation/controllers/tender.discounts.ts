/**
 * ── YIĞILMIŞ İSKONTO MATEMATİĞİ (satır + belge düzeyi) ──────────────────────
 *
 * ⚠ Bu dosya frontend'deki
 * `ErpFront/offitec-frontend/src/pages/tender/detail/utils/tenderDiscounts.utils.ts`
 * dosyasının BİREBİR eşidir. Sunucu istemciye güvenmez: gelen JSON listesini
 * doğrular ve eski tek-yüzde kolonlarını (`Position.discount`,
 * `Tender.directDiscount`) bu listeden yeniden türetir. İki taraf birlikte
 * güncellenmelidir, yoksa ekranda görünen tutar kaydedilenden farklı olur.
 *
 * İskontolar SIRAYLA uygulanır: her biri bir öncekinin bıraktığı tutar
 * üzerinden hesaplanır (100 → −%20 → 80 → −%10 → 72). Bir iskonto ya kalan
 * tutarın YÜZDESİ (PERCENT) ya da kalandan düşülen SABİT TUTARDIR (AMOUNT);
 * sabit tutar kalanı aşamaz, satır eksiye düşmez.
 */

export type DiscountKind = 'PERCENT' | 'AMOUNT';

export interface TenderDiscountEntry {
    name: string;
    kind: DiscountKind;
    value: number;
}

/** Ürün satırı en fazla beş iskonto taşır; belge toplamı için sınır gevşektir. */
export const MAX_LINE_DISCOUNTS = 5;
export const MAX_TOTAL_DISCOUNTS = 20;
export const MAX_DISCOUNT_NAME_LENGTH = 80;

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

const clampPercent = (value: unknown): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.min(100, Math.max(0, parsed));
};

const clampAmount = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

/**
 * Gelen değeri doğrular ve saklanacak biçime indirger. Değeri 0 olan girdiler
 * atılır (görünür bir etkisi yoktur), liste `max` girdiyle sınırlanır. Geçersiz
 * bir gövde `null` döner — bozuk JSON teklifin fiyatını bozmamalıdır.
 */
export const normalizeDiscountList = (raw: unknown, max: number): string | null => {
    let source: unknown = raw;
    if (typeof source === 'string') {
        const trimmed = source.trim();
        if (!trimmed) return null;
        try {
            source = JSON.parse(trimmed);
        } catch {
            return null;
        }
    }
    if (!Array.isArray(source)) return null;

    const kept: TenderDiscountEntry[] = [];
    for (const item of source) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const kind: DiscountKind = String(record.kind ?? '').toUpperCase() === 'AMOUNT' ? 'AMOUNT' : 'PERCENT';
        const value = kind === 'AMOUNT' ? clampAmount(record.value) : clampPercent(record.value);
        if (value <= 0) continue;
        kept.push({
            name: String(record.name ?? '').trim().slice(0, MAX_DISCOUNT_NAME_LENGTH),
            kind,
            value,
        });
        if (kept.length >= max) break;
    }
    return kept.length > 0 ? JSON.stringify(kept) : null;
};

/** Saklanan JSON'u okur; okunamayan bir kolon boş liste sayılır. */
export const parseDiscountList = (raw: unknown, max: number): TenderDiscountEntry[] => {
    const normalized = normalizeDiscountList(raw, max);
    if (!normalized) return [];
    return JSON.parse(normalized) as TenderDiscountEntry[];
};

/** Sıralı uygulamadan sonra geriye kalan tutar. */
export const remainingAfterDiscounts = (base: number, list: TenderDiscountEntry[]): number => {
    const safeBase = Number.isFinite(base) && base > 0 ? base : 0;
    return list.reduce((remaining, entry) => {
        const amount = entry.kind === 'AMOUNT'
            ? Math.min(clampAmount(entry.value), remaining)
            : remaining * (clampPercent(entry.value) / 100);
        return remaining - amount;
    }, safeBase);
};

/** Listeyi tek bir yüzdeye indirger — eski kolonlara yazılan değer budur. */
export const combinedDiscountPercent = (base: number, list: TenderDiscountEntry[]): number => {
    const safeBase = Number.isFinite(base) && base > 0 ? base : 0;
    if (safeBase <= 0) return 0;
    return round6((1 - remainingAfterDiscounts(safeBase, list) / safeBase) * 100);
};

/** Satırın iskontosuz tutarı: miktar × birim fiyat. */
export const lineDiscountBase = (position: { quantity?: unknown; unitPrice?: unknown }): number => {
    const quantity = Number(position?.quantity ?? 0);
    const unitPrice = position?.unitPrice == null ? 0 : Number(position.unitPrice);
    if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) return 0;
    return quantity > 0 && unitPrice > 0 ? quantity * unitPrice : 0;
};

/**
 * Bir satırın iskonto JSON'u ile ondan türetilen birleşik yüzdesi. Liste boşsa
 * `discount` DOKUNULMAZ (undefined döner): yüzde sütununu elle girmek ya da
 * toplu iskonto uygulamak hâlâ geçerli bir yoldur.
 */
export const resolveLineDiscount = (
    rawDiscounts: unknown,
    position: { quantity?: unknown; unitPrice?: unknown },
): { discounts: string | null; discount?: number } => {
    const discounts = normalizeDiscountList(rawDiscounts, MAX_LINE_DISCOUNTS);
    if (!discounts) return { discounts: null, discount: 0 };
    const list = JSON.parse(discounts) as TenderDiscountEntry[];
    return { discounts, discount: combinedDiscountPercent(lineDiscountBase(position), list) };
};
