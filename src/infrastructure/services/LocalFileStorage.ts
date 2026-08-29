import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

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

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/heic': 'heic',
};

export class LocalFileStorage {
    private readonly root: string;
    private readonly prefix: string;
    private readonly extensions: Record<string, string>;

    /**
     * `extraTypes` erweitert die erlaubten Dateiarten NUR für diese eine
     * Ablage. Die Liste ist bewusst nicht global: eine Personalakte nimmt ein
     * Word-Dokument (so kommen Arbeitsverträge aus der Kanzlei), ein
     * Angebotsanhang soll es weiterhin nicht.
     */
    constructor(options: { prefix: string; directory: string; extraTypes?: Record<string, string> }) {
        this.prefix = options.prefix;
        this.root = path.resolve(options.directory);
        this.extensions = { ...EXTENSION_BY_CONTENT_TYPE, ...(options.extraTypes ?? {}) };
    }

    /** Nimmt diese Ablage die Dateiart an? (Die Prüfung VOR dem Schreiben.) */
    accepts(contentType: string): boolean {
        return Boolean(this.extensions[contentType]);
    }

    async store(tenantId: string, body: Buffer, contentType: string): Promise<string> {
        const extension = this.extensions[contentType];
        if (!extension) throw new Error('Desteklenmeyen dosya türü.');

        const safeTenantId = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const month = new Date().toISOString().slice(0, 7);
        const relativePath = path.join(safeTenantId, month, `${crypto.randomUUID()}.${extension}`);
        const absolutePath = this.resolveLocalPath(relativePath);

        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, body, { flag: 'wx' });

        return `${this.prefix}${relativePath.split(path.sep).join('/')}`;
    }

    isManagedReference(reference: string): boolean {
        return String(reference || '').startsWith(this.prefix);
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
        return reference.slice(this.prefix.length).replace(/\//g, path.sep);
    }

    private resolveLocalPath(relativePath: string): string {
        const absolutePath = path.resolve(this.root, relativePath);
        if (!absolutePath.startsWith(`${this.root}${path.sep}`)) {
            throw new Error('Geçersiz dosya yolu.');
        }
        return absolutePath;
    }
}

/**
 * TERMINUNTERLAGEN (24.08.2026): Begleitzettel, Pläne und Fotos, die an einem
 * Einsatz hängen. Sie gehen an keinen Kunden — sie stehen im Programm und auf
 * dem Bildschirm der Monteurin.
 */
export const appointmentDocumentStorage = new LocalFileStorage({
    prefix: 'local:appointment-document/',
    directory: process.env.OFFITEC_APPOINTMENT_UPLOAD_DIR
        || path.join(process.cwd(), 'storage', 'appointment-documents'),
});

/**
 * OSP-DATENBLATT (07.09.2026): das PDF der angefragten Einheit, wie es die OSP
 * ausliefert. Es wird EINMAL geholt und liegt danach bei uns — die Adresse
 * drüben kann ablaufen, das Datenblatt der Offerte darf das nicht.
 */
export const ospDatasheetStorage = new LocalFileStorage({
    prefix: 'local:osp-datasheet/',
    directory: process.env.OFFITEC_OSP_DATASHEET_DIR
        || path.join(process.cwd(), 'storage', 'osp-datasheets'),
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
export const taskDocumentStorage = new LocalFileStorage({
    prefix: 'local:crm-task-document/',
    directory: process.env.OFFITEC_TASK_UPLOAD_DIR
        || path.join(process.cwd(), 'storage', 'task-documents'),
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
export const staffDocumentStorage = new LocalFileStorage({
    prefix: 'local:staff-document/',
    directory: process.env.OFFITEC_STAFF_UPLOAD_DIR
        || path.join(process.cwd(), 'storage', 'staff-documents'),
    extraTypes: {
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-excel': 'xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'application/vnd.oasis.opendocument.text': 'odt',
        'text/plain': 'txt',
    },
});
