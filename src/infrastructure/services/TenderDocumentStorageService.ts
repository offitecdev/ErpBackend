import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

const LOCAL_REFERENCE_PREFIX = 'local:tender-document/';

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
};

/**
 * Keeps attachment bytes out of MariaDB. The database stores only an opaque,
 * short reference while the binary is written to a persistent local volume.
 */
class TenderDocumentStorageService {
    private readonly root = path.resolve(
        process.env.OFFITEC_TENDER_UPLOAD_DIR
            || path.join(process.cwd(), 'storage', 'tender-documents'),
    );

    async store(tenantId: string, body: Buffer, contentType: string): Promise<string> {
        const extension = EXTENSION_BY_CONTENT_TYPE[contentType];
        if (!extension) throw new Error('Desteklenmeyen dosya türü.');

        const safeTenantId = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const month = new Date().toISOString().slice(0, 7);
        const relativePath = path.join(safeTenantId, month, `${crypto.randomUUID()}.${extension}`);
        const absolutePath = this.resolveLocalPath(relativePath);

        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, body, { flag: 'wx' });

        return `${LOCAL_REFERENCE_PREFIX}${relativePath.split(path.sep).join('/')}`;
    }

    isManagedReference(reference: string): boolean {
        return reference.startsWith(LOCAL_REFERENCE_PREFIX);
    }

    async read(reference: string): Promise<Buffer> {
        return fs.readFile(this.resolveLocalPath(this.getRelativePath(reference)));
    }

    async remove(reference: string): Promise<void> {
        if (!this.isManagedReference(reference)) return;
        try {
            await fs.unlink(this.resolveLocalPath(this.getRelativePath(reference)));
        } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }

    private getRelativePath(reference: string): string {
        if (!this.isManagedReference(reference)) throw new Error('Geçersiz dosya referansı.');
        return reference.slice(LOCAL_REFERENCE_PREFIX.length).replace(/\//g, path.sep);
    }

    private resolveLocalPath(relativePath: string): string {
        const absolutePath = path.resolve(this.root, relativePath);
        if (!absolutePath.startsWith(`${this.root}${path.sep}`)) {
            throw new Error('Geçersiz dosya yolu.');
        }
        return absolutePath;
    }
}

export const tenderDocumentStorageService = new TenderDocumentStorageService();
