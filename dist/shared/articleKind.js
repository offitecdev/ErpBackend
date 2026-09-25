"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.itemTypeForArticleKind = exports.parseArticleKind = exports.ARTICLE_KINDS = void 0;
/**
 * ÜRÜN TÜRÜ (23.09.2026) — yeni ürün formundaki üçlü seçim:
 *   MANUFACTURED = Üretilecek, RESALE = Satın Alınacak, SERVICE = Ek Hizmet.
 *
 * `Article.itemType` (PRODUCT | SERVICE) yerinde kalır ve bu türden türetilir:
 * listeler, stok girişi ve üretim aktarımı hâlâ ona bakar. Tür seçilmemiş eski
 * kayıtlarda `articleKind` NULL'dır. Frontend'deki `types/inventory.ts` ile
 * aynı listeyi taşır.
 */
exports.ARTICLE_KINDS = ['MANUFACTURED', 'RESALE', 'SERVICE'];
const parseArticleKind = (value) => {
    const raw = String(value ?? '').trim().toUpperCase();
    return exports.ARTICLE_KINDS.includes(raw) ? raw : null;
};
exports.parseArticleKind = parseArticleKind;
const itemTypeForArticleKind = (kind) => kind === 'SERVICE' ? 'SERVICE' : 'PRODUCT';
exports.itemTypeForArticleKind = itemTypeForArticleKind;
//# sourceMappingURL=articleKind.js.map