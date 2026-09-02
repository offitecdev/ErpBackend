"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.staffDocumentStorage = exports.taskDocumentStorage = exports.ospDatasheetStorage = exports.appointmentDocumentStorage = exports.DocumentStorage = exports.LocalFileStorage = void 0;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const ObjectStorageService_1 = require("./ObjectStorageService");
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
 * DIESELBE ABLAGE, ZWEI ORTE.
 *
 * Bis zum R2-Umzug lagen die Bytes auf der Platte des Servers. Das hat einen
 * harten Boden: die Platte ist so gross wie sie ist, sie gehoert genau einem
 * Rechner, und ein Umzug des Servers nimmt sie nicht mit. Cloudflare R2 hat
 * diesen Boden nicht.
 *
 * Der Umstieg passiert aber nicht an einem Tag. Darum entscheidet der Verweis
 * selbst, wo seine Bytes liegen — nicht eine Einstellung:
 *
 *   local:tender-document/<mandant>/<jjjj-mm>/<uuid>.pdf   -> Platte
 *   r2:tender-document/<mandant>/<jjjj-mm>/<uuid>.pdf      -> R2
 *
 * Der Pfad dahinter ist in beiden Faellen derselbe. Der Umzug ist deshalb ein
 * Wechsel des Vorsatzes und sonst nichts, und eine Zeile, die noch auf die
 * Platte zeigt, wird von der neuen Ablage weiterhin gelesen. Es gibt keinen
 * Stichtag, an dem etwas kippt.
 *
 * Ist R2 nicht eingerichtet (Entwicklungsrechner ohne Zugangsdaten), schreibt
 * die Ablage weiter auf die Platte. Fehlende Zugangsdaten duerfen das Programm
 * nicht anhalten.
 */
class DocumentStorage {
    local;
    /** Der Ordner in R2: "tender-document", "staff-document", ... */
    kind;
    localPrefix;
    remotePrefix;
    extensions;
    /**
     * Darf diese Ablage die oeffentliche Adresse benutzen? Nur Bilder, die
     * ohnehin am Bildschirm haengen — nie Unterlagen. Siehe
     * ObjectStorageService.publicUrl().
     */
    preferPublicUrl;
    constructor(options) {
        this.local = new LocalFileStorage(options);
        this.localPrefix = options.prefix;
        this.preferPublicUrl = options.preferPublicUrl ?? false;
        this.kind = options.prefix.replace(/^local:/, '').replace(/\/$/, '');
        this.remotePrefix = `r2:${this.kind}/`;
        this.extensions = { ...EXTENSION_BY_CONTENT_TYPE, ...(options.extraTypes ?? {}) };
    }
    /** Nimmt diese Ablage die Dateiart an? (Die Pruefung VOR dem Schreiben.) */
    accepts(contentType) {
        return Boolean(this.extensions[contentType]);
    }
    /**
     * Neue Dateien gehen nach R2, sobald es eingerichtet ist. Der Schluessel
     * wird HIER gebaut: Ordner, Mandant, Monat, UUID, Endung aus der weissen
     * Liste. Der Dateiname des Browsers spielt nie mit — damit sind "../.."
     * und Namenskollisionen bauartbedingt unmoeglich.
     */
    async store(tenantId, body, contentType) {
        const extension = this.extensions[contentType];
        if (!extension)
            throw new Error('Desteklenmeyen dosya türü.');
        if (!ObjectStorageService_1.objectStorageService.isConfigured()) {
            return this.local.store(tenantId, body, contentType);
        }
        const safeTenantId = String(tenantId).replace(/[^a-zA-Z0-9_-]/g, '_');
        const month = new Date().toISOString().slice(0, 7);
        const key = `${this.kind}/${safeTenantId}/${month}/${crypto_1.default.randomUUID()}.${extension}`;
        await ObjectStorageService_1.objectStorageService.putObject(key, body, contentType);
        return `r2:${key}`;
    }
    /** Gehoert dieser Verweis dieser Ablage? (Platte ODER R2.) */
    isManagedReference(reference) {
        const value = String(reference || '');
        return value.startsWith(this.localPrefix)
            || value.startsWith(this.remotePrefix)
            || this.isPublicReference(value);
    }
    /** Liegt er in R2? */
    isRemoteReference(reference) {
        const value = String(reference || '');
        return value.startsWith(this.remotePrefix) || this.isPublicReference(value);
    }
    /** Ist das bereits die feste Browser-Adresse dieses Ablageordners? */
    isPublicReference(reference) {
        const key = ObjectStorageService_1.objectStorageService.objectKeyFromPublicUrl(String(reference || ''));
        return Boolean(key && key.startsWith(`${this.kind}/`));
    }
    /** Liegt er noch auf der Platte? (Der Umzug sucht genau diese.) */
    isLocalReference(reference) {
        return String(reference || '').startsWith(this.localPrefix);
    }
    /**
     * Der Zwilling eines Plattenverweises in R2. Nur der Vorsatz wechselt —
     * darum ist der Umzug hinterher Zeile fuer Zeile nachpruefbar.
     */
    remoteReferenceFor(localReference) {
        if (!this.isLocalReference(localReference))
            throw new Error('Geçersiz dosya referansı.');
        return `${this.remotePrefix}${localReference.slice(this.localPrefix.length)}`;
    }
    async read(reference) {
        if (this.isRemoteReference(reference)) {
            return ObjectStorageService_1.objectStorageService.getObject(this.objectKey(reference));
        }
        return this.local.read(reference);
    }
    /**
     * Der Leseweg fuer den Browser: eine kurz gueltige Adresse direkt zu
     * Cloudflare. Liegt die Datei noch auf der Platte, gibt es keine — dann
     * liefert der Server die Bytes wie bisher selbst aus.
     */
    async presignRead(reference, options = {}) {
        if (!this.isRemoteReference(reference))
            return null;
        /* AUCH EINE OEFFENTLICHE ADRESSE WIRD HIER UNTERSCHRIEBEN (01.09.2026).
           Sie stand frueher unveraendert zurueck — «sie zeigt ja schon auf die
           Datei». Das war der Fehler: welcher Name gespeichert ist, sagt
           nichts darueber, welcher Name beim Browser ankommt. Der Schluessel
           wird darum aus dem Verweis zurueckgerechnet (objectKey) und frisch
           unterschrieben. Wer stattdessen die feste Adresse ausliefern will,
           setzt `preferPublicUrl` — die Wahl faellt in displayUrl(). */
        return ObjectStorageService_1.objectStorageService.presignGet(this.objectKey(reference), options);
    }
    /** Kalici, veritabanina yazilabilir public URL. */
    publicReadUrl(reference) {
        if (this.isPublicReference(reference))
            return String(reference);
        if (!String(reference || '').startsWith(this.remotePrefix))
            return null;
        return ObjectStorageService_1.objectStorageService.publicUrl(this.objectKey(reference));
    }
    /**
     * Die Adresse, die der Browser anzeigen soll.
     *
     * Ablagen mit `preferPublicUrl` bekommen bei gesetzter Domain die feste,
     * zwischenspeicherbare Adresse — die Bilder und die Terminunterlagen;
     * alles andere eine presignte, die ablaeuft. Ohne Domain presignt auch
     * die erste Gruppe: die Wahl faellt hier, nicht an der Aufrufstelle.
     */
    async displayUrl(reference, options = {}) {
        if (!this.isRemoteReference(reference))
            return null;
        if (this.preferPublicUrl) {
            const publicAddress = ObjectStorageService_1.objectStorageService.publicUrl(this.objectKey(reference));
            if (publicAddress)
                return publicAddress;
        }
        return this.presignRead(reference, options);
    }
    async remove(reference) {
        if (this.isRemoteReference(reference)) {
            await ObjectStorageService_1.objectStorageService.deleteObject(this.objectKey(reference));
            return;
        }
        await this.local.remove(reference);
    }
    /** "r2:staff-document/t/2026-09/x.pdf" -> "staff-document/t/2026-09/x.pdf" */
    objectKey(reference) {
        const publicKey = ObjectStorageService_1.objectStorageService.objectKeyFromPublicUrl(String(reference || ''));
        if (publicKey && publicKey.startsWith(`${this.kind}/`))
            return publicKey;
        if (!this.isRemoteReference(reference))
            throw new Error('Geçersiz dosya referansı.');
        return String(reference).slice('r2:'.length);
    }
}
exports.DocumentStorage = DocumentStorage;
/**
 * TERMINUNTERLAGEN (24.08.2026): Begleitzettel, Pläne und Fotos, die an einem
 * Einsatz hängen. Sie gehen an keinen Kunden — sie stehen im Programm und auf
 * dem Bildschirm der Monteurin.
 *
 * DIE EIGENE DOMAIN STATT DES S3-ENDPUNKTS (01.09.2026). Die Vorschau blieb
 * zweimal weiss: erst mit `pub-*.r2.dev`, dann mit der presignten Adresse auf
 * `*.r2.cloudflarestorage.com` — beide Namen kommen im Netz der Benutzerin
 * nicht an. Erreichbar ist die eigene Domain am Eimer
 * (`assets.demo.offitec.ch`), und ein `<img>`/`<iframe>` braucht ohnehin nur
 * eine schlichte Adresse. Der Preis steht in publicUrl(): sie läuft nicht ab,
 * wer sie hat, liest die Datei. Ohne gesetzte Domain presigniert displayUrl()
 * weiter wie bisher.
 */
