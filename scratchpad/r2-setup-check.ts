import 'dotenv/config';

import { objectStorageService } from '../src/infrastructure/services/ObjectStorageService';

/**
 * IST R2 RICHTIG EINGERICHTET?
 *
 * Erst die Felder, dann die Leitung. Das Skript legt eine winzige Probedatei
 * ab, liest sie zurueck, holt eine presignte Adresse, zieht sie OHNE Anmeldung
 * und raeumt wieder auf. Geht etwas schief, sagt es WELCHES Feld falsch ist —
 * ein "SignatureDoesNotMatch" aus dem SDK hilft niemandem weiter.
 */

const REQUIRED = [
    ['OFFITEC_S3_ENDPOINT', 'https://<account-id>.r2.cloudflarestorage.com'],
    ['OFFITEC_S3_REGION', 'auto'],
    ['OFFITEC_S3_BUCKET', 'der Name des Eimers'],
    ['OFFITEC_S3_ACCESS_KEY_ID', 'R2 -> Manage API Tokens'],
    ['OFFITEC_S3_SECRET_ACCESS_KEY', 'R2 -> Manage API Tokens'],
] as const;

/** Die haeufigen Verwechslungen, jede auf ihr Feld zurueckgefuehrt. */
function explain(error: any): string {
    const name = String(error?.name || '');
    const code = String(error?.Code || error?.code || '');
    const status = error?.$metadata?.httpStatusCode;
    const text = `${name} ${code} ${error?.message || ''}`;

    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo/i.test(text)) {
        return 'Die Adresse gibt es nicht. Die Account-ID in OFFITEC_S3_ENDPOINT stimmt nicht\n'
            + '     (oder es steht noch ein Platzhalter wie <account-id> drin).';
    }
    // Cloudflare hat *.r2.cloudflarestorage.com als Platzhalter im DNS: eine
    // falsche Account-ID loest darum AUF, scheitert aber am TLS-Handschlag.
    // Der OpenSSL-Text dazu sagt niemandem etwas — hier wird er uebersetzt.
    if (code === 'EPROTO' || /handshake failure|alert number 40|ssl3_read_bytes/i.test(text)) {
        return 'Die Gegenstelle bricht den TLS-Handschlag ab. Das ist bei R2 das Zeichen fuer eine\n'
            + '     falsche Account-ID in OFFITEC_S3_ENDPOINT: der Name loest zwar auf\n'
            + '     (*.r2.cloudflarestorage.com ist ein Platzhalter), aber es gibt kein Konto dazu.';
    }
    if (/NoSuchBucket/i.test(text)) {
        return 'Den Eimer gibt es nicht. OFFITEC_S3_BUCKET stimmt nicht — auf Gross-/Kleinschreibung achten.';
    }
    if (/InvalidAccessKeyId/i.test(text)) {
        return 'Der Schluessel ist unbekannt. OFFITEC_S3_ACCESS_KEY_ID stimmt nicht,\n'
            + '     oder das Token wurde in Cloudflare geloescht bzw. erneuert.';
    }
    if (/SignatureDoesNotMatch/i.test(text)) {
        return 'Die Unterschrift passt nicht. OFFITEC_S3_SECRET_ACCESS_KEY gehoert nicht zu dieser Key-ID\n'
            + '     (haeufig: beim Kopieren ein Zeichen verloren, oder Key und Secret vertauscht).';
    }
    if (/AccessDenied/i.test(text) || status === 403) {
        return 'Angemeldet, aber nicht erlaubt. Das Token braucht "Object Read & Write" auf GENAU diesem Eimer.';
    }
    return `${name || 'Fehler'}${status ? ` (HTTP ${status})` : ''}: ${error?.message || error}`;
}

