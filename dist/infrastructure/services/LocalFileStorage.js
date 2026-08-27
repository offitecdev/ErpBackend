"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.staffDocumentStorage = exports.ospDatasheetStorage = exports.appointmentDocumentStorage = exports.LocalFileStorage = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
/**
 * ANHÄNGE LIEGEN AUF DER PLATTE, NICHT IN DER DATENBANK.
 *
 * Die Datenbank hält nur einen kurzen, undurchsichtigen Verweis; die Bytes
 * gehen auf einen dauerhaften Datenträger. Das ist der Grund, warum ein Anhang
 * am Angebot SOFORT drin ist: er reist als rohe Datei (multipart), nicht als
 * Base64 in einem JSON-Körper — der wäre ein Drittel grösser und müsste zweimal
 * umkodiert werden — und die Zeile in MariaDB bleibt ein paar Byte statt ein
 * paar Megabyte.
 *
 * Bis 24.08.2026 stand dieses Verhalten NUR für Angebotsanhänge da
 * (TenderDocumentStorageService). Die Terminunterlagen brauchen genau dasselbe,
 * darum ist die Mechanik hier herausgezogen: EINE Klasse, je Anwendungsfall
 * eine Instanz mit eigenem Ordner und eigenem Verweis-Vorsatz. Der Vorsatz der
 * Angebote bleibt unverändert — er steht in bestehenden Zeilen.
 */
const EXTENSION_BY_CONTENT_TYPE = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/heic': 'heic',
};
class LocalFileStorage {
    root;
    prefix;
    extensions;
    /**
     * `extraTypes` erweitert die erlaubten Dateiarten NUR für diese eine
     * Ablage. Die Liste ist bewusst nicht global: eine Personalakte nimmt ein
     * Word-Dokument (so kommen Arbeitsverträge aus der Kanzlei), ein
     * Angebotsanhang soll es weiterhin nicht.
     */
    constructor(options) {
        this.prefix = options.prefix;
        this.root = path_1.default.resolve(options.directory);
        this.extensions = { ...EXTENSION_BY_CONTENT_TYPE, ...(options.extraTypes ?? {}) };
    }
    /** Nimmt diese Ablage die Dateiart an? (Die Prüfung VOR dem Schreiben.) */
    accepts(contentType) {
        return Boolean(this.extensions[contentType]);
    }
    async store(tenantId, body, contentType) {
        const extension = this.extensions[contentType];
        if (!extension)
            throw new Error('Desteklenmeyen dosya türü.');
        const safeTenantId = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const month = new Date().toISOString().slice(0, 7);
        const relativePath = path_1.default.join(safeTenantId, month, `${crypto_1.default.randomUUID()}.${extension}`);
        const absolutePath = this.resolveLocalPath(relativePath);
        await fs_1.promises.mkdir(path_1.default.dirname(absolutePath), { recursive: true });
        await fs_1.promises.writeFile(absolutePath, body, { flag: 'wx' });
        return `${this.prefix}${relativePath.split(path_1.default.sep).join('/')}`;
    }
    isManagedReference(reference) {
        return String(reference || '').startsWith(this.prefix);
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
        return reference.slice(this.prefix.length).replace(/\//g, path_1.default.sep);
    }
    resolveLocalPath(relativePath) {
        const absolutePath = path_1.default.resolve(this.root, relativePath);
        if (!absolutePath.startsWith(`${this.root}${path_1.default.sep}`)) {
            throw new Error('Geçersiz dosya yolu.');
        }
        return absolutePath;
    }
}
exports.LocalFileStorage = LocalFileStorage;
/**
 * TERMINUNTERLAGEN (24.08.2026): Begleitzettel, Pläne und Fotos, die an einem
 * Einsatz hängen. Sie gehen an keinen Kunden — sie stehen im Programm und auf
 * dem Bildschirm der Monteurin.
 */
exports.appointmentDocumentStorage = new LocalFileStorage({
    prefix: 'local:appointment-document/',
    directory: process.env.OFFITEC_APPOINTMENT_UPLOAD_DIR
        || path_1.default.join(process.cwd(), 'storage', 'appointment-documents'),
});
/**
 * OSP-DATENBLATT (07.09.2026): das PDF der angefragten Einheit, wie es die OSP
 * ausliefert. Es wird EINMAL geholt und liegt danach bei uns — die Adresse
 * drüben kann ablaufen, das Datenblatt der Offerte darf das nicht.
 */
exports.ospDatasheetStorage = new LocalFileStorage({
    prefix: 'local:osp-datasheet/',
    directory: process.env.OFFITEC_OSP_DATASHEET_DIR
        || path_1.default.join(process.cwd(), 'storage', 'osp-datasheets'),
});
/**
 * PERSONALAKTE (26.08.2026): der Arbeitsvertrag und die übrigen Unterlagen
 * einer angestellten Person. Sie verlassen das Haus nie — sie werden nur auf
 * der Personenseite geöffnet, und nur von der Person selbst bzw. der
 * Personalverwaltung.
 *
 * Zusätzlich zu PDF und Bild nimmt diese Ablage die Büroformate an: ein
 * Arbeitsvertrag kommt aus der Kanzlei regelmässig als Word-Datei, und ihn
 * vorher durch einen PDF-Drucker zu schicken ist eine Hürde, die niemandem
 * nützt.
 */
exports.staffDocumentStorage = new LocalFileStorage({
    prefix: 'local:staff-document/',
    directory: process.env.OFFITEC_STAFF_UPLOAD_DIR
        || path_1.default.join(process.cwd(), 'storage', 'staff-documents'),
    extraTypes: {
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-excel': 'xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'application/vnd.oasis.opendocument.text': 'odt',
        'text/plain': 'txt',
    },
});
//# sourceMappingURL=LocalFileStorage.js.map