"use strict";
// Tenant e-posta imzası — kayıt ve gönderim yardımcıları.
//
// İmza tek bir zengin HTML bloğudur ve Outlook/Word'den yapıştırılan imzaları
// (tablolar, bağlantılar, satır içi görseller) düzenlenebilir hâlde taşır.
// Satır içi görseller data URI olarak saklanır; gönderim sırasında CID'li
// inline eklere çevrilir — Gmail/Outlook dahil çoğu istemci data URI
// görselleri engeller, inline ekler ise güvenilir şekilde görüntülenir.
// Ayrıca eski kayıtlarla uyum için ayrı `signatureImage` alanı da desteklenir.
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSignatureParts = exports.parseSignatureImage = exports.signatureHasContent = exports.signatureHtmlToText = exports.sanitizeSignatureHtml = exports.SIGNATURE_IMAGE_CID = void 0;
exports.SIGNATURE_IMAGE_CID = "offitec-mail-signature";
// Outlook/Word imzalarının kullandığı yapı ve biçimlendirme etiketleri.
// Script/iframe/form gibi her şey ve tüm olay öznitelikleri atılır.
const SIGNATURE_ALLOWED_TAGS = /^(b|strong|i|em|u|s|strike|ul|ol|li|br|p|div|span|font|h1|h2|h3|a|img|table|tbody|thead|tfoot|tr|td|th|hr|small|sup|sub|blockquote|pre|code)$/i;
const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/i;
const HTTP_URL_RE = /^https?:\/\/[^\s"'<>]+$/i;
const getAttr = (attrs, name) => {
    const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
    return match?.[1] ?? match?.[2] ?? match?.[3];
};
// İnline stil beyaz listesi: tipografi + kutu modeli. url(...) / expression /
// javascript içeren hiçbir kural geçmez.
const STYLE_RULE_RE = /^(color|background-color|font-size|font-family|font-weight|font-style|font|text-decoration|text-align|line-height|letter-spacing|margin(?:-[a-z]+)?|padding(?:-[a-z]+)?|border(?:-[a-z]+)*|border-radius|width|height|max-width|min-width|vertical-align|display|white-space)\s*:\s*[^;]+$/i;
const sanitizeStyle = (value) => value
    .split(";")
    .map((rule) => rule.trim())
    .filter((rule) => STYLE_RULE_RE.test(rule) && !/url\s*\(|expression|javascript|@import/i.test(rule))
    .join("; ");
const numericAttr = (attrs, name) => {
    const value = getAttr(attrs, name);
    return value && /^\d{1,4}(%|px)?$/.test(value) ? ` ${name}="${value}"` : "";
};
const sanitizeSignatureHtml = (html) => html
    // Word/Outlook koşullu yorumları ve normal yorumlar.
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\s*(\/?)\s*([a-z][a-z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (_m, closing, tag, attrs) => {
    if (!SIGNATURE_ALLOWED_TAGS.test(tag))
        return "";
    const lower = String(tag).toLowerCase();
    if (closing)
        return lower === "img" || lower === "br" || lower === "hr" ? "" : `</${lower}>`;
    let safeAttrs = "";
    const attrText = String(attrs);
    if (lower === "img") {
        const src = getAttr(attrText, "src");
        // Yalnızca data URI (kayıtlı görsel) veya http(s) kaynak; file:// ve
        // cid: gibi tarayıcının/istemcinin çözemeyeceği kaynaklar atılır.
        if (!src || !(DATA_IMAGE_RE.test(src) || HTTP_URL_RE.test(src)))
            return "";
        safeAttrs += ` src="${src}"`;
        safeAttrs += numericAttr(attrText, "width") + numericAttr(attrText, "height");
    }
    else if (lower === "a") {
        const href = getAttr(attrText, "href");
        if (href && /^(https?:\/\/|mailto:)/i.test(href) && !/["'<>]/.test(href)) {
            safeAttrs += ` href="${href}"`;
        }
    }
    else if (lower === "td" || lower === "th") {
        safeAttrs += numericAttr(attrText, "colspan") + numericAttr(attrText, "rowspan");
        safeAttrs += numericAttr(attrText, "width") + numericAttr(attrText, "height");
    }
    else if (lower === "table") {
        safeAttrs += numericAttr(attrText, "width") + numericAttr(attrText, "border");
        safeAttrs += numericAttr(attrText, "cellpadding") + numericAttr(attrText, "cellspacing");
    }
    else if (lower === "font") {
        const color = getAttr(attrText, "color");
        if (color && /^#?[a-z0-9(),.%\s-]+$/i.test(color))
            safeAttrs += ` color="${color}"`;
        const size = getAttr(attrText, "size");
        if (size && /^[1-7]$/.test(size))
            safeAttrs += ` size="${size}"`;
        const face = getAttr(attrText, "face");
        if (face && /^[a-z0-9,'\s-]+$/i.test(face))
            safeAttrs += ` face="${face}"`;
    }
    const style = getAttr(attrText, "style");
    if (style) {
        const kept = sanitizeStyle(style);
        if (kept)
            safeAttrs += ` style="${kept}"`;
    }
    if (lower === "img")
        return `<img${safeAttrs} />`;
    return `<${lower}${safeAttrs}>`;
});
exports.sanitizeSignatureHtml = sanitizeSignatureHtml;
const signatureHtmlToText = (html) => html
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(t[dh])\s*>/gi, " ")
    .replace(/<\/(p|div|li|ul|ol|tr|table|h[1-6])\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
exports.signatureHtmlToText = signatureHtmlToText;
/** Görünür metni YA DA satır içi görseli olan imza dolu sayılır. */
const signatureHasContent = (html) => {
    if (!html)
        return false;
    if (/<img\b/i.test(html))
        return true;
    return Boolean(html.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim());
};
exports.signatureHasContent = signatureHasContent;
const SIGNATURE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Ayrı `signatureImage` alanı için: `data:image/png|jpeg;base64,...` biçimini
 * doğrular ve MIME + salt base64 gövdesine ayırır. Geçersiz/aşırı büyük girdi
 * null döner.
 */
const parseSignatureImage = (dataUrl) => {
    if (!dataUrl)
        return null;
    const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl.trim());
    const contentType = match?.[1];
    const contentBase64 = match?.[2]?.replace(/\s+/g, "");
    if (!contentType || !contentBase64)
        return null;
    const bytes = Math.floor(contentBase64.length * 3 / 4);
    if (bytes > SIGNATURE_IMAGE_MAX_BYTES)
        return null;
    return { contentType, contentBase64 };
};
exports.parseSignatureImage = parseSignatureImage;
/**
 * Kayıtlı ayarlardan gönderime hazır imza parçalarını üretir: HTML yeniden
 * temizlenir (eski/elle yazılmış kayıtlara karşı savunma), gövdedeki data URI
 * görseller CID referanslarına çevrilip inline ek listesine taşınır.
 */
const buildSignatureParts = (settings) => {
    const empty = { html: "", text: "", inlineImages: [] };
    if (!settings)
        return empty;
    const inlineImages = [];
    let bodyHtml = "";
    if ((0, exports.signatureHasContent)(settings.signatureHtml)) {
        bodyHtml = (0, exports.sanitizeSignatureHtml)(String(settings.signatureHtml)).replace(/src="data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/=]+)"/gi, (_m, contentType, contentBase64) => {
            const cid = `offitec-sig-${inlineImages.length + 1}`;
            inlineImages.push({ cid, contentType, contentBase64 });
            return `src="cid:${cid}"`;
        });
    }
    // Eski ayrı görsel alanı: hâlâ doluysa imzanın sonuna eklenir.
    const legacyImage = (0, exports.parseSignatureImage)(settings.signatureImage);
    const legacyHtml = legacyImage
        ? `<div style="margin-top:8px"><img src="cid:${exports.SIGNATURE_IMAGE_CID}" alt="" style="max-width:420px;height:auto" /></div>`
        : "";
    if (legacyImage)
        inlineImages.push({ cid: exports.SIGNATURE_IMAGE_CID, ...legacyImage });
    if (!bodyHtml && !legacyHtml)
        return empty;
    const text = bodyHtml ? (0, exports.signatureHtmlToText)(bodyHtml) : "";
    return {
        html: `<div style="margin-top:18px;padding-top:12px;border-top:1px solid #e2e8f0">${bodyHtml}${legacyHtml}</div>`,
        text: text ? `\n\n-- \n${text}` : "",
        inlineImages,
    };
};
exports.buildSignatureParts = buildSignatureParts;
//# sourceMappingURL=mailSignature.js.map