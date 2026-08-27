import http from 'http';
import { fetchOspDatasheet } from '../src/infrastructure/services/ospDatasheet';
import { ospDatasheetStorage } from '../src/infrastructure/services/LocalFileStorage';

/** Ein minimales, unkomprimiertes PDF mit je einer Textzeile pro Eintrag. */
const makePdf = (lines: string[]): Buffer => {
    const esc = (s: string) => s
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)');
    const content = 'BT /F1 11 Tf 40 780 Td 14 TL\n'
        + lines.map((l) => `(${esc(l)}) Tj T*`).join('\n')
        + '\nET';
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
            + '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
        `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
        offsets.push(Buffer.byteLength(pdf, 'latin1'));
        pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf, 'latin1');
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
        + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
        + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(pdf, 'latin1');
};

const SHEET = makePdf([
    'OFFITEC Datenblatt AWRC-150.2CI290',
    'Leistungsdaten',
    'Heizleistung: 227.3 kW',
    'COP: 3.82',
    'Medium: Wasser',
    'Verdampfer und Verfluessiger fuer Wasser/Wasser - PWT',
    'Umweltfreundliches Kaeltemittel R290',
    'Intelligente Steuerung via Schneider Electric',
    'Schalldruck bei 1 m: 75 dB(A) mit normalem Schallschutz',
    'Schalldruck bei 10 m: 56 dB(A)',
    'Abmessungen (L x B x H): ca. 2,07 m x 0,90 m x 1,95 m',
    'Betriebsgewicht: ca. 1403 kg',
]);

(async () => {
    const server = http.createServer((req, res) => {
        if (req.url === '/datasheet.pdf') {
            res.writeHead(200, { 'Content-Type': 'application/pdf' });
            res.end(SHEET);
        } else if (req.url === '/proposal') {
            // Der Link auf die Offerte drueben: 200, aber HTML.
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<!DOCTYPE html><html><body>Angebot ansehen</body></html>');
        } else {
            res.writeHead(404).end('nope');
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    const endpoint = { ospBaseUrl: `http://127.0.0.1:${port}`, ospApiKey: 'test-key' };

    const ok = await fetchOspDatasheet(endpoint, 'test-tenant', `http://127.0.0.1:${port}/datasheet.pdf`);
    console.log('PDF   -> ok:', ok.ok, '| file:', ok.file, '| err:', ok.error);
    console.log('specs:', JSON.stringify(ok.specs, null, 2));
    if (ok.file) {
        const back = await ospDatasheetStorage.read(ok.file);
        console.log('stored bytes identical:', back.equals(SHEET));
        await ospDatasheetStorage.remove(ok.file);
        console.log('cleaned up.');
    }

    const html = await fetchOspDatasheet(endpoint, 'test-tenant', `http://127.0.0.1:${port}/proposal`);
    console.log('\nHTML  -> ok:', html.ok, '| err:', html.error);
    const missing = await fetchOspDatasheet(endpoint, 'test-tenant', `http://127.0.0.1:${port}/gone`);
    console.log('404   -> ok:', missing.ok, '| err:', missing.error);

    server.close();
})().catch((e) => { console.error('ERR', e?.message || e); process.exit(1); });
