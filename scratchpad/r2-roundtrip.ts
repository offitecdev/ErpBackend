import 'dotenv/config';

import { objectStorageService } from '../src/infrastructure/services/ObjectStorageService';
import { staffDocumentStorage } from '../src/infrastructure/services/LocalFileStorage';
import { tenderDocumentStorageService } from '../src/infrastructure/services/TenderDocumentStorageService';

/**
 * DER GANZE WEG EINER DATEI, OHNE HTTP.
 *
 * Ablegen -> Verweis -> zurueklesen -> presignte Adresse -> loeschen.
 *
 * Das Skript laeuft in BEIDEN Zustaenden und sagt selbst, in welchem es war:
 * ohne R2-Zugangsdaten schreibt die Ablage auf die Platte (der Verweis beginnt
 * mit "local:"), mit ihnen nach Cloudflare ("r2:"). Beide Male muessen die
 * Bytes unveraendert zurueckkommen — das ist der eigentliche Prueffall.
 */
(async () => {
    const configured = objectStorageService.isConfigured();
    console.log(configured
        ? 'R2 ist eingerichtet — geschrieben wird nach Cloudflare.'
        : 'R2 ist NICHT eingerichtet — geschrieben wird auf die Platte (Rueckfallweg).');
    console.log('');

    const pdf = Buffer.from(`%PDF-1.4\n% offitec r2 probe ${new Date().toISOString()}\n`);
    let failures = 0;
    const check = (label: string, ok: boolean, extra = '') => {
        console.log(`${ok ? '  ok  ' : ' FEHL '} ${label}${extra ? ' | ' + extra : ''}`);
        if (!ok) failures += 1;
    };

    for (const [name, storage] of [
        ['Angebotsanhang', tenderDocumentStorageService],
        ['Personalakte', staffDocumentStorage],
    ] as const) {
        console.log(`--- ${name} ---`);

        const reference = await storage.store('probe-tenant', pdf, 'application/pdf');
        console.log(`       Verweis: ${reference}`);
        check('Verweis gehoert dieser Ablage', storage.isManagedReference(reference));
        check(
            configured ? 'liegt in R2' : 'liegt auf der Platte',
            configured ? storage.isRemoteReference(reference) : storage.isLocalReference(reference),
        );

        const back = await storage.read(reference);
        check('unveraendert zurueckgelesen', back.equals(pdf), `${back.length} Byte`);

        const url = await storage.presignRead(reference, { downloadName: 'Vertrag.pdf' });
        if (configured) {
            check('presignte Adresse ausgestellt', Boolean(url && url.startsWith('http')));
            if (url) {
                // Die Adresse muss OHNE Anmeldung ziehen — genau das ist ihr Sinn.
                const response = await fetch(url);
                const bytes = Buffer.from(await response.arrayBuffer());
                check('Adresse liefert dieselben Bytes', response.ok && bytes.equals(pdf), `HTTP ${response.status}`);
                check(
                    'Dateiname im Kopf gesetzt',
                    (response.headers.get('content-disposition') || '').includes('Vertrag.pdf'),
                    response.headers.get('content-disposition') || '(keiner)',
                );
            }
        } else {
            check('keine Adresse fuer Plattendateien', url === null);
        }

        await storage.remove(reference);
        const gone = await storage.read(reference).then(() => false).catch(() => true);
        check('nach dem Loeschen weg', gone);
        console.log('');
    }

    // Fremde Verweise duerfen nie durchgehen.
    console.log('--- Abwehr ---');
    for (const bad of ['r2:../../etc/passwd', 'local:other-kind/x/y.pdf', 'https://example.com/x.pdf', '']) {
        check(`abgelehnt: ${bad || '(leer)'}`, !tenderDocumentStorageService.isManagedReference(bad));
    }

    console.log('');
    console.log(failures === 0 ? 'ALLES GRUEN' : `${failures} FEHLER`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((error) => { console.error(error); process.exit(1); });
