"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.objectStorageService = exports.ObjectStorageService = exports.IMAGE_CONTENT_TYPES = exports.ALLOWED_CONTENT_TYPES = exports.PRESIGN_TTL_SECONDS = exports.MAX_UPLOAD_BYTES = void 0;
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
}
exports.ObjectStorageService = ObjectStorageService;
exports.objectStorageService = new ObjectStorageService();
//# sourceMappingURL=ObjectStorageService.js.map