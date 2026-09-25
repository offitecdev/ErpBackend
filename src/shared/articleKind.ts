/**
 * ÜRÜN TÜRÜ (23.09.2026) — yeni ürün formundaki üçlü seçim:
 *   MANUFACTURED = Üretilecek, RESALE = Satın Alınacak, SERVICE = Ek Hizmet.
 *
 * `Article.itemType` (PRODUCT | SERVICE) yerinde kalır ve bu türden türetilir:
 * listeler, stok girişi ve üretim aktarımı hâlâ ona bakar. Tür seçilmemiş eski
 * kayıtlarda `articleKind` NULL'dır. Frontend'deki `types/inventory.ts` ile
 * aynı listeyi taşır.
 */
export const ARTICLE_KINDS = ['MANUFACTURED', 'RESALE', 'SERVICE'] as const;
export type ArticleKind = typeof ARTICLE_KINDS[number];

export const parseArticleKind = (value: unknown): ArticleKind | null => {
    const raw = String(value ?? '').trim().toUpperCase();
    return (ARTICLE_KINDS as readonly string[]).includes(raw) ? raw as ArticleKind : null;
};

export const itemTypeForArticleKind = (kind: ArticleKind): 'PRODUCT' | 'SERVICE' =>
    kind === 'SERVICE' ? 'SERVICE' : 'PRODUCT';
