import sharp from 'sharp';

/**
 * JEDES BILD GEHT ALS WEBP RAUS (21.09.2026, Vorgabe Samet: «bütün görselleri
 * png olarak değil webp olarak getir»).
 *
 * Der Eimer trug an dem Tag 1679 PNG (567 MB) und 1119 JPG (108 MB) allein an
 * Produktbildern — im Schnitt 338 KB je Bild, und jede Produktliste zieht
 * Dutzende davon ueber Cloudflare. Dasselbe Bild als WebP wiegt ein Fuenftel
 * bis ein Zehntel, bei gleicher Anzeige.
 *
 * WARUM HIER UND NICHT IN CLOUDFLARE. Cloudflare kann das auch selbst
 * («/cdn-cgi/image/format=auto/…»), aber das ist ein Schalter in der Konsole,
 * der fuer diese Zone nicht gesetzt ist — die Probe am 21.09.2026 antwortete
 * 404. Waere er es und faellt spaeter weg, waeren ALLE Bilder auf einmal tot.
 * Eine Datei, die schon als WebP im Eimer liegt, haengt an keinem Schalter.
 *
 * DREI REGELN:
 *
 * 1. Was kein Rasterbild ist, wird nicht angefasst — ein PDF, ein SVG, eine
 *    unlesbare Datei kommen unveraendert zurueck. Die gemischten Ablagen
 *    (Terminunterlagen, Aufgaben-Anhaenge) schicken alles durch diese
 *    Funktion; sie muss selbst entscheiden, was ein Bild ist.
 *
 * 2. Zwei Kodierungen, die kleinere gewinnt. Verlustbehaftet ist bei Fotos
 *    deutlich kleiner; bei Strichgrafik mit Durchsichtigkeit — Unterschriften,
 *    freigestellte Produktbilder, Bildschirmfotos — gewinnt verlustfrei, und
 *    zwar oft um ein Vielfaches. Wer nur eine von beiden nimmt, verliert die
 *    eine Haelfte der Faelle.
 *
 * 3. Schlaegt die Umwandlung fehl, bleibt das Original. Lieber ein PNG zuviel
 *    im Eimer als ein verlorenes Foto.
 */

export const WEBP_CONTENT_TYPE = 'image/webp';

/** Qualitaet der verlustbehafteten Fassung. 82 ist fuer Fotos nicht vom
 *  Original zu unterscheiden und etwa ein Drittel kleiner als JPEG 85. */
const WEBP_QUALITY = 82;

/**
 * Rasterarten, die wir umwandeln. WebP selbst fehlt bewusst — es ist schon
 * am Ziel und ein zweiter Durchgang wuerde nur Qualitaet kosten.
 */
const CONVERTIBLE_CONTENT_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/bmp',
    'image/tiff',
    'image/heic',
    'image/heif',
    'image/avif',
]);

/** Dieselbe Liste ueber die Kopfbytes — die Art, die sharp wirklich liest. */
const CONVERTIBLE_FORMATS = new Set([
    'png', 'jpeg', 'jpg', 'gif', 'bmp', 'tiff', 'heif', 'heic', 'avif',
]);

export type WebpImage = { body: Buffer; contentType: string; converted: boolean };

/** Ist das ueberhaupt eine Art, die hier etwas zu suchen hat? */
export const isConvertibleImageType = (contentType: string): boolean =>
    CONVERTIBLE_CONTENT_TYPES.has(String(contentType || '').toLowerCase());

/**
 * Bild -> WebP. Alles andere kommt unveraendert zurueck; `converted` sagt,
 * was passiert ist.
 */
export async function toWebpImage(body: Buffer, contentType: string): Promise<WebpImage> {
    const unchanged: WebpImage = { body, contentType, converted: false };

    if (!Buffer.isBuffer(body) || body.length === 0) return unchanged;
    if (!isConvertibleImageType(contentType)) return unchanged;

    try {
        const meta = await sharp(body, { failOn: 'none' }).metadata();
        const format = String(meta.format || '').toLowerCase();
        if (!CONVERTIBLE_FORMATS.has(format)) return unchanged;

        /* Ein bewegtes GIF muss als Ganzes durch — sonst bleibt das erste
         * Einzelbild uebrig und die Bewegung ist weg. */
        const animated = (meta.pages ?? 1) > 1;

        const candidates = await Promise.all([
            encode(body, animated, { quality: WEBP_QUALITY, alphaQuality: 100, effort: 4, smartSubsample: true }),
            // Verlustfrei lohnt sich bei Durchsichtigkeit und bei flaechigen
            // Bildern (Zeichnungen, Bildschirmfotos) — also genau dort, wo PNG
            // frueher die richtige Wahl war.
            meta.hasAlpha || format === 'png'
                ? encode(body, animated, { lossless: true, effort: 4 })
                : Promise.resolve(null),
        ]);

        const best = candidates
            .filter((item): item is Buffer => Boolean(item && item.length > 0))
            .sort((a, b) => a.length - b.length)[0];

        if (!best) return unchanged;
        return { body: best, contentType: WEBP_CONTENT_TYPE, converted: true };
    } catch {
        // Unlesbar oder eine Art, die sharp nicht kennt: das Original bleibt.
        return unchanged;
    }
}

async function encode(
    body: Buffer,
    animated: boolean,
    options: sharp.WebpOptions,
): Promise<Buffer | null> {
    try {
        const pipeline = sharp(body, { failOn: 'none', animated });
        // EXIF-Drehung ANWENDEN, bevor EXIF wegfaellt: ein Handyfoto laege
        // sonst quer. Bei bewegten Bildern laesst sharp das nicht zu.
        if (!animated) pipeline.rotate();
        return await pipeline.webp(options).toBuffer();
    } catch {
        return null;
    }
}
