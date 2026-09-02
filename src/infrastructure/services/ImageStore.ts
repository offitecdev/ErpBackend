import path from 'path';

import { DocumentStorage } from './LocalFileStorage';

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

export function isDataUri(value: unknown): value is string {
    return typeof value === 'string' && DATA_URI_PATTERN.test(value);
}

/** Zeigt der Wert in eine Ablage (Platte oder R2)? */
export function isStoredReference(value: unknown): value is string {
    return typeof value === 'string' && (value.startsWith('r2:') || value.startsWith('local:'));
}

/**
 * Bilder duerfen die oeffentliche Adresse benutzen, sofern eine Domain am
 * Eimer haengt (OFFITEC_S3_PUBLIC_BASE_URL). Sie haengen dauerhaft am
 * Bildschirm — eine feste Adresse laesst sich zwischenspeichern, eine
 * presignte nicht. Unterlagen tun das ausdruecklich NICHT.
 */
const storageFor = (kind: string, directory: string) => new DocumentStorage({
    prefix: `local:${kind}/`,
    directory: process.env[`OFFITEC_${directory.toUpperCase().replace(/-/g, '_')}_DIR`]
        || path.join(process.cwd(), 'storage', directory),
    preferPublicUrl: true,
});

/** Bilder an einer Angebotszeile (die schwerste Spalte, 60 MB). */
export const positionImageStorage = storageFor('position-image', 'position-images');
/** Fotos an einem Rapport: Montage, Gesamtrapport, Lieferschein. */
export const reportImageStorage = storageFor('report-image', 'report-images');
/** Bilder hinter dem Schlusstext eines Angebots. */
export const closingImageStorage = storageFor('closing-image', 'closing-images');
/** Produktbilder. */
export const articleImageStorage = storageFor('article-image', 'article-images');
/** Unterschriften (Kunde und Techniker). */
export const signatureStorage = storageFor('signature', 'signatures');

/**
 * Daten-URI -> Verweis. Alles andere kommt unveraendert zurueck: ein bereits
 * abgelegter Verweis, eine fremde http-Adresse, null.
 */
export async function storeIfDataUri(
    storage: DocumentStorage,
    tenantId: string,
    value: string | null | undefined,
): Promise<string | null> {
    if (value === null || value === undefined) return null;
    if (!isDataUri(value)) return value;

    const match = DATA_URI_PATTERN.exec(value);
    const contentType = (match?.[1] || 'image/jpeg').toLowerCase();
    const payload = value.slice(value.indexOf(',') + 1);
    const body = Buffer.from(payload, 'base64');

    if (body.length === 0) return null;
    // Nimmt diese Ablage die Art nicht an (exotisches Format), bleibt das Bild
    // wo es war — lieber eine Daten-URI zu viel als ein verlorenes Foto.
    if (!storage.accepts(contentType)) return value;

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
export async function resolveForClient(
    storage: DocumentStorage,
    value: string | null | undefined,
    options: { contentType?: string } = {},
): Promise<string | null> {
    if (!value) return null;
    if (!isStoredReference(value)) return value;

    if (storage.isRemoteReference(value)) {
        return storage.displayUrl(value, options);
    }

    try {
        const body = await storage.read(value);
        const extension = path.extname(value).slice(1).toLowerCase();
        const contentType = extension === 'png' ? 'image/png'
            : extension === 'webp' ? 'image/webp'
                : extension === 'gif' ? 'image/gif'
                    : 'image/jpeg';
        return `data:${contentType};base64,${body.toString('base64')}`;
    } catch {
        // Die Datei fehlt. Kein Grund, die ganze Seite scheitern zu lassen —
        // das Bild bleibt leer, der Rest des Angebots kommt an.
        return null;
    }
}

/** Mehrere auf einmal, ohne die Reihenfolge zu verlieren. */
export async function resolveManyForClient(
    storage: DocumentStorage,
    values: Array<string | null | undefined>,
): Promise<Array<string | null>> {
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
export async function valueForWrite(
    storage: DocumentStorage,
    tenantId: string,
    incoming: string | null | undefined,
): Promise<string | null | undefined> {
    if (incoming === null) return null;
    if (incoming === undefined) return undefined;
    if (isDataUri(incoming)) return storeIfDataUri(storage, tenantId, incoming);
    if (isStoredReference(incoming)) return incoming;
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
export const storeArticleImage = (
    tenantId: string,
    value: string | null | undefined,
): Promise<string | null> => storeIfDataUri(articleImageStorage, tenantId, value);

/** Verweis -> Adresse fuer <img src>. Alte Daten-URIs bleiben, wie sie sind. */
export const resolveArticleImage = (
    value: string | null | undefined,
): Promise<string | null> => resolveForClient(articleImageStorage, value);

/**
 * NUR die feste Adresse — ein Verweis wird zur https-Adresse, alles andere
 * (eine alte Daten-URI, ein Verweis auf die Platte) ergibt `null`.
 *
 * Das ist der Unterschied zu `resolveArticleImage`: hier darf das Ergebnis
 * NICHT megabyteschwer werden, weil es in einer Antwort steckt, die auch
 * ohne Bild schnell sein muss (die Produktdetailseite). Wer `null` bekommt,
 * holt das Bild weiter ueber den Binaerausgang.
 */
export async function articleImageAddress(
    value: string | null | undefined,
): Promise<string | null> {
    if (!value || !isStoredReference(value)) return null;
    if (!articleImageStorage.isRemoteReference(value)) return null;
    return articleImageStorage.displayUrl(value);
}

/**
 * Zeilen an Ort und Stelle aufloesen. `select` zeigt auf das Objekt, das die
 * Spalte traegt — die Zeile selbst, oder das eingebettete `article`.
 */
export async function resolveArticleImagesInPlace(
    rows: any[],
    select: (row: any) => any = (row) => row,
): Promise<void> {
    await Promise.all((rows || []).map(async (row) => {
        const target = select(row);
        if (!target || typeof target !== 'object') return;
        if (target.imageUrl === undefined) return;
        target.imageUrl = await resolveArticleImage(target.imageUrl);
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
export async function forgetArticleImage(
    previous: string | null | undefined,
    next: string | null | undefined,
): Promise<void> {
    if (!previous || previous === next) return;
    if (!isStoredReference(previous)) return;
    if (!articleImageStorage.isManagedReference(previous)) return;
    try {
        await articleImageStorage.remove(previous);
    } catch {
        /* verwaist statt verloren */
    }
}
