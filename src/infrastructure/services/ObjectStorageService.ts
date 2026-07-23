import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB
export const PRESIGN_TTL_SECONDS = 10 * 60;       // 10 minutes (policy maximum)

/** Content-Type whitelist → extension. The extension always comes from this map. */
export const ALLOWED_CONTENT_TYPES: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'application/pdf': 'pdf',
};

export const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export class ObjectStorageService {
    private client: S3Client | null = null;
    private bucket = '';

    private getClient(): S3Client | null {
        if (this.client) return this.client;

        const endpoint = process.env.OFFITEC_S3_ENDPOINT;
        const accessKeyId = process.env.OFFITEC_S3_ACCESS_KEY_ID;
        const secretAccessKey = process.env.OFFITEC_S3_SECRET_ACCESS_KEY;
        this.bucket = process.env.OFFITEC_S3_BUCKET || '';

        if (!endpoint || !accessKeyId || !secretAccessKey || !this.bucket) return null;

        this.client = new S3Client({
            endpoint,
            region: process.env.OFFITEC_S3_REGION || 'auto', // R2 uses "auto"
            credentials: { accessKeyId, secretAccessKey },
            forcePathStyle: true,
        });
        return this.client;
    }

    isConfigured(): boolean {
        return this.getClient() !== null;
    }

    /**
     * Backend-generated object key: `<tenantId>/<yyyy-mm>/<uuid>.<ext>`.
     * The extension is derived from the whitelisted content type — the
     * client's file name plays no part.
     */
    buildObjectKey(tenantId: string, contentType: string): string {
        const ext = ALLOWED_CONTENT_TYPES[contentType];
        if (!ext) throw new Error('Desteklenmeyen dosya türü.');
        const month = new Date().toISOString().slice(0, 7);
        return `${tenantId}/${month}/${crypto.randomUUID()}.${ext}`;
    }

    /** Presigned PUT — type and exact byte size are part of the signature. */
    async presignPut(key: string, contentType: string, contentLength: number): Promise<string> {
        const client = this.getClient();
        if (!client) throw new Error('Dosya depolama yapılandırılmamış.');

        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            ContentType: contentType,
            ContentLength: contentLength,
        });

        return getSignedUrl(client, command, {
            expiresIn: PRESIGN_TTL_SECONDS,
            // Sign these headers so the upload MUST match them byte for byte.
            signableHeaders: new Set(['content-type', 'content-length']),
        });
    }

    /** Direct server-side upload (used after Sharp re-encodes images). */
    async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
        const client = this.getClient();
        if (!client) throw new Error('Dosya depolama yapılandırılmamış.');

        await client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
        }));
    }
}

export const objectStorageService = new ObjectStorageService();
