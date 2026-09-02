import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import prisma from '../database/prisma.client';
import {
    articleImageStorage,
    isStoredReference,
    positionImageStorage,
} from './ImageStore';

/**
 * Product images for the offer PDF, reduced to the size the PDF actually draws.
 *
 * The stored images are full-resolution uploads (1600–2000 px PNGs, 1–2 MB each)
 * while `tenderPdfModern` draws them into a 24 mm square — ~320 px even at print
 * resolution. Shipping the originals meant reading megabytes of base64 LongText
 * out of the database and pushing them through JSON on every single export; the
 * downscaled JPEG is roughly 150x smaller and visually identical at that size.
 *
 * Because the conversion is pure (same source bytes -> same thumbnail), the
 * result is cached in-process, on disk, and in a dedicated database table
 * shared by every server instance. The cache key carries the article's
 * `updatedAt`; repository writes also refresh the durable derivative.
 */

/** 24 mm at ~340 DPI. Above this the PDF gains nothing but bytes. */
const MAX_PX = 320;
const JPEG_QUALITY = 78;

/** In-process budget. Thumbnails are ~10 KB, so this holds thousands of them. */
const MEMORY_BUDGET_BYTES = 32 * 1024 * 1024;

const CACHE_DIR = process.env.OFFITEC_PDF_THUMB_CACHE_DIR
    || path.join(os.tmpdir(), 'offitec-pdf-thumbs');

const JPEG_DATA_URI_PREFIX = 'data:image/jpeg;base64,';
const MAX_PERSISTED_URI_LENGTH = 512 * 1024;

// Insertion-ordered Map used as an LRU: a hit is re-inserted to move it to the
// end, and the oldest entries are dropped once the budget is exceeded.
const memoryCache = new Map<string, string>();
let memoryBytes = 0;

const memoryGet = (key: string): string | undefined => {
    const hit = memoryCache.get(key);
    if (hit === undefined) return undefined;
    memoryCache.delete(key);
    memoryCache.set(key, hit);
    return hit;
};

const memoryPut = (key: string, value: string) => {
    const previous = memoryCache.get(key);
    if (previous !== undefined) memoryBytes -= previous.length;
    memoryCache.set(key, value);
    memoryBytes += value.length;
    while (memoryBytes > MEMORY_BUDGET_BYTES && memoryCache.size > 0) {
        const oldest = memoryCache.keys().next().value as string;
        memoryBytes -= (memoryCache.get(oldest) || '').length;
        memoryCache.delete(oldest);
    }
};

/** Cache keys become file names, so anything outside [A-Za-z0-9_-] is escaped. */
const cacheFileName = (key: string) => `${key.replace(/[^A-Za-z0-9_-]/g, '_')}.jpg`;

const diskGet = async (key: string): Promise<string | null> => {
    try {
        const buf = await fs.readFile(path.join(CACHE_DIR, cacheFileName(key)));
        return JPEG_DATA_URI_PREFIX + buf.toString('base64');
    } catch {
        return null;
    }
};

const diskPut = async (key: string, dataUri: string): Promise<void> => {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
        // Write-then-rename so a crash mid-write cannot leave a truncated file
        // that would later be served as a corrupt image.
        const target = path.join(CACHE_DIR, cacheFileName(key));
        const temp = `${target}.${process.pid}.tmp`;
        await fs.writeFile(temp, Buffer.from(base64, 'base64'));
        await fs.rename(temp, target);
    } catch {
        /* the disk cache is an optimisation — never fail a request over it */
    }
};

type ThumbnailSourceType = 'ARTICLE' | 'POSITION';

/**
 * DIE BYTES ZUM QUELLWERT — Daten-URI ODER ABLAGEVERWEIS (01.09.2026).
 *
 * Seit die Bilder in R2 liegen, steht in der Spalte nicht mehr das Bild,
 * sondern `r2:article-image/...`. Der PDF-Weg darf davon nichts merken: er
 * braucht Bytes, und die holt er hier — aus der Zeichenkette selbst, oder aus
 * der Ablage. Anders als der Browser darf der Server das direkt tun; die
 * fehlenden CORS-Kopfzeilen am Eimer betreffen nur ihn.
 */
