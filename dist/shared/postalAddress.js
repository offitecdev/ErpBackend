"use strict";
/**
 * Posta adresi bileşenleri → görüntü satırları (en fazla 2).
 *
 * Adres veri modelinde AYRI BİLEŞENLER olarak tutulur (sokak + bina no, adres
 * eki / daire, PLZ, şehir, eyalet, ülke); tek bir serbest metin "adres" alanı
 * yoktur ve hiçbir bileşen bir diğeriyle aynı anlamı taşımaz. Snapshot alan
 * kayıtlar (ör. `PurchaseOrder.supplierAddress`) bu iki satırı `\n` ile
 * birleştirip saklar; PDF/ekran onu olduğu gibi yazar.
 *
 * Frontend eşi: `ErpFront/offitec-frontend/src/utils/address.ts`
 * (`formatAddressLines`). İkisi birlikte güncellenmelidir.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.composeAddressSnapshot = exports.formatAddressLines = void 0;
const SEPARATOR = ', ';
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
/** Bileşenlerden en fazla 2 görüntü satırı. Boş bileşenler atlanır. */
const formatAddressLines = (parts) => {
    const streetLine = [clean(parts.street), clean(parts.addressSupplement)]
        .filter(Boolean).join(SEPARATOR);
    const localityLine = [
        [clean(parts.postalCode), clean(parts.city)].filter(Boolean).join(' '),
        clean(parts.state),
        clean(parts.country),
    ].filter(Boolean).join(SEPARATOR);
    return [streetLine, localityLine].filter(Boolean);
};
exports.formatAddressLines = formatAddressLines;
/**
 * Snapshot metni: satırlar `\n` ile ayrılır (PDF/ekran satır satır yazar).
 * Hiçbir bileşen dolu değilse `null` döner.
 */
const composeAddressSnapshot = (parts) => {
    const lines = (0, exports.formatAddressLines)(parts);
    return lines.length ? lines.join('\n') : null;
};
exports.composeAddressSnapshot = composeAddressSnapshot;
//# sourceMappingURL=postalAddress.js.map