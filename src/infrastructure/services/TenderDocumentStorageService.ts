import path from 'path';

import { DocumentStorage } from './LocalFileStorage';

/**
 * Keeps attachment bytes out of MariaDB. The database stores only an opaque,
 * short reference while the binary is written to a persistent local volume.
 *
 * Die Mechanik selbst steht seit 24.08.2026 in `LocalFileStorage` — sie wird
 * inzwischen auch von den Terminunterlagen gebraucht. Der Verweis-Vorsatz
 * `local:tender-document/` bleibt unverändert: er steht so in jeder Zeile, die
 * es schon gibt.
 */
export const tenderDocumentStorageService = new DocumentStorage({
    prefix: 'local:tender-document/',
    directory: process.env.OFFITEC_TENDER_UPLOAD_DIR
        || path.join(process.cwd(), 'storage', 'tender-documents'),
});
