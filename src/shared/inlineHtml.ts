/**
 * ── INLINE-AUSZEICHNUNG EINES EDITORBLOCKS (13.09.2026) ──────────────────────
 *
 * Vorgabe Samet (Görevler-Modul): «<b>sdadad&nbsp;</b> şu türlü hatalar var» —
 * fett gesetzter Text darf NIE als Quelltext auf dem Bildschirm stehen. Der
 * Fehler entsteht immer an derselben Stelle: jemand maskiert den Blocktext
 * (`&lt;b&gt;`) statt ihn zu BEREINIGEN. Diese Datei bereinigt — sie maskiert
 * nichts, was eine erlaubte Auszeichnung ist.
 *
 * Erlaubt: <b strong i em u s strike code span a br>. Jedes Attribut fällt weg,
 * ausser `href` an <a> mit http(s)/mailto; das <a> bekommt target/rel.
 *
 * WARUM NICHT shared/richText.ts: jener Filter arbeitet in EINEM Regex-Durchgang
 * und lässt sich überlisten — `<<x>img src=x onerror=alert(1)>` wird dort zu
 * einem echten <img>. Hier wird der Text Zeichen für Zeichen neu aufgebaut:
 * jedes "<" der Ausgabe stammt von diesem Code, ein loses "<" wird zu "&lt;",
 * ein entfernter Tag kann darum nie zwei Bruchstücke zu einem neuen verbinden.
 * Gültige Entitäten (&nbsp; &amp; &#160;) bleiben wortgleich, ein nacktes "&"
 * wird maskiert. Zweimal angewandt ergibt dasselbe wie einmal.
 */

const INLINE_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'code', 'span', 'a', 'br']);
const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^<>"']|"[^<"]*"|'[^<']*')*)>/y;
const DROP_RE = /<(script|style|iframe|object|embed|textarea|title|noscript|template|svg|math|select)\b[\s\S]*?<\/\1\s*>/iy;
const COMMENT_RE = /<!--[\s\S]*?-->/y;
const ENTITY_RE = /&(?:[a-zA-Z][a-zA-Z0-9]{1,31}|#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6});/y;
const NAMED_ENTITIES: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', colon: ':', tab: '\t', newline: '\n',
};
const MAX_NESTING = 16;

const decodeEntities = (value: string): string =>
    value.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);?/g, (match: string, body: string) => {
        if (body.startsWith('#')) {
            const hex = body[1] === 'x' || body[1] === 'X';
            const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    });

const escapeAttribute = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const HREF_ATTR_RE = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

const readHref = (attributes: string): string | undefined => {
    const match = HREF_ATTR_RE.exec(attributes);
    return match?.[1] ?? match?.[2] ?? match?.[3];
};

/** Nur http(s) und mailto — Browser übergehen Leer- und Steuerzeichen im
    Schema («java\tscript:»), darum werden sie vor der Prüfung entfernt. */
const safeHref = (raw: string | undefined): string | null => {
    if (!raw) return null;
    const decoded = decodeEntities(raw).replace(/[\u0000-\u0020\u007f-\u009f]/g, '');
    return /^(https?:\/\/|mailto:)/i.test(decoded) ? decoded.slice(0, 2000) : null;
};

/** Bereinigt die Inline-Auszeichnung EINES Blocks. */
export function sanitizeInlineHtml(input: unknown, maxChars = 20_000): string {
    const source = String(input ?? '')
        .slice(0, maxChars)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    const open: string[] = [];
    let out = '';
    let index = 0;

    while (index < source.length) {
        const char = source.charAt(index);

        if (char === '<') {
            COMMENT_RE.lastIndex = index;
            if (COMMENT_RE.test(source)) { index = COMMENT_RE.lastIndex; continue; }
            DROP_RE.lastIndex = index;
            if (DROP_RE.test(source)) { index = DROP_RE.lastIndex; continue; }

            TAG_RE.lastIndex = index;
            const match = TAG_RE.exec(source);
            if (!match) { out += '&lt;'; index += 1; continue; }
            index = TAG_RE.lastIndex;

            const closing = Boolean(match[1]);
            const name = (match[2] ?? '').toLowerCase();
            const attributes = match[3] ?? '';
            if (!INLINE_TAGS.has(name)) continue;               // Tag weg, Text bleibt

            if (name === 'br') {
                if (!closing) out += '<br>';
                continue;
            }
            if (closing) {
                const at = open.lastIndexOf(name);
                if (at < 0) continue;                             // loser Schliesser
                while (open.length > at) out += `</${open.pop()}>`;
                continue;
            }
            if (open.length >= MAX_NESTING) continue;
            if (name === 'a') {
                const href = safeHref(readHref(attributes));
                out += href ? `<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">` : '<a>';
            } else {
                out += `<${name}>`;
            }
            open.push(name);
            continue;
        }

        if (char === '&') {
            ENTITY_RE.lastIndex = index;
            const match = ENTITY_RE.exec(source);
            if (match) {
                out += match[0];
                index = ENTITY_RE.lastIndex;
            } else {
                out += '&amp;';
                index += 1;
            }
            continue;
        }

        out += char === '>' ? '&gt;' : char;
        index += 1;
    }

    while (open.length) out += `</${open.pop()}>`;
    return out;
}

/** Klartext eines Blocks — für Suche, Vorschau, Benachrichtigung, PDF. */
export const inlineHtmlToText = (html: unknown): string =>
    decodeEntities(String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''))
        .replace(/\u00a0/g, ' ');
