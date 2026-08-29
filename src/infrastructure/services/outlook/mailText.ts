/** Kleine Text-Helfer der Mail-Anbindung (bewusst ohne Abhängigkeiten). */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isValidEmail = (value: string) => EMAIL_RE.test(value);

/** CR/LF raus — ein Wert in einem Mail-Header darf keine weiteren Header einschleusen. */
export const stripHeaderValue = (value: unknown) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();

export const escapeHtml = (value: string) =>
    value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

export const looksLikeHtml = (value: string) => /<([a-z][a-z0-9]*)\b[^>]*>/i.test(value);

const ALLOWED_TAGS = /^(b|strong|i|em|u|s|strike|ul|ol|li|br|p|div|span|font|h[1-6]|a|blockquote|table|thead|tbody|tfoot|tr|td|th|hr|pre|code|sub|sup|small)$/i;

/** Nur Formatierung überlebt (wie sanitizeMailHtml der Offerten-Mail, plus <a href> mit http(s)/mailto). */
export const sanitizeMailHtml = (html: string): string =>
    html
        .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
        .replace(/<\s*(\/?)\s*([a-z][a-z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (_m, closing, tag, attrs) => {
            if (!ALLOWED_TAGS.test(tag)) return "";
            const lower = String(tag).toLowerCase();
            if (closing) return `</${lower}>`;
            let safeAttrs = "";
            if (lower === "a") {
                const href = String(attrs).match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
                const value = href?.[1] ?? href?.[2] ?? href?.[3];
                if (value && /^(https?:\/\/|mailto:)/i.test(value)) safeAttrs += ` href="${value.replace(/"/g, "")}"`;
            }
            const style = String(attrs).match(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
            const styleValue = style?.[1] ?? style?.[2];
            if (styleValue) {
                const kept = styleValue
                    .split(";")
                    .map((rule: string) => rule.trim())
                    .filter((rule: string) => /^(color|font-size|font-weight|text-decoration)\s*:\s*[a-z0-9#(),.%\s-]+$/i.test(rule))
                    .join("; ");
                if (kept) safeAttrs += ` style="${kept}"`;
            }
            return `<${lower}${safeAttrs}>`;
        });

/** HTML → lesbarer Text (für bodyText / den text/plain-Teil). */
export const htmlToText = (html: string): string =>
    html
        .replace(/<\s*(script|style|head)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|table|blockquote)\s*>/gi, "\n")
        .replace(/<li[^>]*>/gi, "• ")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

/** Grunddaten, keine Archivkopie: der Text wird hart gedeckelt. */
export const MAX_BODY_CHARS = 60_000;
export const clampBody = (text: string | null | undefined): string | null => {
    if (!text) return null;
    return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n…` : text;
};

/** Das bereinigte HTML darf mehr wiegen als der Text (Tags), bleibt aber
    gedeckelt — ein Schnitt mitten im Tag ist egal, der Browser verzeiht das. */
export const MAX_HTML_CHARS = 300_000;
export const clampHtml = (html: string | null | undefined): string | null => {
    const clean = String(html || "").trim();
    if (!clean) return null;
    return clean.length > MAX_HTML_CHARS ? clean.slice(0, MAX_HTML_CHARS) : clean;
};

export const previewOf = (text: string | null | undefined, max = 500): string | null => {
    if (!text) return null;
    const collapsed = text.replace(/\s+/g, " ").trim();
    return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed || null;
};

export interface MailParty { name: string | null; address: string; }

/** "Name <adresse>" | "adresse" → { name, address } */
export const parseParty = (raw: unknown): MailParty | null => {
    const value = stripHeaderValue(raw);
    if (!value) return null;
    const match = value.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
    if (match) {
        const address = (match[2] || "").trim();
        if (!address) return null;
        return { name: (match[1] || "").trim() || null, address };
    }
    return { name: null, address: value };
};
