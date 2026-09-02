"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveArticleImage = exports.storeArticleImage = exports.signatureStorage = exports.articleImageStorage = exports.closingImageStorage = exports.reportImageStorage = exports.positionImageStorage = void 0;
exports.isDataUri = isDataUri;
exports.isStoredReference = isStoredReference;
exports.storeIfDataUri = storeIfDataUri;
exports.resolveForClient = resolveForClient;
exports.resolveManyForClient = resolveManyForClient;
exports.valueForWrite = valueForWrite;
exports.articleImageAddress = articleImageAddress;
exports.resolveArticleImagesInPlace = resolveArticleImagesInPlace;
exports.forgetArticleImage = forgetArticleImage;
const path_1 = __importDefault(require("path"));
const LocalFileStorage_1 = require("./LocalFileStorage");
/**
 * BILDER GEHOEREN NICHT IN DIE DATENBANK.
 *
 * Historisch standen sie als Daten-URI ("data:image/jpeg;base64,...") direkt in
 * einer LONGTEXT-Spalte. Ein Bild wird dadurch um ein Drittel groesser, jede
 * Abfrage, die die Spalte anfasst, zieht Megabytes durch die Leitung, und die
 * Sicherung der Datenbank waechst mit jedem Foto. Am 01.09.2026 lagen so
 * 87 MB in der Datenbank — allein `Position.imageUrl` trug 60 MB in 58 Zeilen.
 *
 * Ab jetzt haelt die Spalte nur noch einen Verweis, die Bytes liegen in R2.
 *
 * ZWEI REGELN, die den Umstieg gefahrlos machen:
 *
 * 1. LESEN loest auf. Ein Verweis wird zu einer Adresse, die der Browser in
 *    <img src> stecken kann. Eine alte Zeile, in der noch eine Daten-URI
 *    steht, kommt unveraendert zurueck — beide funktionieren nebeneinander,
 *    es gibt keinen Stichtag.
 *
 * 2. SCHREIBEN nimmt nur frische Daten-URIs an. Das ist die wichtige Regel:
 *    der Browser bekommt beim Lesen eine Adresse, und beim naechsten Speichern
 *    schickt er sie arglos zurueck. Wuerde sie geschrieben, stuende in der
 *    Spalte eine Adresse, die nach 15 Minuten ins Leere zeigt — der Verweis
 *    auf die echte Datei waere weg. Darum laesst `valueForWrite()` alles
 *    liegen, was keine neue Daten-URI ist. Ein Bild wird ausdruecklich mit
 *    `null` entfernt, nie mit einer leeren Zeichenkette.
 */
/** "data:image/jpeg;base64,..." — nur Bilder, nur base64. */
const DATA_URI_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,/i;
function isDataUri(value) {
    return typeof value === 'string' && DATA_URI_PATTERN.test(value);
}
/** Zeigt der Wert in eine Ablage (Platte oder R2)? */
function isStoredReference(value) {
    return typeof value === 'string' && (value.startsWith('r2:') || value.startsWith('local:'));
}
/**
 * Bilder duerfen die oeffentliche Adresse benutzen, sofern eine Domain am
 * Eimer haengt (OFFITEC_S3_PUBLIC_BASE_URL). Sie haengen dauerhaft am
 * Bildschirm — eine feste Adresse laesst sich zwischenspeichern, eine
 * presignte nicht. Unterlagen tun das ausdruecklich NICHT.
 */