const sourceBytes = async (
    source: string,
    sourceType?: ThumbnailSourceType,
): Promise<Buffer | null> => {
    if (source.startsWith('data:')) {
        const comma = source.indexOf(',');
        if (comma < 0) return null;
        return Buffer.from(source.slice(comma + 1), 'base64');
    }
    if (!isStoredReference(source)) return null;
    const storage = sourceType === 'POSITION' ? positionImageStorage : articleImageStorage;
    try {
        return await storage.read(source);
    } catch {
        // Die Datei fehlt: das PDF entsteht ohne dieses Bild, nicht gar nicht.
        return null;
    }
};

/**
 * Downscales one stored image — a base64 data URI or a storage reference.
 * Anything that is not a decodable raster image (a plain http URL, an SVG, a
 * corrupt upload) is returned untouched so the PDF still gets whatever the
 * record held.
 */
export const toThumbnailDataUri = async (
    source: string,
    sourceType?: ThumbnailSourceType,
): Promise<string> => {
    const input = await sourceBytes(source, sourceType);
    if (!input) return source;
    try {
        if (input.length === 0) return source;
        const out = await sharp(input, { failOn: 'none' })
            .resize({ width: MAX_PX, height: MAX_PX, fit: 'inside', withoutEnlargement: true })
            // JPEG has no alpha; flattening onto white keeps transparent PNG
            // product shots from turning into black squares.
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
            .toBuffer();
        /* Ein winziges Original (schon in Vorschaugroesse) kann groesser
         * herauskommen — dann bleibt das Original. Verglichen wird gegen die
         * BYTES, nicht gegen die Zeichenkette: ein Ablageverweis ist 60 Zeichen
         * lang und wuerde jeden Vergleich gewinnen, obwohl er gar kein Bild ist. */
        const thumb = JPEG_DATA_URI_PREFIX + out.toString('base64');
        if (!source.startsWith('data:')) return thumb;
        return thumb.length < source.length ? thumb : source;
    } catch {
        return source;
    }
};

type ArticleVersion = {
    id: string;
    updatedAt: Date;
};

const loadPersistedThumbnails = async (
    tenantId: string,
    sourceType: ThumbnailSourceType,
    sourceIds: string[],
): Promise<Map<string, string>> => {
    if (sourceIds.length === 0) return new Map();
    try {
        const rows = await prisma.pdfImageThumbnail.findMany({
            where: { tenantId, sourceType, sourceId: { in: sourceIds } },
            select: { sourceId: true, imageUrl: true },
        });
        return new Map(rows.map((row) => [row.sourceId, row.imageUrl]));
    } catch {
        // Keep rolling deployments compatible while the migration is being
        // applied. The endpoint can still generate the image lazily.
        return new Map();
    }
};

const persistThumbnailValue = async (
    tenantId: string,
    sourceType: ThumbnailSourceType,
    sourceId: string,
    imageUrl: string,
    sourceVersion?: string,
): Promise<void> => {
    if (imageUrl.length > MAX_PERSISTED_URI_LENGTH) return;
    /* NUR ECHTE BILDER WERDEN GEMERKT. Schlaegt die Umwandlung fehl, gibt
     * `toThumbnailDataUri` den Quellwert zurueck — seit dem Umzug also unter
     * Umstaenden einen `r2:`-Verweis. Der waere als Vorschaubild wertlos und
     * wuerde, einmal gespeichert, bei jedem PDF wieder herauskommen. */
    if (!imageUrl.startsWith('data:')) return;
    try {
        await prisma.pdfImageThumbnail.upsert({
            where: {
                tenantId_sourceType_sourceId: { tenantId, sourceType, sourceId },
            },
            create: {
                id: nanoid(10),
                tenantId,
                sourceType,
                sourceId,
                sourceVersion: sourceVersion ?? null,
                imageUrl,
            },
            update: {
                tenantId,
                sourceVersion: sourceVersion ?? null,
                imageUrl,
            },
        });
    } catch {
        // A thumbnail is an optimisation, never a reason for the parent write
        // or PDF export to fail.
    }
};

/**
 * Keeps the durable PDF derivative in sync when an image is created, changed
 * or removed. Repositories call this at write time, taking conversion out of
 * the export path for all new records.
 */
export const persistPdfThumbnail = async (
    tenantId: string,
    sourceType: ThumbnailSourceType,
    sourceId: string,
    source: string | null,
    sourceVersion?: string,
): Promise<string | null> => {
    if (!source) {
        try {
            await prisma.pdfImageThumbnail.deleteMany({
                where: { tenantId, sourceType, sourceId },
            });
        } catch {
            /* migration may not be present during a rolling deployment */
        }
        return null;
    }

    const thumbnail = await toThumbnailDataUri(source, sourceType);
    await persistThumbnailValue(
        tenantId,
        sourceType,
        sourceId,
        thumbnail,
        sourceVersion,
    );
    return thumbnail;
};

