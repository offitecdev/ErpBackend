import dotenv from 'dotenv';
dotenv.config();
import http from 'http';
import prisma from '../src/infrastructure/database/prisma.client';
import { ospDatasheetStorage } from '../src/infrastructure/services/LocalFileStorage';

/**
 * Vertragsfassung (2) gegen den LAUFENDEN Backend (localhost:3000):
 *  1. §1-Webhook mit `pdfUrl` → Zeile entsteht, PDF wird geholt und gelesen.
 *  2. §1b-Änderungs-Webhook → NEUES PDF ersetzt Kopie und Angaben.
 * Wegwerf-Referenz, danach wird aufgeräumt.
 */
const REF = '0000000-98';

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

const SHEET_V1 = makePdf(['Datenblatt V1', 'Heizleistung: 227.3 kW', 'COP: 3.82', 'Medium: Wasser']);
const SHEET_V2 = makePdf(['Datenblatt V2 (neu gerechnet)', 'Heizleistung: 241.6 kW', 'COP: 3.95', 'Medium: Wasser']);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    const setting = await (prisma as any).ospSetting.findFirst({
        where: { NOT: { webhookKey: null } },
        select: { webhookKey: true },
    });
    if (!setting?.webhookKey) { console.log('no webhook key configured'); process.exit(0); }
    const headers = {
        'Content-Type': 'application/json',
        'X-OSP-Integration-Key': String(setting.webhookKey).trim(),
    };

    let serveV2 = false;
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end((req.url || '').includes('v2') || serveV2 ? SHEET_V2 : SHEET_V1);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    /* §1 — Anfrage mit pdfUrl (neuer Feldname). */
    const res1 = await fetch('http://localhost:3000/api/v1/osp/webhook', {
        method: 'POST',
        headers,
        body: JSON.stringify([{
            projectNumber: REF,
            projectName: 'Wegwerf Vertrag-(2)-Selbsttest',
            username: 'Test', surname: 'Lauf', email: 'test@example.invalid',
            company: 'Keller Kältetechnik AG', userType: 'user',
            address: 'Bahnhofstrasse 12', country: 'Switzerland', city: 'Zürich', postalCode: '8005',
            category: 'heat pump', type: 'water to water', model: 'OSP-HP-120',
            pdfUrl: `http://127.0.0.1:${port}/documents/${REF}-datasheet.pdf`,
            created_at: new Date().toISOString().slice(0, 23),
        }]),
        signal: AbortSignal.timeout(15000),
    });
    console.log('§1  webhook ->', res1.status, await res1.text());

    const read = async () => (prisma as any).ospDocument.findFirst({
        where: { reference: REF },
        select: { id: true, datasheetUrl: true, datasheetFile: true, datasheetError: true, datasheetSpecs: true },
    });
    let row: any = null;
    for (let i = 0; i < 20; i++) { await sleep(500); row = await read(); if (row?.datasheetSpecs || row?.datasheetError) break; }
    console.log('§1  url stored:', row?.datasheetUrl);
    console.log('§1  specs:', JSON.stringify(row?.datasheetSpecs));
    const fileV1 = row?.datasheetFile;

    /* §1b — Änderung: neues PDF unter neuer Adresse. */
    const res2 = await fetch('http://localhost:3000/api/v1/osp/webhook/change', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            projectNumber: REF,
            projectName: 'Wegwerf Vertrag-(2)-Selbsttest',
            model: 'OSP-HP-120',
            change: 'recalculated',
            offerStatus: 'under review',
            pdfUrl: `http://127.0.0.1:${port}/documents/${REF}-datasheet-v2.pdf`,
            changed_at: new Date().toISOString().slice(0, 23),
        }),
        signal: AbortSignal.timeout(15000),
    });
    console.log('§1b change ->', res2.status, await res2.text());

    row = null;
    for (let i = 0; i < 20; i++) {
        await sleep(500);
        row = await read();
        if (row?.datasheetSpecs?.power === '241.6 kW' || row?.datasheetError) break;
    }
    console.log('§1b url stored:', row?.datasheetUrl);
    console.log('§1b specs:', JSON.stringify(row?.datasheetSpecs));
    console.log('§1b file replaced:', Boolean(row?.datasheetFile && row.datasheetFile !== fileV1));

    /* Aufräumen. */
    if (row?.datasheetFile) await ospDatasheetStorage.remove(row.datasheetFile).catch(() => undefined);
    if (row?.id) await (prisma as any).ospDocument.delete({ where: { id: row.id } }).catch(() => undefined);
    server.close();
    console.log('cleaned up.');
    await (prisma as any).$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
