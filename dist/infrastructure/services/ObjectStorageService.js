"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.objectStorageService = exports.ObjectStorageService = exports.IMAGE_CONTENT_TYPES = exports.ALLOWED_CONTENT_TYPES = exports.DOWNLOAD_TTL_SECONDS = exports.PRESIGN_TTL_SECONDS = exports.MAX_UPLOAD_BYTES = void 0;
const crypto_1 = __importDefault(require("crypto"));
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
/**
 * S3 / Cloudflare R2 object storage.
 *
 * Security rules baked in:
 * - Object keys are generated HERE (tenant prefix + UUID + whitelisted
 *   extension). Client-supplied file names never reach the key, so path
 *   traversal ("../..") and key collisions are impossible by construction.
 * - Presigned PUT URLs live at most 10 minutes and have Content-Type and
 *   Content-Length signed in — the client can upload exactly the declared
 *   type/size to exactly the generated key, nothing else.
 * - 15 MB hard size cap.
 */
exports.MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB
exports.PRESIGN_TTL_SECONDS = 10 * 60; // 10 minutes (policy maximum)
/**
 * Lesefrist. Kuerzer als die Schreibfrist braucht sie nicht zu sein, laenger
 * darf sie nicht: eine weitergereichte Adresse soll nicht den Tag ueberleben.
 */
