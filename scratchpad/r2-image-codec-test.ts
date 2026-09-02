import 'dotenv/config';

import {
    positionImageStorage,
    storeIfDataUri,
    resolveForClient,
    valueForWrite,
    isDataUri,
    isStoredReference,
} from '../src/infrastructure/services/ImageStore';
import { objectStorageService } from '../src/infrastructure/services/ObjectStorageService';

/**
 * Der Bild-Codec, ohne Datenbank und ohne HTTP.
 *
 * Der wichtigste Fall steht unten: die zurueckgeschickte Adresse darf den
 * Verweis NICHT ueberschreiben. Genau daran verliert man sonst beim zweiten
 * Speichern alle Bilder — und zwar still.
 */
(async () => {
    console.log(objectStorageService.isConfigured()
        ? 'R2 eingerichtet — Bilder gehen nach Cloudflare.\n'
        : 'R2 nicht eingerichtet — Bilder gehen auf die Platte (Rueckfallweg).\n');

    let failures = 0;
    const check = (label: string, ok: boolean, extra = '') => {
        console.log(`${ok ? '  ok  ' : ' FEHL '} ${label}${extra ? ' | ' + extra : ''}`);
        if (!ok) failures += 1;
    };

    // Ein winziges, echtes PNG (1x1, rot).
    const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
    );
    const dataUri = `data:image/png;base64,${pngBytes.toString('base64')}`;

    console.log('--- Ablegen ---');
    check('als Daten-URI erkannt', isDataUri(dataUri));
    const reference = await storeIfDataUri(positionImageStorage, 'probe-tenant', dataUri);
    console.log(`       Verweis: ${reference}`);
    check('Verweis erzeugt', isStoredReference(reference));
    check('die Spalte ist jetzt winzig', (reference || '').length < 120,
        `${(reference || '').length} statt ${dataUri.length} Zeichen`);

    console.log('\n--- Zurueckgeben ---');
    const shown = await resolveForClient(positionImageStorage, reference);
    const isUrl = Boolean(shown && shown.startsWith('http'));
    const isData = Boolean(shown && shown.startsWith('data:image/'));
    check('etwas Anzeigbares zurueck', isUrl || isData, isUrl ? 'presignte Adresse' : 'Daten-URI');
    if (isData) {
        const back = Buffer.from(String(shown).slice(String(shown).indexOf(',') + 1), 'base64');
        check('Bytes unveraendert', back.equals(pngBytes));
    }

    console.log('\n--- Alte Zeilen (noch nicht umgezogen) ---');
    const untouched = await resolveForClient(positionImageStorage, dataUri);
    check('Daten-URI kommt unveraendert durch', untouched === dataUri);

    console.log('\n--- Der gefaehrliche Fall: der Browser schickt zurueck ---');
    const echoedUrl = 'https://abc.r2.cloudflarestorage.com/position-image/x.png?X-Amz-Signature=deadbeef';
    check('presignte Adresse wird NICHT geschrieben',
        (await valueForWrite(positionImageStorage, 'probe-tenant', echoedUrl)) === undefined);
    check('neue Daten-URI wird abgelegt und ersetzt die Spalte',
        (await valueForWrite(positionImageStorage, 'probe-tenant', dataUri)) !== undefined);
    check('Verweis bleibt Verweis',
        (await valueForWrite(positionImageStorage, 'probe-tenant', reference)) === reference);
    check('null loescht ausdruecklich',
        (await valueForWrite(positionImageStorage, 'probe-tenant', null)) === null);
    check('undefined laesst die Spalte in Ruhe',
        (await valueForWrite(positionImageStorage, 'probe-tenant', undefined)) === undefined);
    check('leere Zeichenkette loescht NICHT',
        (await valueForWrite(positionImageStorage, 'probe-tenant', '')) === undefined);

    console.log('\n--- Fehlende Datei bricht nicht die Seite ---');
    const ghost = await resolveForClient(positionImageStorage, 'local:position-image/x/2026-09/fehlt.png');
    check('fehlendes Bild -> null statt Absturz', ghost === null);

    if (reference) await positionImageStorage.remove(reference).catch(() => undefined);

    console.log('');
    console.log(failures === 0 ? 'ALLES GRUEN' : `${failures} FEHLER`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });
