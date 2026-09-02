/* E2E 20.09.2026 — die VIERTE Vertragsfassung, gegen den LAUFENDEN Server.
 *
 * Geprüft wird genau das, was sich geändert hat (offer-integration-api.md):
 *
 *   §1   ein PROJEKT mit mehreren Datenblättern → EINE Zeile, mehrere Einheiten
 *   §1a  eine ÄNDERUNG: `changes` am Projekt, nur die geänderte Einheit dabei
 *        — die übrigen Einheiten bleiben unangetastet
 *   §1a  eine Änderung OHNE Datenblätter (leeres `projectDetails`)
 *   §1c  der Aktivitätsstrom: eigene Ablage, KEINE Anfrage, und die gehaltene
 *        Einheit bekommt die neue PDF-Adresse + den Hinweis "neu gerendert"
 *   §1c  dieselbe Lieferung noch einmal (mindestens-einmal) → keine Dubletten
 *   §1b  Rückzug mit `withdrawnAt` (camelCase der vierten Fassung)
 *   §1   danach neu angefragt → die Zeile lebt wieder auf
 *   Import → EINE Offerte mit einer Position JE EINHEIT
 *   DELETE → Zeile und Einheiten weg
 *
 * Wegwerf-Projektnummer, am Ende (auch beim Abbruch) restlos entfernt. Der
 * Rückzug an die OSP wird dabei mit der echten Basisadresse versucht; für eine
 * unbekannte Nummer antwortet sie 404, was die Löschung ausdrücklich zulässt.
 */
import dotenv from 'dotenv';
dotenv.config();
import http from 'http';
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';
import { ospDatasheetStorage } from '../src/infrastructure/services/LocalFileStorage';

const BASE = 'http://localhost:3000/api/v1';
const PROJECT = '9000001';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    'OFFITEC Datenblatt',
    'Medium: Wasser',
    'Verdampfer und Verfluessiger fuer Wasser/Wasser - PWT',
]);

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
};

const rowOf = async () => (prisma as any).ospDocument.findFirst({
    where: { reference: PROJECT },
    include: { units: { orderBy: { createdAt: 'asc' } } },
});

(async () => {
    const setting = await (prisma as any).ospSetting.findFirst({
        where: { NOT: { webhookKey: null } },
        select: { tenantId: true, tenantIds: true, webhookKey: true, ospBaseUrl: true },
    });
    if (!setting?.webhookKey) { console.log('kein Webhook-Schlüssel hinterlegt — nichts zu prüfen.'); process.exit(0); }

    const hook = { 'Content-Type': 'application/json', 'X-OSP-Integration-Key': setting.webhookKey };
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(SHEET);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    const sheetUrl = (name: string) => `http://127.0.0.1:${port}/${name}.pdf`;

    /* Handelnde Person: eine TEILNEHMENDE Firma, nicht die Wurzel — die Wurzel
       ist die Klammer und hat oft gar keine Belegschaft. */
    const participating: string[] = [setting.tenantId, ...(Array.isArray(setting.tenantIds) ? setting.tenantIds.map(String) : [])];
    const actor = await prisma.employee.findFirst({
        where: { tenantId: { in: participating } },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    if (!actor) throw new Error('Kein Konto in einer teilnehmenden Firma gefunden.');
    const token = jwtTokenService.generateToken('access', {
        id: actor.id, tenantId: actor.tenantId, email: actor.email,
        pwdAt: toPwdAtClaim(actor.passwordChangedAt),
    } as any);
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    let createdTenderId: string | null = null;

    try {
        /* ── §1: EIN Projekt, ZWEI Datenblätter ─────────────────────────── */
        const request = {
            projectId: 990001,
            projectNumber: Number(PROJECT),
            projectName: 'Wegwerf Vertrag 4',
            created_at: '2026-09-01T09:14:07.482',
            username: 'Anna', surname: 'Keller',
            companyName: 'Keller Kältetechnik AG',
            email: 'anna.keller@example.invalid',
            phone: '+41 44 123 45 67',
            country: 'Switzerland', city: 'Zürich',
            projectAddress: 'Bahnhofstrasse 12, 8005 Zürich',
            shippingAddress: 'Bahnhofstrasse 12, 8005 Zürich',
            billingAddress: 'Postfach 44, 8021 Zürich',
            projectDetails: [
                {
                    id: 8801, pdfUrl: sheetUrl('8801'),
                    coolingCapacityKw: '106.2', heatingCapacityKw: null,
                    eer: '2.8', cop: null, refrigerant: 'R290',
                    condenserType: 'Micro-channel', evaporatorType: 'Plate',
                    soundPressureAt1mDb: '72.4', soundPressureAt10mDb: '52.4',
                    lengthMm: '2400', widthMm: '1100', heightMm: '2050',
                    operatingWeightKg: '980',
                },
                {
                    id: 8802, pdfUrl: sheetUrl('8802'),
                    coolingCapacityKw: '118.4', heatingCapacityKw: '131.7',
                    eer: '3.1', cop: '4.2', refrigerant: 'R32',
                    condenserType: 'Plate', evaporatorType: 'Plate',
                    soundPressureAt1mDb: '69.8', soundPressureAt10mDb: '49.8',
                    lengthMm: '1900', widthMm: '1000', heightMm: '1850',
                    operatingWeightKg: '740',
                },
            ],
        };
        const first = await fetch(`${BASE}/osp/webhook`, { method: 'POST', headers: hook, body: JSON.stringify(request) });
        console.log('§1  →', first.status, await first.text());
        await sleep(2500);

        let row = await rowOf();
        check('§1 legt EINE Zeile je Projekt an', Boolean(row), row?.reference);
        check('§1 Referenz = nackte Projektnummer', row?.reference === PROJECT, row?.reference);
        check('§1 Projekt-Id der OSP steht an der Zeile', row?.ospProjectId === 990001, String(row?.ospProjectId));
        check('§1 beide Einheiten hängen darunter', row?.units?.length === 2, `units=${row?.units?.length}`);
        check('§1 Chiller: Kühlleistung ist die Kopfzahl',
            row?.units?.[0]?.datasheetSpecs?.power === '106.2 kW' && row?.units?.[0]?.datasheetSpecs?.powerIsCooling === true,
            JSON.stringify(row?.units?.[0]?.datasheetSpecs?.power));
        check('§1 Wärmepumpe: Heizleistung führt, Kühlleistung daneben',
            row?.units?.[1]?.datasheetSpecs?.power === '131.7 kW' && row?.units?.[1]?.datasheetSpecs?.coolingPower === '118.4 kW',
            JSON.stringify([row?.units?.[1]?.datasheetSpecs?.power, row?.units?.[1]?.datasheetSpecs?.coolingPower]));
        check('§1 Datenblätter beider Einheiten liegen bei uns',
            Boolean(row?.units?.[0]?.datasheetFile && row?.units?.[1]?.datasheetFile),
            `${row?.units?.[0]?.datasheetError || ''} ${row?.units?.[1]?.datasheetError || ''}`.trim());
        check('§1 das PDF füllt auf, was der Vertrag nicht kennt (Medium)',
            row?.units?.[0]?.datasheetSpecs?.medium === 'Wasser', String(row?.units?.[0]?.datasheetSpecs?.medium));
        check('§1 Adressen des AUFTRAGS stehen an der Zeile',
            row?.billingAddress === 'Postfach 44, 8021 Zürich' && row?.address === 'Bahnhofstrasse 12, 8005 Zürich');

        /* ── §1a: das Projekt umbenannt, EINE Einheit neu gerechnet ─────── */
        const revision = {
            ...request,
            projectName: 'Wegwerf Vertrag 4 (neu)',
            phone: '+41 61 555 22 11',
            city: 'Basel',
            changes: ['project name', 'phone', 'city'],
            projectDetails: [{
                id: 8802, pdfUrl: sheetUrl('8802-neu'),
                changes: ['recalculated'],
                coolingCapacityKw: '121.0', heatingCapacityKw: '140.0',
                eer: '3.3', cop: '4.4',
            }],
        };
        const second = await fetch(`${BASE}/osp/webhook/revision`, { method: 'POST', headers: hook, body: JSON.stringify(revision) });
        console.log('§1a →', second.status, await second.text());
        await sleep(2500);

        row = await rowOf();
        const unit8801 = row?.units?.find((u: any) => u.ospDocumentId === '8801');
        const unit8802 = row?.units?.find((u: any) => u.ospDocumentId === '8802');
        check('§1a legt KEINE zweite Zeile an', row?.units?.length === 2, `units=${row?.units?.length}`);
        check('§1a merkt sich, WAS am Projekt bewegt wurde',
            JSON.stringify(row?.changes) === JSON.stringify(['project name', 'phone', 'city']), JSON.stringify(row?.changes));
        check('§1a stempelt die Überarbeitung', Boolean(row?.revisedAt) && row?.revisionCount === 1, String(row?.revisionCount));
        check('§1a merkt sich, WAS an der Einheit bewegt wurde',
            JSON.stringify(unit8802?.changes) === JSON.stringify(['recalculated']), JSON.stringify(unit8802?.changes));
        check('§1a die NICHT genannte Einheit bleibt unangetastet',
            unit8801?.datasheetSpecs?.power === '106.2 kW' && !unit8801?.changes,
            JSON.stringify(unit8801?.datasheetSpecs?.power));
        check('§1a die geänderte Einheit trägt die neuen Zahlen',
            unit8802?.datasheetSpecs?.power === '140 kW' || unit8802?.datasheetSpecs?.power === '140.0 kW',
            String(unit8802?.datasheetSpecs?.power));
        check('§1a das neue Datenblatt wurde geholt',
            unit8802?.pdfUrl === sheetUrl('8802-neu') && Boolean(unit8802?.datasheetFile), String(unit8802?.datasheetError));

        /* ── §1a ohne Datenblätter: nur die Rechnungsadresse bewegt ─────── */
        const fieldsOnly = {
            projectId: 990001, projectNumber: Number(PROJECT),
            projectName: 'Wegwerf Vertrag 4 (neu)',
            username: 'Anna', surname: 'Keller', email: 'anna.keller@example.invalid',
            billingAddress: 'Neue Postfach 12, 8021 Zürich',
            changes: ['billing address'],
            projectDetails: [],
        };
        const third = await fetch(`${BASE}/osp/webhook/revision`, { method: 'POST', headers: hook, body: JSON.stringify(fieldsOnly) });
        console.log('§1a (leer) →', third.status, await third.text());
        await sleep(700);

        row = await rowOf();
        check('§1a leeres projectDetails ist kein Fehler',
            row?.billingAddress === 'Neue Postfach 12, 8021 Zürich' && row?.units?.length === 2,
            `units=${row?.units?.length}`);
        check('§1a leeres projectDetails lässt die Datenblätter stehen',
            Boolean(row?.units?.every((u: any) => u.datasheetFile)));

        /* ── §1c: der Aktivitätsstrom ───────────────────────────────────── */
        const feed = [{
            projectId: 990001, projectNumber: Number(PROJECT),
            projectName: 'Wegwerf Vertrag 4 (neu)',
            projectCreatedAt: '2026-09-01T09:15:22.418',
            username: 'Anna', surname: 'Keller',
            companyName: 'Keller Kältetechnik AG', email: 'anna.keller@example.invalid',
            projectDetails: [
                {
                    id: 8802, unitName: 'Air Cooled Chiller', unitModel: 'ACC-120',
                    pdfUrl: sheetUrl('8802-strom'), source: 'RECALCULATED',
                    filedAt: '2026-09-02T14:20:41.882',
                    coolingCapacityKw: '125.5', heatingCapacityKw: null, eer: '3.4', cop: null,
                },
                {
                    id: 8899, unitName: 'Neue Rechnung', unitModel: 'ACC-999',
                    pdfUrl: sheetUrl('8899'), source: 'CALCULATION',
                    filedAt: '2026-09-02T14:21:02.100',
                    coolingCapacityKw: '80.0', heatingCapacityKw: null, eer: '3.0', cop: null,
                },
            ],
        }];
        const fourth = await fetch(`${BASE}/osp/webhook/project`, { method: 'POST', headers: hook, body: JSON.stringify(feed) });
        console.log('§1c →', fourth.status, await fourth.text());
        await sleep(2500);

        const feedRows = await (prisma as any).ospFeedEntry.findMany({ where: { projectNumber: PROJECT } });
        row = await rowOf();
        const held = row?.units?.find((u: any) => u.ospDocumentId === '8802');
        check('§1c legt eigene Zeilen an (KEINE Anfrage)', feedRows.length === 2, `feed=${feedRows.length}`);
        check('§1c erzeugt KEINE zusätzliche Anfrage-Einheit', row?.units?.length === 2, `units=${row?.units?.length}`);
        check('§1c frischt die PDF-Adresse der gehaltenen Einheit auf',
            held?.pdfUrl === sheetUrl('8802-strom'), String(held?.pdfUrl));
        check('§1c trägt Name und Modell nach', held?.unitModel === 'ACC-120', String(held?.unitModel));
        check('§1c stempelt "drüben neu gerendert" an die Anfrage',
            Boolean(row?.feedRevisedAt) && row?.feedRevisedSource === 'RECALCULATED', String(row?.feedRevisedSource));
        check('§1c ändert den Stand NICHT', row?.status === 'LISTED' || row?.status === 'IN_OFFER', row?.status);

        // Mindestens-einmal: dieselbe Lieferung noch einmal.
        const again = await fetch(`${BASE}/osp/webhook/project`, { method: 'POST', headers: hook, body: JSON.stringify(feed) });
        await again.text();
        await sleep(900);
        const feedAgain = await (prisma as any).ospFeedEntry.count({ where: { projectNumber: PROJECT } });
        check('§1c dieselbe Lieferung erzeugt keine Dubletten', feedAgain === 2, `feed=${feedAgain}`);

        /* ── §1b: Rückzug mit camelCase-Zeitpunkt ───────────────────────── */
        const fifth = await fetch(`${BASE}/osp/webhook/withdrawal`, {
            method: 'POST', headers: hook,
            body: JSON.stringify({ projectId: 990001, projectNumber: Number(PROJECT), withdrawnAt: '2026-09-02T14:22:09.114' }),
        });
        console.log('§1b →', fifth.status, await fifth.text());
        await sleep(600);
        row = await rowOf();
        check('§1b setzt die Anfrage auf WITHDRAWN', row?.status === 'WITHDRAWN', row?.status);
        check('§1b liest `withdrawnAt` der vierten Fassung',
            row?.withdrawnAt && new Date(row.withdrawnAt).getUTCFullYear() === 2026
            && new Date(row.withdrawnAt).getUTCDate() === 2, String(row?.withdrawnAt));

        /* ── §1 nach dem Rückzug: die Anfrage lebt wieder auf ───────────── */
        const sixth = await fetch(`${BASE}/osp/webhook`, { method: 'POST', headers: hook, body: JSON.stringify(request) });
        console.log('§1 (erneut) →', sixth.status, await sixth.text());
        await sleep(1200);
        row = await rowOf();
        check('§1 nach Rückzug: die Zeile lebt wieder auf', row?.status === 'LISTED' && !row?.withdrawnAt, row?.status);
        check('§1 nach Rückzug: die Änderungsliste ist weg', !row?.changes, JSON.stringify(row?.changes));

        /* ── Import: EINE Offerte, eine Position JE EINHEIT ─────────────── */
        const importRes = await fetch(`${BASE}/osp/documents/${row.id}/import`, {
            method: 'POST', headers: auth,
            body: JSON.stringify({ customerId: null, manualCustomer: { name: 'Keller Kältetechnik AG' }, positions: [] }),
        });
        const imported = await importRes.json().catch(() => null) as any;
        console.log('Import →', importRes.status, imported?.tenderNumber);
        createdTenderId = imported?.tenderId || null;
        if (createdTenderId) {
            const positions = await prisma.position.count({ where: { tenderId: createdTenderId } });
            check('Import erzeugt eine Position JE EINHEIT', positions === 2, `positions=${positions}`);
            const first = await prisma.position.findFirst({
                where: { tenderId: createdTenderId }, orderBy: { displayOrder: 'asc' },
                select: { shortDescription: true, rowType: true, sourceArticleId: true },
            });
            check('Import legt reinen TEXT an (nie Artikel/Bestand)',
                first?.rowType === 'CUSTOM' && !first?.sourceArticleId, `${first?.rowType}`);
        } else {
            check('Import erzeugt eine Offerte', false, JSON.stringify(imported).slice(0, 200));
        }

        /* ── §4: der Abgleich läuft (die OSP kennt die Wegwerfnummer nicht) */
        const syncRes = await fetch(`${BASE}/osp/sync`, { method: 'POST', headers: auth });
        const sync = await syncRes.json().catch(() => null) as any;
        console.log('§4  →', syncRes.status, JSON.stringify(sync));
        check('§4 Abgleich läuft durch', syncRes.status === 200, JSON.stringify(sync));

        /* ── Die Aktivitätsliste der Oberfläche ─────────────────────────── */
        const feedList = await fetch(`${BASE}/osp/feed?q=${PROJECT}`, { headers: auth });
        const feedBody = await feedList.json().catch(() => null) as any;
        check('Aktivitätsliste zeigt den Strom', feedList.status === 200 && feedBody?.items?.length === 2,
            `status=${feedList.status} items=${feedBody?.items?.length}`);
        check('Aktivitätsliste sagt, was wir davon halten',
            Boolean(feedBody?.items?.find((r: any) => r.ospDocumentId === '8802')?.requestId)
            && !feedBody?.items?.find((r: any) => r.ospDocumentId === '8899')?.requestId);
    } finally {
        server.close();
        /* Aufräumen: Offerte, Zeile, Einheiten, Strom und die abgelegten
           Dateien — eine Wegwerfprüfung hinterlässt nichts. */
        const row = await rowOf();
        if (row) {
            for (const unit of row.units || []) {
                if (unit.datasheetFile) await ospDatasheetStorage.remove(unit.datasheetFile).catch(() => undefined);
            }
            await (prisma as any).ospDocument.delete({ where: { id: row.id } }).catch(() => undefined);
        }
        await (prisma as any).ospFeedEntry.deleteMany({ where: { projectNumber: PROJECT } }).catch(() => undefined);
        if (createdTenderId) {
            await prisma.position.deleteMany({ where: { tenderId: createdTenderId } }).catch(() => undefined);
            await (prisma as any).tenderActivityLog.deleteMany({ where: { tenderId: createdTenderId } }).catch(() => undefined);
            await prisma.tender.delete({ where: { id: createdTenderId } }).catch(() => undefined);
        }
        const left = await rowOf();
        const unitsLeft = await (prisma as any).ospUnit.count({ where: { ospDocumentId: { in: ['8801', '8802'] } } });
        check('Aufräumen: Zeile und Einheiten sind weg', !left && unitsLeft === 0, `units=${unitsLeft}`);
        console.log(failures ? `\n${failures} PRÜFUNG(EN) FEHLGESCHLAGEN` : '\nalle Prüfungen bestanden');
        await prisma.$disconnect();
        process.exit(failures ? 1 : 0);
    }
})().catch(async (error) => { console.error(error); await prisma.$disconnect(); process.exit(1); });
