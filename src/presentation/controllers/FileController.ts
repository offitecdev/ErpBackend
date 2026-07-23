import { Request, Response } from 'express';
import sharp from 'sharp';
import '../middlewares/AuthMiddleware';
import {
    objectStorageService,
    ALLOWED_CONTENT_TYPES,
    IMAGE_CONTENT_TYPES,
    MAX_UPLOAD_BYTES,
    PRESIGN_TTL_SECONDS,
} from '../../infrastructure/services/ObjectStorageService';

/** Longest image edge after server-side resizing. */
const MAX_IMAGE_DIMENSION = 2048;

export class FileController {
    /**
     * POST /files/presign — returns a short-lived presigned PUT URL.
     * The object key is generated server-side (tenant prefix + UUID); the
     * declared content type and byte size are baked into the signature, so the
     * client can upload only that exact payload shape.
     */
    async presign(req: Request, res: Response) {
        try {
            if (!objectStorageService.isConfigured()) {
                return res.status(503).json({ error: 'Dosya depolama yapılandırılmamış. Sistem yöneticisi ile iletişime geçin.' });
            }

            const { contentType, size } = req.body as { contentType: string; size: number };
            const objectKey = objectStorageService.buildObjectKey(req.user!.tenantId, contentType);
            const uploadUrl = await objectStorageService.presignPut(objectKey, contentType, size);

            res.status(200).json({ uploadUrl, objectKey, expiresIn: PRESIGN_TTL_SECONDS });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * POST /files/upload-image — multipart image upload that is validated and
     * RE-ENCODED with Sharp before storage. Decoding + re-encoding produces a
     * brand-new file: appended payloads, polyglot tricks and metadata
     * (EXIF/XMP, GPS...) from a fake or hostile "image" do not survive it.
     */
    async uploadImage(req: Request, res: Response) {
        try {
            if (!objectStorageService.isConfigured()) {
                return res.status(503).json({ error: 'Dosya depolama yapılandırılmamış. Sistem yöneticisi ile iletişime geçin.' });
            }

            const file = (req as any).file as { buffer: Buffer; mimetype: string } | undefined;
            if (!file) {
                return res.status(400).json({ error: 'Dosya zorunludur (multipart alan adı: "file").' });
            }
            if (!IMAGE_CONTENT_TYPES.includes(file.mimetype)) {
                return res.status(400).json({ error: 'Sadece JPEG, PNG veya WebP görselleri yüklenebilir.' });
            }

            // sharp() decoding doubles as real content validation: a file that
            // merely claims to be an image fails here regardless of its
            // Content-Type header or magic bytes.
            let pipeline: sharp.Sharp;
            let format: string | undefined;
            try {
                pipeline = sharp(file.buffer, { failOn: 'error' });
                format = (await pipeline.metadata()).format;
            } catch {
                return res.status(400).json({ error: 'Dosya geçerli bir görsel değil.' });
            }
            if (!format || !['jpeg', 'png', 'webp'].includes(format)) {
                return res.status(400).json({ error: 'Dosya geçerli bir görsel değil.' });
            }

            pipeline = pipeline
                .rotate() // apply EXIF orientation before EXIF is dropped
                .resize({
                    width: MAX_IMAGE_DIMENSION,
                    height: MAX_IMAGE_DIMENSION,
                    fit: 'inside',
                    withoutEnlargement: true,
                });

            // Re-encode into the declared family (metadata is dropped by default).
            let contentType: string;
            let output: Buffer;
            if (format === 'png') {
                contentType = 'image/png';
                output = await pipeline.png({ compressionLevel: 9 }).toBuffer();
            } else if (format === 'webp') {
                contentType = 'image/webp';
                output = await pipeline.webp({ quality: 85 }).toBuffer();
            } else {
                contentType = 'image/jpeg';
                output = await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
            }

            if (output.length > MAX_UPLOAD_BYTES) {
                return res.status(413).json({ error: 'Görsel, işlendikten sonra bile 15 MB sınırını aşıyor.' });
            }

            const objectKey = objectStorageService.buildObjectKey(req.user!.tenantId, contentType);
            await objectStorageService.putObject(objectKey, output, contentType);

            res.status(201).json({ objectKey, contentType, bytes: output.length });
        } catch (error: any) {
            console.error('[FileController.uploadImage]', error);
            res.status(500).json({ error: 'Görsel yüklenemedi.' });
        }
    }

    /** GET /files/config — lets the frontend know the accepted types/limits. */
    async config(_req: Request, res: Response) {
        res.status(200).json({
            configured: objectStorageService.isConfigured(),
            maxUploadBytes: MAX_UPLOAD_BYTES,
            allowedContentTypes: Object.keys(ALLOWED_CONTENT_TYPES),
            presignTtlSeconds: PRESIGN_TTL_SECONDS,
        });
    }
}
