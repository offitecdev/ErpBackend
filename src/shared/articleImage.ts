// Ürün görseli doğrulaması. Görseller base64 data URI olarak saklanır; üst
// sınır YÜKLENEN DOSYANIN boyutudur (base64 ~4/3 şişirir, o şişme sayılmaz) —
// böylece kullanıcıya söylenen "en fazla 2 MB" ile denetlenen değer aynı şeydir.

export const ARTICLE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/;

/** base64 gövdesinin çözülmüş bayt uzunluğu (dolgu karakterleri düşülür). */
const decodedByteLength = (base64: string): number => {
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
};

export interface ParsedArticleImage {
    imageUrl: string;
    contentType: string;
    byteSize: number;
}

/**
 * data URI'yi doğrular ve gerçek dosya boyutunu döner. Biçim bozuksa, tür
 * desteklenmiyorsa ya da dosya 2 MB'ı aşıyorsa `null` döner — çağıran bunu
 * 400'e çevirir.
 */
export const parseArticleImage = (dataUrl: unknown): ParsedArticleImage | null => {
    const value = String(dataUrl ?? "").trim();
    const match = DATA_URL_RE.exec(value);
    if (!match) return null;

    const contentType = match[1] ?? "";
    const base64 = match[2] ?? "";
    const byteSize = decodedByteLength(base64);
    if (byteSize <= 0 || byteSize > ARTICLE_IMAGE_MAX_BYTES) return null;

    return { imageUrl: value, contentType, byteSize };
};
