// Kullanıcının yazdığı BİÇİMLİ metin (ürün açıklaması, teklif açıklaması gibi)
// için sunucu tarafı beyaz liste.
//
// Küme, frontend'deki `markdown.utils.ts > ALLOWED_RICH_TAGS` ile BİREBİR
// aynıdır: editör (RichTextMarkdownEditor) tam olarak bu etiketleri üretir.
// İkisi birlikte değişmelidir — burada dar tutulan bir etiket, kullanıcının
// ekranda uyguladığı biçimin kayıtta sessizce kaybolması demektir.
//
// E-posta imzası temizleyicisinden (`mailSignature.ts`) ayrıdır: orada tablo,
// görsel ve kutu modeli stilleri gerekir, burada gerekmez.

/** Editörün üretebildiği biçim etiketleri. */
const ALLOWED_TAGS = /^(b|strong|i|em|u|s|strike|ul|ol|li|br|p|div|span|font|h1|h2|h3|h4)$/i;

/** Kendi kendine kapanan etiketler. */
const VOID_TAGS = /^(br)$/i;

/** Gövdesiyle birlikte atılanlar — etiketi süzmek kaynağı görünür metne çevirirdi. */
const DROP_WITH_CONTENT = /<\s*(script|style|iframe|object|embed|title|textarea|head)\b[\s\S]*?<\s*\/\s*\1\s*>/gi;

/** Yalnızca renk/boyut taşıyan stiller korunur; konum/kutu stilleri değil. */
const STYLE_RULE_RE = /^(color|background-color|font-size)\s*:\s*[^;]+$/i;

const getAttr = (attrs: string, name: string): string | undefined => {
    const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
    return match?.[1] ?? match?.[2] ?? match?.[3];
};

const sanitizeStyle = (value: string): string =>
    value
        .split(";")
        .map((rule) => rule.trim())
        .filter((rule) => STYLE_RULE_RE.test(rule) && !/url\s*\(|expression|javascript|@import/i.test(rule))
        .join("; ");

/**
 * Biçim etiketlerini korur, geri kalan her etiketi atar (metni bırakarak).
 * Öznitelikler tamamen düşer; tek istisna `<font color|size>` ve renk/boyut
 * taşıyan `style` — editörün yazı rengi ve vurgu araçlarının çıktısı budur.
 */
export const sanitizeRichText = (html: string): string =>
    String(html ?? "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(DROP_WITH_CONTENT, "")
        .replace(/<\s*(\/?)\s*([a-z][a-z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (_match, closing, tag, attrs) => {
            const lower = String(tag).toLowerCase();
            if (!ALLOWED_TAGS.test(lower)) return "";
            if (VOID_TAGS.test(lower)) return closing ? "" : `<${lower} />`;
            if (closing) return `</${lower}>`;

            const attrText = String(attrs);
            let safeAttrs = "";
            if (lower === "font") {
                const color = getAttr(attrText, "color");
                if (color && /^#?[a-z0-9(),.%\s-]+$/i.test(color)) safeAttrs += ` color="${color}"`;
                const size = getAttr(attrText, "size");
                if (size && /^[1-7]$/.test(size)) safeAttrs += ` size="${size}"`;
            }
            const style = getAttr(attrText, "style");
            if (style) {
                const kept = sanitizeStyle(style);
                if (kept) safeAttrs += ` style="${kept}"`;
            }
            return `<${lower}${safeAttrs}>`;
        });

/** Etiketler çıkarıldığında geriye görünür bir şey kalıyor mu? */
export const richTextHasContent = (html: string | null | undefined): boolean =>
    Boolean(String(html ?? "").replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim());

/**
 * Kaydedilmeye hazır biçimli metin: temizlenir, boşsa `null` döner (veritabanında
 * "<p></p>" gibi görünmez artıklar birikmesin).
 */
export const normalizeRichText = (html: unknown): string | null => {
    if (html == null) return null;
    const clean = sanitizeRichText(String(html));
    return richTextHasContent(clean) ? clean : null;
};