exports.appointmentDocumentStorage = new DocumentStorage({
    prefix: 'local:appointment-document/',
    directory: process.env.OFFITEC_APPOINTMENT_UPLOAD_DIR
        || path_1.default.join(process.cwd(), 'storage', 'appointment-documents'),
    preferPublicUrl: true,
});
/**
 * OSP-DATENBLATT (07.09.2026): das PDF der angefragten Einheit, wie es die OSP
 * ausliefert. Es wird EINMAL geholt und liegt danach bei uns — die Adresse
 * drüben kann ablaufen, das Datenblatt der Offerte darf das nicht.
 */
exports.ospDatasheetStorage = new DocumentStorage({
    prefix: 'local:osp-datasheet/',
    directory: process.env.OFFITEC_OSP_DATASHEET_DIR
        || path_1.default.join(process.cwd(), 'storage', 'osp-datasheets'),
});
/**
 * AUFGABEN-ANHÄNGE (11.09.2026, Vorgabe Samet: «beim Anlegen dieser kleinen
 * Zeichen-Knöpfe und ebenso beim Ändern soll man nicht nur PNG, sondern auch
 * PDF anhängen können»).
 *
 * Bild ODER Dokument, an der Aufgabe selbst — nicht an einer Notiz. Die
 * Notizbilder bleiben Daten-URLs: das sind kleine, nachträglich geknipste
 * Belege. Ein Datenblatt oder ein Plan ist keiner, und ein PDF als Base64 in
 * einer JSON-Spalte wäre ein Drittel grösser und müsste zweimal umkodiert
 * werden.
 */
exports.taskDocumentStorage = new DocumentStorage({
    prefix: 'local:crm-task-document/',
    directory: process.env.OFFITEC_TASK_UPLOAD_DIR
        || path_1.default.join(process.cwd(), 'storage', 'task-documents'),
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
exports.staffDocumentStorage = new DocumentStorage({
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