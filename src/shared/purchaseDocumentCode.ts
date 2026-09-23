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

export type PurchaseDocKind = 'PRICE_REQUEST' | 'ORDER';
export type PurchaseDocLang = 'tr' | 'de' | 'en';

export const PURCHASE_DOC_LANGS: PurchaseDocLang[] = ['tr', 'de', 'en'];

/** Belge türü × dil → önek. Değiştirirsen frontend ikizini de değiştir. */
export const PURCHASE_DOC_PREFIX: Record<PurchaseDocKind, Record<PurchaseDocLang, string>> = {
    PRICE_REQUEST: { tr: 'FT', de: 'PA', en: 'PR' },
    ORDER: { tr: 'SP', de: 'BE', en: 'PO' },
};

/** Veritabanına yazılan yazım — Almanca olan. */
export const CANONICAL_PURCHASE_LANG: PurchaseDocLang = 'de';

/**
 * Bir kodun önünde görülebilecek HER yazım. Eski `AU-` kayıtları da sipariş
 * sayılır (2026-08-03'te BE-'ye dönülmüştü, veri duruyor) — yoksa sıra tarayıcı
 * onları görmez ve aynı numarayı ikinci kez dağıtır.
 */
const PREFIX_KIND: Record<string, PurchaseDocKind> = {
    FT: 'PRICE_REQUEST', PA: 'PRICE_REQUEST', PR: 'PRICE_REQUEST',
    SP: 'ORDER', BE: 'ORDER', PO: 'ORDER', AU: 'ORDER',
};

/** Bir türün tüm yazımları — tarama ve arama bunların hepsini okur. */
export const purchasePrefixesOf = (kind: PurchaseDocKind): string[] =>
    Object.keys(PREFIX_KIND).filter((prefix) => PREFIX_KIND[prefix] === kind);

/** Sıra alanı üç hanedir; 999'dan sonra doğal olarak dörde taşar. */
export const PURCHASE_SEQ_PAD = 3;

const CODE_RE = /^([A-Za-z]{2})-(\d{4})-(\d+)(.*)$/;

export interface ParsedPurchaseCode {
    kind: PurchaseDocKind;
    /** Kodda GERÇEKTEN yazan önek (`FT`, `BE`, `AU` …). */
    prefix: string;
    year: number;
    seq: number;
    /** Sıradan sonra kalan her şey (bugün boş; elle girilen kodlarda dolabilir). */
    rest: string;
}

/** Tanıdık bir satın alma kodu mu? Elle girilmiş serbest metinler `null` döner. */
export const parsePurchaseCode = (value: unknown): ParsedPurchaseCode | null => {
    const code = String(value ?? '').trim();
    const match = CODE_RE.exec(code);
    if (!match) return null;
    const prefix = (match[1] ?? '').toUpperCase();
    const kind = PREFIX_KIND[prefix];
    if (!kind) return null;
    return { kind, prefix, year: Number(match[2]), seq: Number(match[3]), rest: match[4] ?? '' };
};

/** `BE-2026-004` → Türkçe `SP-2026-004`. Tanınmayan kod olduğu gibi döner. */
export const localizePurchaseCode = (value: unknown, lang: PurchaseDocLang): string => {
    const code = String(value ?? '').trim();
    const parsed = parsePurchaseCode(code);
    if (!parsed) return code;
    return `${PURCHASE_DOC_PREFIX[parsed.kind][lang]}-${code.slice(parsed.prefix.length + 1)}`;
};

/** Depoya giden yazım: `FT-2026-001` → `PA-2026-001`. */
export const canonicalPurchaseCode = (value: unknown): string =>
    localizePurchaseCode(value, CANONICAL_PURCHASE_LANG);

/** Kodun türü — bilinmiyorsa `null` (elle girilmiş serbest kod). */
export const purchaseCodeKind = (value: unknown): PurchaseDocKind | null =>
    parsePurchaseCode(value)?.kind ?? null;

/**
 * ARAMA ÖNEKTEN BAĞIMSIZDIR: kullanıcı hangi dilde yazarsa yazsın kaydı bulur.
 * `FT-2026-001` ve `PA-2026-001` aynı aramaya döner — önek atılır, kuyruk
 * (`-2026-001`) aranır. Tanınmayan metin olduğu gibi aranır.
 */
export const purchaseSearchTerm = (value: unknown): string => {
    const term = String(value ?? '').trim();
    const parsed = parsePurchaseCode(term);
    return parsed ? term.slice(parsed.prefix.length) : term;
};

/** `kind` + yıl + sıra → kod (istenen dilde; varsayılan depo yazımı). */
export const formatPurchaseCode = (
    kind: PurchaseDocKind,
    year: number,
    seq: number,
    lang: PurchaseDocLang = CANONICAL_PURCHASE_LANG,
): string => `${PURCHASE_DOC_PREFIX[kind][lang]}-${year}-${String(seq).padStart(PURCHASE_SEQ_PAD, '0')}`;
