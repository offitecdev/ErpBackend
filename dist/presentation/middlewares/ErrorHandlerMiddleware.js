"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.globalErrorHandler = void 0;
const zod_1 = require("zod");
/**
 * Global error handler — the last middleware in the chain. Everything that
 * reaches it is logged in full on the server (stack included) and answered
 * with a sanitized, stable JSON shape. Stack traces, Prisma internals and
 * driver messages are never sent to the client.
 */
const globalErrorHandler = (err, _req, res, next) => {
    if (res.headersSent) {
        next(err);
        return;
    }
    // Zod schemas parsed outside the validation middleware (controllers,
    // use cases) still produce clean 400s with field-level messages.
    if (err instanceof zod_1.ZodError) {
        res.status(400).json({
            error: 'Doğrulama hatası: gönderilen veriler geçersiz.',
            details: err.issues.map((issue) => ({
                field: issue.path.join('.') || '(root)',
                message: issue.message,
            })),
        });
        return;
    }
    // Malformed JSON body (express.json parse failure).
    if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
        res.status(400).json({ error: 'Geçersiz JSON gövdesi.' });
        return;
    }
    // Body exceeding the configured size limit.
    if (err?.type === 'entity.too.large') {
        res.status(413).json({ error: 'İstek gövdesi çok büyük.' });
        return;
    }
    // Multer upload errors (file too large, unexpected field...).
    if (err?.name === 'MulterError') {
        if (err.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ error: 'Dosya 15 MB sınırını aşıyor.' });
            return;
        }
        res.status(400).json({ error: 'Dosya yükleme isteği geçersiz.' });
        return;
    }
    // CORS rejections raised by the cors middleware.
    if (err instanceof Error && err.message.startsWith('CORS:')) {
        res.status(403).json({ error: 'Bu kaynağa bu adresten erişilemez.' });
        return;
    }
    // Everything else: full details stay on the server, the client gets a
    // generic message — no stack, no error class, no internals.
    console.error('[GlobalErrorHandler]', err?.stack || err);
    res.status(500).json({ error: 'Sunucu hatası. Lütfen daha sonra tekrar deneyin.' });
};
exports.globalErrorHandler = globalErrorHandler;
//# sourceMappingURL=ErrorHandlerMiddleware.js.map