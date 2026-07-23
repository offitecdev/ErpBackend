"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const zod_1 = require("zod");
const FileController_1 = require("../controllers/FileController");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const ValidationMiddleware_1 = require("../middlewares/ValidationMiddleware");
const ObjectStorageService_1 = require("../../infrastructure/services/ObjectStorageService");
const router = (0, express_1.Router)();
const fileController = new FileController_1.FileController();
// Memory storage: the buffer only ever exists to be re-encoded by Sharp and
// pushed to object storage — nothing touches the server's disk.
const imageUpload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: ObjectStorageService_1.MAX_UPLOAD_BYTES, files: 1 },
});
const presignSchema = zod_1.z.object({
    contentType: zod_1.z.string().refine((value) => Object.prototype.hasOwnProperty.call(ObjectStorageService_1.ALLOWED_CONTENT_TYPES, value), { message: `Desteklenmeyen dosya türü. İzin verilenler: ${Object.keys(ObjectStorageService_1.ALLOWED_CONTENT_TYPES).join(', ')}` }),
    size: zod_1.z.number({ error: 'Dosya boyutu (byte) zorunludur.' })
        .int('Dosya boyutu tam sayı olmalıdır.')
        .positive('Dosya boyutu pozitif olmalıdır.')
        .max(ObjectStorageService_1.MAX_UPLOAD_BYTES, 'Dosya boyutu 15 MB sınırını aşamaz.'),
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
router.post('/presign', AuthMiddleware_1.requireAuth, (0, ValidationMiddleware_1.validate)({ body: presignSchema }), (req, res) => fileController.presign(req, res));
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
router.post('/upload-image', AuthMiddleware_1.requireAuth, imageUpload.single('file'), (req, res) => fileController.uploadImage(req, res));
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
router.get('/config', AuthMiddleware_1.requireAuth, (req, res) => fileController.config(req, res));
exports.default = router;
//# sourceMappingURL=files.routes.js.map