/**
 * Thumbnails for the given articles, reading full-size originals only when the
 * durable, memory and disk caches all miss.
 */
export const getArticleThumbnails = async (
    tenantId: string,
    articles: ArticleVersion[],
): Promise<Array<{ id: string; imageUrl: string }>> => {
    if (articles.length === 0) return [];

    const keyOf = (article: ArticleVersion) =>
        `${tenantId}:${article.id}:${article.updatedAt.getTime()}`;
    const resolved = new Map<string, string>();
    const missing: ArticleVersion[] = [];
    const persisted = await loadPersistedThumbnails(
        tenantId,
        'ARTICLE',
        articles.map((article) => article.id),
    );

    for (const article of articles) {
        const persistedImage = persisted.get(article.id);
        if (persistedImage) {
            memoryPut(keyOf(article), persistedImage);
            resolved.set(article.id, persistedImage);
            continue;
        }
        const hit = memoryGet(keyOf(article));
        if (hit !== undefined) resolved.set(article.id, hit);
        else missing.push(article);
    }

    const stillMissing: ArticleVersion[] = [];
    await Promise.all(missing.map(async (article) => {
        const hit = await diskGet(keyOf(article));
        if (hit) {
            memoryPut(keyOf(article), hit);
            resolved.set(article.id, hit);
            await persistThumbnailValue(
                tenantId,
                'ARTICLE',
                article.id,
                hit,
                String(article.updatedAt.getTime()),
            );
        } else {
            stillMissing.push(article);
        }
    }));

    if (stillMissing.length > 0) {
        const versionById = new Map(stillMissing.map((article) => [article.id, article] as const));
        const rows = await prisma.article.findMany({
            where: { tenantId, id: { in: stillMissing.map((article) => article.id) } },
            select: { id: true, imageUrl: true },
        });
        await Promise.all(rows.map(async (row) => {
            if (!row.imageUrl) return;
            const thumbnail = await toThumbnailDataUri(row.imageUrl, 'ARTICLE');
            const article = versionById.get(row.id);
            if (article) {
                const key = keyOf(article);
                memoryPut(key, thumbnail);
                if (thumbnail.startsWith(JPEG_DATA_URI_PREFIX)) void diskPut(key, thumbnail);
                await persistThumbnailValue(
                    tenantId,
                    'ARTICLE',
                    row.id,
                    thumbnail,
                    String(article.updatedAt.getTime()),
                );
            }
            resolved.set(row.id, thumbnail);
        }));
    }

    // Was keine Daten-URI ist, kann das PDF nicht zeichnen — es faellt weg,
    // statt als kaputtes Bild mitzureisen.
    return articles
        .map((article) => ({ id: article.id, imageUrl: resolved.get(article.id) || '' }))
        .filter((row) => row.imageUrl.startsWith('data:'));
};

/**
 * Thumbnails for per-position uploads. Only legacy cache misses read the
 * original LONGTEXT; the small derivative is then persisted separately.
 */
export const getPositionThumbnails = async (
    tenantId: string,
    tenderId: string,
    rows: Array<{ id: string }>,
): Promise<Array<{ id: string; imageUrl: string }>> => {
    if (rows.length === 0) return [];

    const persisted = await loadPersistedThumbnails(
        tenantId,
        'POSITION',
        rows.map((row) => row.id),
    );
    const resolved = rows
        .filter((row) => persisted.has(row.id))
        .map((row) => ({ id: row.id, imageUrl: persisted.get(row.id) as string }));
    const missingIds = rows
        .filter((row) => !persisted.has(row.id))
        .map((row) => row.id);
    if (missingIds.length === 0) return resolved;

    const originals = await prisma.position.findMany({
        where: {
            tenantId,
            tenderId,
            id: { in: missingIds },
            imageUrl: { not: null, notIn: [''] },
        },
        select: { id: true, imageUrl: true },
    });
    const generated = await Promise.all(originals.map(async (row) => {
        const imageUrl = await toThumbnailDataUri(row.imageUrl as string, 'POSITION');
        await persistThumbnailValue(tenantId, 'POSITION', row.id, imageUrl);
        return { id: row.id, imageUrl };
    }));
    return [...resolved, ...generated.filter((row) => row.imageUrl.startsWith('data:'))];
};
