import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { FileController } from '../controllers/FileController';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { validate } from '../middlewares/ValidationMiddleware';
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES } from '../../infrastructure/services/ObjectStorageService';

const router = Router();
const fileController = new FileController();

// Memory storage: the buffer only ever exists to be re-encoded by Sharp and
// pushed to object storage — nothing touches the server's disk.
const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

const presignSchema = z.object({
    contentType: z.string().refine(
        (value) => Object.prototype.hasOwnProperty.call(ALLOWED_CONTENT_TYPES, value),
        { message: `Desteklenmeyen dosya türü. İzin verilenler: ${Object.keys(ALLOWED_CONTENT_TYPES).join(', ')}` },
    ),
    size: z.number({ error: 'Dosya boyutu (byte) zorunludur.' })
        .int('Dosya boyutu tam sayı olmalıdır.')
        .positive('Dosya boyutu pozitif olmalıdır.')
        .max(MAX_UPLOAD_BYTES, 'Dosya boyutu 15 MB sınırını aşamaz.'),
});

/**
 * @swagger
 * /files/presign:
 *   post:
 *     tags: [Files]
 *     summary: 10 dk geçerli presigned PUT URL üretir (object key backend'de UUID ile oluşturulur)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contentType, size]
 *             properties:
 *               contentType:
 *                 type: string
 *                 example: application/pdf
 *               size:
 *                 type: integer
 *                 description: Yüklenecek dosyanın byte cinsinden boyutu (max 15 MB)
 *     responses:
 *       200:
 *         description: uploadUrl + objectKey
 *       400:
 *         description: Geçersiz tür veya boyut
 *       503:
 *         description: Depolama yapılandırılmamış
 */
router.post('/presign', requireAuth, validate({ body: presignSchema }), (req, res) => fileController.presign(req, res));

/**
 * @swagger
 * /files/upload-image:
 *   post:
 *     tags: [Files]
 *     summary: Görseli doğrular, Sharp ile yeniden kodlar (zararlı içerik temizlenir) ve depolar
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: objectKey döner
 *       400:
 *         description: Geçersiz görsel
 *       413:
 *         description: 15 MB sınırı aşıldı
 */
router.post('/upload-image', requireAuth, imageUpload.single('file'), (req, res) => fileController.uploadImage(req, res));

/**
 * @swagger
 * /files/config:
 *   get:
 *     tags: [Files]
 *     summary: Yükleme limitleri ve izin verilen türler
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Limit bilgisi
 */
router.get('/config', requireAuth, (req, res) => fileController.config(req, res));

export default router;
