"use strict";
/**
 * SATIN ALMA BELGE KODLARI — FİYAT TALEBİ ve SİPARİŞ AYRI SERİLERDİR.
 *
 * Kullanıcı isteği (Samet, 21.09.2026): «fiyat talebi kısaltması ayrı olmalı,
 * BE-2026-001 değil» ve «tr'de, Almancada, İngilizcede bu kodlar farklı olsun».
 * Bir satın alma kaydı iki belge doğurur ve HER BİRİNİN KENDİ SIRASI VARDIR:
 *
 *              tr            de             en
 *   Fiyat talebi   FT-2026-001   PA-2026-001   PR-2026-001
 *   Sipariş        SP-2026-004   BE-2026-004   PO-2026-004
 *
 * ⚠ VERİTABANINDA TEK YAZIM VARDIR: ALMANCA OLAN (`PA-` / `BE-`). Dil yalnızca
 * GÖSTERİMDE öneki değiştirir; yıl ve sıra aynı kalır. Kaydın kimliği tek
 * kalsın diye böyle: aynı belge Türkçe ekranda FT-2026-001, Almanca PDF'te
 * PA-2026-001 okunur ama depoda tek satırdır. (Satış belgeleri —
 * AN/PR/AB/NT/RE — bu kuralın DIŞINDADIR: onlar her dilde aynıdır, bkz.
 * `documentNumber.ts`. Oradaki dile göre yeniden yazma 2026-08-04'te bilerek
 * silinmişti; burada kullanıcı bilerek geri istedi ve yalnız satın alma
 * belgelerini kapsar.)
 *
 * ⚠ `PR` burada İngilizce FİYAT TALEBİDİR, satış tarafındaki `PR` ise PROJE.
 * İki seri hiç karşılaşmaz (biri PurchaseOrder, öteki Project) — ama bu
 * dosyanın dışında `PR-` görünce hangi tarafa ait olduğunu sormak gerekir.
 *
 * Kaydın hangi kodu taşıdığı AŞAMASINDAN gelir (`inventory.routes.ts`):
 * fiyat talebi aşaması (DRAFT · PRICE_REQUEST) → `priceRequestNumber`,
 * sipariş aşamasından itibaren → `orderNumber`. `referenceNumber` her zaman
 * GÜNCEL belgenin kodudur; tüm uygulama onu okumaya devam eder.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatPurchaseCode = exports.purchaseSearchTerm = exports.purchaseCodeKind = exports.canonicalPurchaseCode = exports.localizePurchaseCode = exports.parsePurchaseCode = exports.PURCHASE_SEQ_PAD = exports.purchasePrefixesOf = exports.CANONICAL_PURCHASE_LANG = exports.PURCHASE_DOC_PREFIX = exports.PURCHASE_DOC_LANGS = void 0;
exports.PURCHASE_DOC_LANGS = ['tr', 'de', 'en'];
/** Belge türü × dil → önek. Değiştirirsen frontend ikizini de değiştir. */
exports.PURCHASE_DOC_PREFIX = {
    PRICE_REQUEST: { tr: 'FT', de: 'PA', en: 'PR' },
    ORDER: { tr: 'SP', de: 'BE', en: 'PO' },
};
/** Veritabanına yazılan yazım — Almanca olan. */
exports.CANONICAL_PURCHASE_LANG = 'de';
/**
 * Bir kodun önünde görülebilecek HER yazım. Eski `AU-` kayıtları da sipariş
 * sayılır (2026-08-03'te BE-'ye dönülmüştü, veri duruyor) — yoksa sıra tarayıcı
 * onları görmez ve aynı numarayı ikinci kez dağıtır.
 */
const PREFIX_KIND = {
    FT: 'PRICE_REQUEST', PA: 'PRICE_REQUEST', PR: 'PRICE_REQUEST',
    SP: 'ORDER', BE: 'ORDER', PO: 'ORDER', AU: 'ORDER',
};
/** Bir türün tüm yazımları — tarama ve arama bunların hepsini okur. */
const purchasePrefixesOf = (kind) => Object.keys(PREFIX_KIND).filter((prefix) => PREFIX_KIND[prefix] === kind);
exports.purchasePrefixesOf = purchasePrefixesOf;
/** Sıra alanı üç hanedir; 999'dan sonra doğal olarak dörde taşar. */
exports.PURCHASE_SEQ_PAD = 3;
const CODE_RE = /^([A-Za-z]{2})-(\d{4})-(\d+)(.*)$/;
/** Tanıdık bir satın alma kodu mu? Elle girilmiş serbest metinler `null` döner. */
const parsePurchaseCode = (value) => {
    const code = String(value ?? '').trim();
    const match = CODE_RE.exec(code);
    if (!match)
        return null;
    const prefix = (match[1] ?? '').toUpperCase();
    const kind = PREFIX_KIND[prefix];
    if (!kind)
        return null;
    return { kind, prefix, year: Number(match[2]), seq: Number(match[3]), rest: match[4] ?? '' };
};
exports.parsePurchaseCode = parsePurchaseCode;
/** `BE-2026-004` → Türkçe `SP-2026-004`. Tanınmayan kod olduğu gibi döner. */
const localizePurchaseCode = (value, lang) => {
    const code = String(value ?? '').trim();
    const parsed = (0, exports.parsePurchaseCode)(code);
    if (!parsed)
        return code;
    return `${exports.PURCHASE_DOC_PREFIX[parsed.kind][lang]}-${code.slice(parsed.prefix.length + 1)}`;
};
exports.localizePurchaseCode = localizePurchaseCode;
/** Depoya giden yazım: `FT-2026-001` → `PA-2026-001`. */
const canonicalPurchaseCode = (value) => (0, exports.localizePurchaseCode)(value, exports.CANONICAL_PURCHASE_LANG);
exports.canonicalPurchaseCode = canonicalPurchaseCode;
/** Kodun türü — bilinmiyorsa `null` (elle girilmiş serbest kod). */
const purchaseCodeKind = (value) => (0, exports.parsePurchaseCode)(value)?.kind ?? null;
exports.purchaseCodeKind = purchaseCodeKind;
/**
 * ARAMA ÖNEKTEN BAĞIMSIZDIR: kullanıcı hangi dilde yazarsa yazsın kaydı bulur.
 * `FT-2026-001` ve `PA-2026-001` aynı aramaya döner — önek atılır, kuyruk
 * (`-2026-001`) aranır. Tanınmayan metin olduğu gibi aranır.
 */
const purchaseSearchTerm = (value) => {
    const term = String(value ?? '').trim();
    const parsed = (0, exports.parsePurchaseCode)(term);
    return parsed ? term.slice(parsed.prefix.length) : term;
};
exports.purchaseSearchTerm = purchaseSearchTerm;
/** `kind` + yıl + sıra → kod (istenen dilde; varsayılan depo yazımı). */
const formatPurchaseCode = (kind, year, seq, lang = exports.CANONICAL_PURCHASE_LANG) => `${exports.PURCHASE_DOC_PREFIX[kind][lang]}-${year}-${String(seq).padStart(exports.PURCHASE_SEQ_PAD, '0')}`;
exports.formatPurchaseCode = formatPurchaseCode;
//# sourceMappingURL=purchaseDocumentCode.js.map