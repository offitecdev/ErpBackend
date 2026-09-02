import dotenv from 'dotenv';
dotenv.config();
import http from 'http';
import prisma from '../src/infrastructure/database/prisma.client';
import { ospDatasheetStorage } from '../src/infrastructure/services/LocalFileStorage';

/**
 * GANZE Strecke gegen den LAUFENDEN Backend (localhost:3000): Webhook mit
 * datasheetUrl herein → Hintergrundjob holt das PDF → Angaben stehen an der
 * Zeile. Wegwerf-Referenz, danach wird aufgeräumt.
 *
 * ⚠ ÜBERHOLT seit der vierten Vertragsfassung (20.09.2026): eine Anfrage ist
 * ein PROJEKT, das Datenblatt hängt an der EINHEIT (OspUnit) und nicht mehr an
 * der Zeile. Die gültige Prüfung ist `osp-contract-v4-e2e.ts`.
 */
const REF = '0000000-99';

const makePdf = (lines: string[]): Buffer => {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const content = 'BT /F1 11 Tf 40 780 Td 14 TL\n'
        + lines.map((l) => `(${esc(l)}) Tj T*`).join('\n')
        + '\nET';
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    const setting = await (prisma as any).ospSetting.findFirst({
        where: { NOT: { webhookKey: null } },
        select: { webhookKey: true },
    });
    if (!setting?.webhookKey) { console.log('no webhook key configured'); process.exit(0); }

    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(SHEET);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    const datasheetUrl = `http://127.0.0.1:${port}/datasheet.pdf`;

    const entry = {
        projectNumber: REF,
        projectName: 'Wegwerf Webhook-Selbsttest',
        username: 'Test',
        surname: 'Lauf',
        email: 'test@example.invalid',
        category: 'heat pump',
        type: 'water to water',
        model: 'AWRC-150.2CI290',
        created_at: new Date().toISOString().slice(0, 23),
        datasheetUrl,
    };
    const res = await fetch('http://localhost:3000/api/v1/osp/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-OSP-Integration-Key': String(setting.webhookKey).trim() },
        body: JSON.stringify([entry]),
        signal: AbortSignal.timeout(15000),
    });
    console.log('webhook ->', res.status, await res.text());

    let row: any = null;
    for (let i = 0; i < 20; i++) {
        await sleep(500);
        row = await (prisma as any).ospDocument.findFirst({
            where: { reference: REF },
            select: { id: true, datasheetUrl: true, datasheetFile: true, datasheetError: true, datasheetSpecs: true, rawPayload: true },
        });
        if (row?.datasheetSpecs || row?.datasheetError) break;
    }
    console.log('row url:', row?.datasheetUrl);
    console.log('row file:', row?.datasheetFile);
    console.log('row error:', row?.datasheetError);
    console.log('row raw stored:', Boolean(row?.rawPayload));
    console.log('row specs:', JSON.stringify(row?.datasheetSpecs, null, 2));

    // Aufräumen: Wegwerf-Zeile + abgelegte Datei.
    if (row?.datasheetFile) await ospDatasheetStorage.remove(row.datasheetFile).catch(() => undefined);
    if (row?.id) await (prisma as any).ospDocument.delete({ where: { id: row.id } }).catch(() => undefined);
    server.close();
    console.log('cleaned up.');
    await (prisma as any).$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