(async () => {
    console.log('R2-Einrichtung pruefen');
    console.log('======================\n');

    // --- 1) Die Felder -----------------------------------------------------
    let missing = 0;
    for (const [key, hint] of REQUIRED) {
        const value = process.env[key] || '';
        if (!value) {
            console.log(`  FEHLT  ${key}  <- ${hint}`);
            missing += 1;
            continue;
        }
        const shown = key.includes('SECRET') ? `${value.length} Zeichen` : value;
        console.log(`  ok     ${key} = ${shown}`);
    }

    const endpoint = process.env.OFFITEC_S3_ENDPOINT || '';
    const bucket = process.env.OFFITEC_S3_BUCKET || '';

    console.log('');
    if (missing > 0) {
        console.log(`${missing} Feld(er) fehlen — bis dahin schreibt das Programm auf die Platte.`);
        console.log('Die .env liegt in Erp_Backend/.env.');
        process.exit(1);
    }

    // --- 2) Die typischen Tippfehler, bevor das Netz drankommt -------------
    // Sicher falsch: gar nicht erst verbinden, die Diagnose steht schon fest.
    const fatal: string[] = [];
    if (/[<>]/.test(endpoint)) fatal.push('OFFITEC_S3_ENDPOINT enthaelt noch spitze Klammern — der Platzhalter ist stehengeblieben.');
    if (!/^https:\/\//.test(endpoint)) fatal.push('OFFITEC_S3_ENDPOINT muss mit https:// beginnen.');

    // Verdaechtig, aber nicht zwingend falsch: melden und trotzdem probieren.
    const complaints: string[] = [];
    if (!/\.r2\.cloudflarestorage\.com\/?$/.test(endpoint)) {
        complaints.push('OFFITEC_S3_ENDPOINT sollte auf .r2.cloudflarestorage.com enden — ohne Eimernamen und ohne Pfad.');
    }
    if (bucket && endpoint.includes(`/${bucket}`)) {
        complaints.push('Der Eimername steht im Endpoint. Er gehoert NUR in OFFITEC_S3_BUCKET.');
    }
    if (/\s/.test(process.env.OFFITEC_S3_ACCESS_KEY_ID || '') || /\s/.test(process.env.OFFITEC_S3_SECRET_ACCESS_KEY || '')) {
        complaints.push('In Schluessel oder Secret steht ein Leerzeichen — beim Kopieren mitgekommen.');
    }
    if (fatal.length > 0) {
        for (const line of fatal) console.log(`  FALSCH   ${line}`);
        console.log('');
        console.log('Das laesst sich ohne Verbindungsversuch sagen — erst die .env richtigstellen.');
        process.exit(1);
    }
    if (complaints.length > 0) {
        for (const complaint of complaints) console.log(`  ACHTUNG  ${complaint}`);
        console.log('');
    }

    if (!objectStorageService.isConfigured()) {
        console.log('Die Ablage meldet sich trotzdem als "nicht eingerichtet". .env pruefen.');
        process.exit(1);
    }

    // --- 3) Die Leitung ----------------------------------------------------
    const key = `_setup-check/${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    const body = Buffer.from(`offitec r2 probe ${Date.now()}`);
    let step = 'Schreiben';

    try {
        await objectStorageService.putObject(key, body, 'text/plain');
        console.log(`  ok     geschrieben        ${key}`);

        step = 'Lesen';
        const back = await objectStorageService.getObject(key);
        if (!back.equals(body)) throw new Error('Die zurueckgelesenen Bytes sind andere.');
        console.log('  ok     zurueckgelesen     Bytes identisch');

        step = 'Presignen';
        const url = await objectStorageService.presignGet(key, { downloadName: 'probe.txt' });
        console.log(`  ok     presignte Adresse  ${url.slice(0, 68)}...`);

        step = 'Abrufen der presignten Adresse';
        const response = await fetch(url);
        const fetched = Buffer.from(await response.arrayBuffer());
        if (!response.ok || !fetched.equals(body)) {
            throw new Error(`Die Adresse lieferte HTTP ${response.status}.`);
        }
        console.log('  ok     Adresse ohne Anmeldung abrufbar');

        step = 'Loeschen';
        await objectStorageService.deleteObject(key);
        const stillThere = await objectStorageService.objectExists(key);
        console.log(`  ${stillThere ? 'FEHL  ' : 'ok    '} aufgeraeumt`);

        console.log('');
        console.log('R2 STEHT. Naechster Schritt — der Umzug der Plattendateien:');
        console.log('  npx ts-node --transpile-only scratchpad/r2-migrate-disk.ts          (Probelauf)');
        console.log('  npx ts-node --transpile-only scratchpad/r2-migrate-disk.ts --apply  (Echtlauf)');
        process.exit(0);
    } catch (error: any) {
        console.log('');
        console.log(`FEHLGESCHLAGEN beim Schritt: ${step}`);
        console.log(`  -> ${explain(error)}`);
        // Die Probedatei nicht liegen lassen.
        await objectStorageService.deleteObject(key).catch(() => undefined);
        process.exit(1);
    }
})().catch((error) => { console.error(error); process.exit(1); });
