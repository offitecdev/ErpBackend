"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tenderDocumentStorageService = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const LOCAL_REFERENCE_PREFIX = 'local:tender-document/';
const EXTENSION_BY_CONTENT_TYPE = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
};
/**
 * Keeps attachment bytes out of MariaDB. The database stores only an opaque,
 * short reference while the binary is written to a persistent local volume.
 */
class TenderDocumentStorageService {
    root = path_1.default.resolve(process.env.OFFITEC_TENDER_UPLOAD_DIR
        || path_1.default.join(process.cwd(), 'storage', 'tender-documents'));
    async store(tenantId, body, contentType) {
        const extension = EXTENSION_BY_CONTENT_TYPE[contentType];
        if (!extension)
            throw new Error('Desteklenmeyen dosya türü.');
        const safeTenantId = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const month = new Date().toISOString().slice(0, 7);
        const relativePath = path_1.default.join(safeTenantId, month, `${crypto_1.default.randomUUID()}.${extension}`);
        const absolutePath = this.resolveLocalPath(relativePath);
        await fs_1.promises.mkdir(path_1.default.dirname(absolutePath), { recursive: true });
        await fs_1.promises.writeFile(absolutePath, body, { flag: 'wx' });
        return `${LOCAL_REFERENCE_PREFIX}${relativePath.split(path_1.default.sep).join('/')}`;
    }
    isManagedReference(reference) {
        return reference.startsWith(LOCAL_REFERENCE_PREFIX);
    }
    async read(reference) {
        return fs_1.promises.readFile(this.resolveLocalPath(this.getRelativePath(reference)));
    }
    async remove(reference) {
        if (!this.isManagedReference(reference))
            return;
        try {
            await fs_1.promises.unlink(this.resolveLocalPath(this.getRelativePath(reference)));
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                throw error;
        }
    }
    getRelativePath(reference) {
        if (!this.isManagedReference(reference))
            throw new Error('Geçersiz dosya referansı.');
        return reference.slice(LOCAL_REFERENCE_PREFIX.length).replace(/\//g, path_1.default.sep);
    }
    resolveLocalPath(relativePath) {
        const absolutePath = path_1.default.resolve(this.root, relativePath);
        if (!absolutePath.startsWith(`${this.root}${path_1.default.sep}`)) {
            throw new Error('Geçersiz dosya yolu.');
        }
        return absolutePath;
    }
}
exports.tenderDocumentStorageService = new TenderDocumentStorageService();
//# sourceMappingURL=TenderDocumentStorageService.js.map