exports.DOWNLOAD_TTL_SECONDS = 15 * 60; // 15 minutes
/** Content-Type whitelist → extension. The extension always comes from this map. */
exports.ALLOWED_CONTENT_TYPES = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
};
exports.IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
class ObjectStorageService {
    client = null;
    bucket = '';
    getClient() {
        if (this.client)
            return this.client;
        const endpoint = process.env.OFFITEC_S3_ENDPOINT;
        const accessKeyId = process.env.OFFITEC_S3_ACCESS_KEY_ID;
        const secretAccessKey = process.env.OFFITEC_S3_SECRET_ACCESS_KEY;
        this.bucket = process.env.OFFITEC_S3_BUCKET || '';
        if (!endpoint || !accessKeyId || !secretAccessKey || !this.bucket)
            return null;
        this.client = new client_s3_1.S3Client({
            endpoint,
            region: process.env.OFFITEC_S3_REGION || 'auto', // R2 uses "auto"
            credentials: { accessKeyId, secretAccessKey },
            forcePathStyle: true,
        });
        return this.client;
    }
    isConfigured() {
        return this.getClient() !== null;
    }
    /**
     * Backend-generated object key: `<tenantId>/<yyyy-mm>/<uuid>.<ext>`.
     * The extension is derived from the whitelisted content type — the
     * client's file name plays no part.
     */
    buildObjectKey(tenantId, contentType) {
        const ext = exports.ALLOWED_CONTENT_TYPES[contentType];
        if (!ext)
            throw new Error('Desteklenmeyen dosya türü.');
        const month = new Date().toISOString().slice(0, 7);
        return `${tenantId}/${month}/${crypto_1.default.randomUUID()}.${ext}`;
    }
    /** Presigned PUT — type and exact byte size are part of the signature. */
    async presignPut(key, contentType, contentLength) {
        const client = this.getClient();
        if (!client)
            throw new Error('Dosya depolama yapılandırılmamış.');
        const command = new client_s3_1.PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            ContentType: contentType,
            ContentLength: contentLength,
        });
        return (0, s3_request_presigner_1.getSignedUrl)(client, command, {
            expiresIn: exports.PRESIGN_TTL_SECONDS,
            // Sign these headers so the upload MUST match them byte for byte.
            signableHeaders: new Set(['content-type', 'content-length']),
        });
    }
    /** Direct server-side upload (used after Sharp re-encodes images). */
    async putObject(key, body, contentType) {
        const client = this.getClient();
        if (!client)
            throw new Error('Dosya depolama yapılandırılmamış.');
        await client.send(new client_s3_1.PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
        }));
    }
    /**
     * Presigned GET — der Leseweg.
     *
     * Der Eimer bleibt privat: nichts ist oeffentlich lesbar. Wer eine Datei
     * sehen darf, entscheidet weiterhin unsere eigene Anmeldung; sie stellt
     * danach eine Adresse aus, die kurz gilt und nur fuer diesen einen
     * Schluessel. Die Bytes reisen von Cloudflare direkt zum Browser — sie
     * laufen nicht mehr durch unseren Server.
     *
     * `downloadName` setzt den Dateinamen, den der Browser beim Speichern
     * vorschlaegt: der Schluessel ist eine UUID, der Mensch will "Vertrag.pdf".
     */
    async presignGet(key, options = {}) {
        const client = this.getClient();
        if (!client)
            throw new Error('Dosya depolama yapılandırılmamış.');
        const command = new client_s3_1.GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
            ...(options.contentType ? { ResponseContentType: options.contentType } : {}),
            ...(options.downloadName
                ? { ResponseContentDisposition: buildContentDisposition(options.downloadName) }
                : {}),
        });
        return (0, s3_request_presigner_1.getSignedUrl)(client, command, {
            expiresIn: options.expiresIn ?? exports.DOWNLOAD_TTL_SECONDS,
        });
    }
    /**
     * Die Bytes selbst holen. Der Browser braucht das nicht — er bekommt eine
     * presignte Adresse. Der Server braucht es doch: die PDF-Erzeugung setzt
     * Bilder in das Dokument ein, und der Umzug alter Anhaenge liest sie.
     */
    async getObject(key) {
        const client = this.getClient();
        if (!client)
            throw new Error('Dosya depolama yapılandırılmamış.');
        const result = await client.send(new client_s3_1.GetObjectCommand({ Bucket: this.bucket, Key: key }));
        const body = result.Body;
        if (!body?.transformToByteArray)
            throw new Error('Dosya okunamadı.');
        return Buffer.from(await body.transformToByteArray());
    }
    /** Gibt es das Objekt? (Der Umzug prueft damit, ohne die Bytes zu ziehen.) */
    async objectExists(key) {
        const client = this.getClient();
        if (!client)
            return false;
        try {
            await client.send(new client_s3_1.HeadObjectCommand({ Bucket: this.bucket, Key: key }));
            return true;
        }
        catch (error) {
            const status = error?.$metadata?.httpStatusCode;
            if (status === 404 || error?.name === 'NotFound')
                return false;
            throw error;
        }
    }
    /**
     * DIE OEFFENTLICHE ADRESSE (OFFITEC_S3_PUBLIC_BASE_URL).
     *
     * Ist in Cloudflare eine Domain an den Eimer gehaengt (cdn.offitec.ch oder
     * eine r2.dev-Adresse), kann eine Datei ohne Unterschrift geladen werden.
     * Das lohnt sich fuer Bilder, die staendig am Bildschirm haengen: 132
     * Produktbilder einzeln zu presignen sind 132 Unterschriften fuer nichts,
     * und eine feste Adresse laesst sich vom Browser zwischenspeichern.
     *
     * Der Preis ist, dass die Adresse fuer JEDEN gilt, der sie hat. Darum
     * benutzen nur die Bildablagen sie; Unterlagen — Vertraege, Personalakten,
     * Angebotsanhaenge — bleiben bei presignten Adressen mit Ablaufzeit.
     *
     * Ohne gesetzte Variable gibt es keine oeffentliche Adresse und alles
     * laeuft weiter ueber Unterschriften.
     */
    publicUrl(key) {
        const base = this.publicBaseUrl();
        if (!base)
            return null;
        // Der Schluessel traegt "/" als Trenner — jeder Abschnitt einzeln.
        const encoded = String(key).split('/').map(encodeURIComponent).join('/');
        return `${base}/${encoded}`;
    }
    /** Turn a permanent public R2 URL back into its object key. */
    objectKeyFromPublicUrl(value) {
        const base = this.publicBaseUrl();
        if (!base)
            return null;
        try {
            const baseUrl = new URL(`${base}/`);
            const candidate = new URL(String(value));
            if (candidate.origin !== baseUrl.origin)
                return null;
            if (!candidate.pathname.startsWith(baseUrl.pathname))
                return null;
            const encodedKey = candidate.pathname.slice(baseUrl.pathname.length);
            if (!encodedKey || candidate.search || candidate.hash)
                return null;
            return encodedKey.split('/').map((part) => decodeURIComponent(part)).join('/');
        }
        catch {
            return null;
        }
    }
    publicBaseUrl() {
        return String(process.env.R2_PUBLIC_URL
            || process.env.OFFITEC_S3_PUBLIC_BASE_URL
            || '').trim().replace(/\/+$/, '');
    }
    /** Loeschen. Ein fehlendes Objekt ist kein Fehler — das Ziel ist erreicht. */
    async deleteObject(key) {
        const client = this.getClient();
        if (!client)
            throw new Error('Dosya depolama yapılandırılmamış.');
        await client.send(new client_s3_1.DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    }
}
exports.ObjectStorageService = ObjectStorageService;
/**
 * RFC 5987: der schlichte Name fuer alte Programme, der UTF-8-Name fuer alle
 * anderen. Anfuehrungszeichen und Zeilenumbrueche fliegen raus — sie wuerden
 * den Kopf der Antwort zerlegen.
 */
function buildContentDisposition(fileName) {
    const clean = String(fileName).replace(/[\r\n"\\]/g, '_').trim() || 'download';
    const ascii = clean.replace(/[^\x20-\x7E]/g, '_');
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}
exports.objectStorageService = new ObjectStorageService();
//# sourceMappingURL=ObjectStorageService.js.map