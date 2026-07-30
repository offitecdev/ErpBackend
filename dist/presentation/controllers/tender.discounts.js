"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveLineDiscount = exports.lineDiscountBase = exports.combinedDiscountPercent = exports.remainingAfterDiscounts = exports.parseDiscountList = exports.normalizeDiscountList = exports.MAX_DISCOUNT_NAME_LENGTH = exports.MAX_TOTAL_DISCOUNTS = exports.MAX_LINE_DISCOUNTS = void 0;
/** Ürün satırı en fazla beş iskonto taşır; belge toplamı için sınır gevşektir. */
exports.MAX_LINE_DISCOUNTS = 5;
exports.MAX_TOTAL_DISCOUNTS = 20;
exports.MAX_DISCOUNT_NAME_LENGTH = 80;
const round6 = (value) => Math.round(value * 1e6) / 1e6;
const clampPercent = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return 0;
    return Math.min(100, Math.max(0, parsed));
};
const clampAmount = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};
/**
 * Gelen değeri doğrular ve saklanacak biçime indirger. Değeri 0 olan girdiler
 * atılır (görünür bir etkisi yoktur), liste `max` girdiyle sınırlanır. Geçersiz
 * bir gövde `null` döner — bozuk JSON teklifin fiyatını bozmamalıdır.
 */
const normalizeDiscountList = (raw, max) => {
    let source = raw;
    if (typeof source === 'string') {
        const trimmed = source.trim();
        if (!trimmed)
            return null;
        try {
            source = JSON.parse(trimmed);
        }
        catch {
            return null;
        }
    }
    if (!Array.isArray(source))
        return null;
    const kept = [];
    for (const item of source) {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            continue;
        const record = item;
        const kind = String(record.kind ?? '').toUpperCase() === 'AMOUNT' ? 'AMOUNT' : 'PERCENT';
        const value = kind === 'AMOUNT' ? clampAmount(record.value) : clampPercent(record.value);
        if (value <= 0)
            continue;
        kept.push({
            name: String(record.name ?? '').trim().slice(0, exports.MAX_DISCOUNT_NAME_LENGTH),
            kind,
            value,
        });
        if (kept.length >= max)
            break;
    }
    return kept.length > 0 ? JSON.stringify(kept) : null;
};
exports.normalizeDiscountList = normalizeDiscountList;
/** Saklanan JSON'u okur; okunamayan bir kolon boş liste sayılır. */
const parseDiscountList = (raw, max) => {
    const normalized = (0, exports.normalizeDiscountList)(raw, max);
    if (!normalized)
        return [];
    return JSON.parse(normalized);
};
exports.parseDiscountList = parseDiscountList;
/** Sıralı uygulamadan sonra geriye kalan tutar. */
const remainingAfterDiscounts = (base, list) => {
    const safeBase = Number.isFinite(base) && base > 0 ? base : 0;
    return list.reduce((remaining, entry) => {
        const amount = entry.kind === 'AMOUNT'
            ? Math.min(clampAmount(entry.value), remaining)
            : remaining * (clampPercent(entry.value) / 100);
        return remaining - amount;
    }, safeBase);
};
exports.remainingAfterDiscounts = remainingAfterDiscounts;
/** Listeyi tek bir yüzdeye indirger — eski kolonlara yazılan değer budur. */
const combinedDiscountPercent = (base, list) => {
    const safeBase = Number.isFinite(base) && base > 0 ? base : 0;
    if (safeBase <= 0)
        return 0;
    return round6((1 - (0, exports.remainingAfterDiscounts)(safeBase, list) / safeBase) * 100);
};
exports.combinedDiscountPercent = combinedDiscountPercent;
/** Satırın iskontosuz tutarı: miktar × birim fiyat. */
const lineDiscountBase = (position) => {
    const quantity = Number(position?.quantity ?? 0);
    const unitPrice = position?.unitPrice == null ? 0 : Number(position.unitPrice);
    if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice))
        return 0;
    return quantity > 0 && unitPrice > 0 ? quantity * unitPrice : 0;
};
exports.lineDiscountBase = lineDiscountBase;
/**
 * Bir satırın iskonto JSON'u ile ondan türetilen birleşik yüzdesi. Liste boşsa
 * `discount` DOKUNULMAZ (undefined döner): yüzde sütununu elle girmek ya da
 * toplu iskonto uygulamak hâlâ geçerli bir yoldur.
 */
const resolveLineDiscount = (rawDiscounts, position) => {
    const discounts = (0, exports.normalizeDiscountList)(rawDiscounts, exports.MAX_LINE_DISCOUNTS);
    if (!discounts)
        return { discounts: null, discount: 0 };
    const list = JSON.parse(discounts);
    return { discounts, discount: (0, exports.combinedDiscountPercent)((0, exports.lineDiscountBase)(position), list) };
};
exports.resolveLineDiscount = resolveLineDiscount;
//# sourceMappingURL=tender.discounts.js.map