const storageFor = (kind, directory) => new LocalFileStorage_1.DocumentStorage({
    prefix: `local:${kind}/`,
    directory: process.env[`OFFITEC_${directory.toUpperCase().replace(/-/g, '_')}_DIR`]
        || path_1.default.join(process.cwd(), 'storage', directory),
    preferPublicUrl: true,
});
/** Bilder an einer Angebotszeile (die schwerste Spalte, 60 MB). */
exports.positionImageStorage = storageFor('position-image', 'position-images');
/** Fotos an einem Rapport: Montage, Gesamtrapport, Lieferschein. */
exports.reportImageStorage = storageFor('report-image', 'report-images');
/** Bilder hinter dem Schlusstext eines Angebots. */
exports.closingImageStorage = storageFor('closing-image', 'closing-images');
/** Produktbilder. */
exports.articleImageStorage = storageFor('article-image', 'article-images');
/** Unterschriften (Kunde und Techniker). */
exports.signatureStorage = storageFor('signature', 'signatures');
/**
 * Daten-URI -> Verweis. Alles andere kommt unveraendert zurueck: ein bereits
 * abgelegter Verweis, eine fremde http-Adresse, null.
 */
async function storeIfDataUri(storage, tenantId, value) {
    if (value === null || value === undefined)
        return null;
    if (!isDataUri(value))
        return value;
    const match = DATA_URI_PATTERN.exec(value);
    const contentType = (match?.[1] || 'image/jpeg').toLowerCase();
    const payload = value.slice(value.indexOf(',') + 1);
    const body = Buffer.from(payload, 'base64');
    if (body.length === 0)
        return null;
    // Nimmt diese Ablage die Art nicht an (exotisches Format), bleibt das Bild
    // wo es war — lieber eine Daten-URI zu viel als ein verlorenes Foto.
    if (!storage.accepts(contentType))
        return value;
    return storage.store(tenantId, body, contentType);
}
/**
 * Verweis -> Adresse fuer den Browser.
 *
 * Liegt die Datei in R2, ist es eine presignte https-Adresse (15 Minuten).
 * Liegt sie auf der Platte — der Rueckfallweg ohne R2-Zugangsdaten —, gibt es
 * keine Adresse; dann werden die Bytes gelesen und als Daten-URI geliefert,
 * also genau das Verhalten von vorher.
 */
async function resolveForClient(storage, value, options = {}) {
    if (!value)
        return null;
    if (!isStoredReference(value))
        return value;
    if (storage.isRemoteReference(value)) {
        return storage.displayUrl(value, options);
    }
    try {
        const body = await storage.read(value);
        const extension = path_1.default.extname(value).slice(1).toLowerCase();
        const contentType = extension === 'png' ? 'image/png'
            : extension === 'webp' ? 'image/webp'
                : extension === 'gif' ? 'image/gif'
                    : 'image/jpeg';
        return `data:${contentType};base64,${body.toString('base64')}`;
    }
    catch {
        // Die Datei fehlt. Kein Grund, die ganze Seite scheitern zu lassen —
        // das Bild bleibt leer, der Rest des Angebots kommt an.
        return null;
    }
}
/** Mehrere auf einmal, ohne die Reihenfolge zu verlieren. */
async function resolveManyForClient(storage, values) {
    return Promise.all(values.map((value) => resolveForClient(storage, value)));
}
/**
 * Was darf beim Speichern in die Spalte?
 *
 * - eine neue Daten-URI -> wird abgelegt, der Verweis kommt zurueck
 * - ausdruecklich `null`  -> das Bild wird entfernt
 * - alles andere          -> `undefined`, die Spalte wird NICHT angefasst
 *
 * Der letzte Fall ist der Schutz gegen die zurueckgeschickte Adresse.
 */
