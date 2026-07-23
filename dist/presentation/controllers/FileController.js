"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileController = void 0;
const sharp_1 = __importDefault(require("sharp"));
require("../middlewares/AuthMiddleware");
const ObjectStorageService_1 = require("../../infrastructure/services/ObjectStorageService");
/** Longest image edge after server-side resizing. */
const MAX_IMAGE_DIMENSION = 2048;
class FileController {
    /**
     * POST /files/presign — returns a short-lived presigned PUT URL.
     * The object key is generated server-side (tenant prefix + UUID); the
     * declared content type and byte size are baked into the signature, so the
     * client can upload only that exact payload shape.
     */
    async presign(req, res) {
        try {
            if (!ObjectStorageService_1.objectStorageService.isConfigured()) {
                return res.status(503).json({ error: 'Dosya depolama yapılandırılmamış. Sistem yöneticisi ile iletişime geçin.' });
            }
            const { contentType, size } = req.body;
            const objectKey = ObjectStorageService_1.objectStorageService.buildObjectKey(req.user.tenantId, contentType);
            const uploadUrl = await ObjectStorageService_1.objectStorageService.presignPut(objectKey, contentType, size);
            res.status(200).json({ uploadUrl, objectKey, expiresIn: ObjectStorageService_1.PRESIGN_TTL_SECONDS });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /**
     * POST /files/upload-image — multipart image upload that is validated and
     * RE-ENCODED with Sharp before storage. Decoding + re-encoding produces a
     * brand-new file: appended payloads, polyglot tricks and metadata
     * (EXIF/XMP, GPS...) from a fake or hostile "image" do not survive it.
     */
    async uploadImage(req, res) {
        try {
            if (!ObjectStorageService_1.objectStorageService.isConfigured()) {
                return res.status(503).json({ error: 'Dosya depolama yapılandırılmamış. Sistem yöneticisi ile iletişime geçin.' });
            }
            const file = req.file;
            if (!file) {
                return res.status(400).json({ error: 'Dosya zorunludur (multipart alan adı: "file").' });
            }
            if (!ObjectStorageService_1.IMAGE_CONTENT_TYPES.includes(file.mimetype)) {
                return res.status(400).json({ error: 'Sadece JPEG, PNG veya WebP görselleri yüklenebilir.' });
            }
            // sharp() decoding doubles as real content validation: a file that
            // merely claims to be an image fails here regardless of its
            // Content-Type header or magic bytes.
            let pipeline;
            let format;
            try {
                pipeline = (0, sharp_1.default)(file.buffer, { failOn: 'error' });
                format = (await pipeline.metadata()).format;
            }
            catch {
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
            let contentType;
            let output;
            if (format === 'png') {
                contentType = 'image/png';
                output = await pipeline.png({ compressionLevel: 9 }).toBuffer();
            }
            else if (format === 'webp') {
                contentType = 'image/webp';
                output = await pipeline.webp({ quality: 85 }).toBuffer();
            }
            else {
                contentType = 'image/jpeg';
                output = await pipeline.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
            }
            if (output.length > ObjectStorageService_1.MAX_UPLOAD_BYTES) {
                return res.status(413).json({ error: 'Görsel, işlendikten sonra bile 15 MB sınırını aşıyor.' });
            }
            const objectKey = ObjectStorageService_1.objectStorageService.buildObjectKey(req.user.tenantId, contentType);
            await ObjectStorageService_1.objectStorageService.putObject(objectKey, output, contentType);
            res.status(201).json({ objectKey, contentType, bytes: output.length });
        }
        catch (error) {
            console.error('[FileController.uploadImage]', error);
            res.status(500).json({ error: 'Görsel yüklenemedi.' });
        }
    }
    /** GET /files/config — lets the frontend know the accepted types/limits. */
    async config(_req, res) {
        res.status(200).json({
            configured: ObjectStorageService_1.objectStorageService.isConfigured(),
            maxUploadBytes: ObjectStorageService_1.MAX_UPLOAD_BYTES,
            allowedContentTypes: Object.keys(ObjectStorageService_1.ALLOWED_CONTENT_TYPES),
            presignTtlSeconds: ObjectStorageService_1.PRESIGN_TTL_SECONDS,
        });
    }
}
exports.FileController = FileController;
//# sourceMappingURL=FileController.js.map