async function valueForWrite(storage, tenantId, incoming) {
    if (incoming === null)
        return null;
    if (incoming === undefined)
        return undefined;
    if (isDataUri(incoming))
        return storeIfDataUri(storage, tenantId, incoming);
    if (isStoredReference(incoming))
        return incoming;
    return undefined;
}
/* ------------------------------------------------------------------ *
 * PRODUKTBILDER (01.09.2026)
 *
 * Ein Produktbild haengt dauerhaft am Bildschirm: in der Artikelliste, im
 * Detail, in der Schnellansicht, an jeder Offertzeile, die das Produkt
 * benutzt. Genau dafuer ist die feste Adresse am Eimer gedacht — dieselbe,
 * die die Terminunterlagen im Kalender schon benutzen
 * (`https://assets.demo.offitec.ch/article-image/...`, R2_PUBLIC_URL):
 *
 *  • sie laeuft nicht ab, der Browser darf sie zwischenspeichern,
 *  • 134 Produktbilder einzeln zu presignen waeren 134 Unterschriften fuer
 *    nichts,
 *  • und die Spalte bleibt ein Verweis (`r2:`), damit ein Domainwechsel nur
 *    die Umgebungsvariable kostet und keine Datenbankzeile.
 *
 * ZWEI FUNKTIONEN, mehr braucht keine Aufrufstelle: `storeArticleImage` beim
 * Schreiben, `resolveArticleImage` beim Lesen.
 * ------------------------------------------------------------------ */
/** Neue Daten-URI -> `r2:`-Verweis. Alles andere kommt unveraendert zurueck. */
const storeArticleImage = (tenantId, value) => storeIfDataUri(exports.articleImageStorage, tenantId, value);
exports.storeArticleImage = storeArticleImage;
/** Verweis -> Adresse fuer <img src>. Alte Daten-URIs bleiben, wie sie sind. */
const resolveArticleImage = (value) => resolveForClient(exports.articleImageStorage, value);
exports.resolveArticleImage = resolveArticleImage;
/**
 * NUR die feste Adresse — ein Verweis wird zur https-Adresse, alles andere
 * (eine alte Daten-URI, ein Verweis auf die Platte) ergibt `null`.
 *
 * Das ist der Unterschied zu `resolveArticleImage`: hier darf das Ergebnis
 * NICHT megabyteschwer werden, weil es in einer Antwort steckt, die auch
 * ohne Bild schnell sein muss (die Produktdetailseite). Wer `null` bekommt,
 * holt das Bild weiter ueber den Binaerausgang.
 */
async function articleImageAddress(value) {
    if (!value || !isStoredReference(value))
        return null;
    if (!exports.articleImageStorage.isRemoteReference(value))
        return null;
    return exports.articleImageStorage.displayUrl(value);
}
/**
 * Zeilen an Ort und Stelle aufloesen. `select` zeigt auf das Objekt, das die
 * Spalte traegt — die Zeile selbst, oder das eingebettete `article`.
 */
async function resolveArticleImagesInPlace(rows, select = (row) => row) {
    await Promise.all((rows || []).map(async (row) => {
        const target = select(row);
        if (!target || typeof target !== 'object')
            return;
        if (target.imageUrl === undefined)
            return;
        target.imageUrl = await (0, exports.resolveArticleImage)(target.imageUrl);
    }));
}
/**
 * DAS ERSETZTE BILD AUFRAEUMEN.
 *
 * Ein Produktbild gehoert genau EINEM Artikel — wird es ersetzt oder
 * entfernt, hat die alte Datei keinen Leser mehr und wuerde sonst fuer immer
 * im Eimer liegen bleiben. Aufgeraeumt wird erst NACH dem Schreiben: waere es
 * davor, koennte ein fehlgeschlagenes UPDATE eine Zeile hinterlassen, die auf
 * eine geloeschte Datei zeigt.
 *
 * Ein Fehler beim Loeschen bleibt still. Eine verwaiste Datei kostet ein paar
 * Kilobyte; ein abgebrochener Speichervorgang kostet die Arbeit der Benutzerin.
 */
async function forgetArticleImage(previous, next) {
    if (!previous || previous === next)
        return;
    if (!isStoredReference(previous))
        return;
    if (!exports.articleImageStorage.isManagedReference(previous))
        return;
    try {
        await exports.articleImageStorage.remove(previous);
    }
    catch {
        /* verwaist statt verloren */
    }
}
//# sourceMappingURL=ImageStore.js.map