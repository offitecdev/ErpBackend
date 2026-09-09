/* E2E 21.09.2026 — DIE DOKUMENTE UND DIE ANGABEN.
 *
 * Zwei Dinge, die vorher nicht gingen:
 *
 *  1. Ein Datenblatt war nur auf DEM Rechner zu öffnen, der es geholt hatte.
 *     Die Datenbank teilen sich alle, die Platte nicht — wer den Beleg woanders
 *     öffnete, bekam einen Serverfehler. Jetzt wird beim Öffnen nachgesehen
 *     statt geglaubt: fehlt die Datei, wird sie neu geholt.
 *  2. Die Angaben wurden mit Suchmustern über den ganzen PDF-Text gelesen. Aus
 *     „differing medium concentrations" wurde das Medium „concentrations".
 *     Gelesen wird jetzt aus den ZEILEN des Blattes — und dieselbe Lesung steht
 *     als Markdown an der Einheit.
 *
 * Geprüft wird gegen den laufenden Server, mit einer Wegwerf-Projektnummer und
 * einem ECHTEN OSP-Datenblatt als Vorlage.
 */
import dotenv from 'dotenv';
dotenv.config();
import prisma from '../src/infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../src/infrastructure/services/JwtTokenService';
import { ospDatasheetStorage } from '../src/infrastructure/services/LocalFileStorage';

const BASE = 'http://localhost:3000/api/v1';
const PROJECT = '9000003';
/* Ein echtes Blatt der OSP — die Prüfung soll an dem scheitern, woran die
   Wirklichkeit scheitert, nicht an einer selbstgebauten Vorlage. */
const REAL_SHEET = 'https://assets.osp.offitec.ch/reports/unit-154/d6441312-784c-463b-8ecc-dc80ac554a17.pdf';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
};

(async () => {
    const setting = await (prisma as any).ospSetting.findFirst({
        where: { NOT: { webhookKey: null } },
        select: { tenantId: true, tenantIds: true, webhookKey: true },
    });
    if (!setting?.webhookKey) { console.log('kein Webhook-Schlüssel — nichts zu prüfen.'); process.exit(0); }
    const hook = { 'Content-Type': 'application/json', 'X-OSP-Integration-Key': setting.webhookKey };

    const participating: string[] = [setting.tenantId, ...(Array.isArray(setting.tenantIds) ? setting.tenantIds.map(String) : [])];
    const actor = await prisma.employee.findFirst({
        where: { tenantId: { in: participating } },
        select: { id: true, email: true, tenantId: true, passwordChangedAt: true },
    });
    const token = jwtTokenService.generateToken('access', {
        id: actor!.id, tenantId: actor!.tenantId, email: actor!.email,
        pwdAt: toPwdAtClaim(actor!.passwordChangedAt),
    } as any);
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    try {
        const sent = await fetch(`${BASE}/osp/webhook`, {
            method: 'POST',
            headers: hook,
            body: JSON.stringify({
                projectId: 990003,
                projectNumber: Number(PROJECT),
                projectName: 'Wegwerf Datenblatt',
                created_at: '2026-09-01T09:00:00.000',
                username: 'Anna', surname: 'Keller', companyName: 'Keller AG',
                email: 'anna.keller@example.invalid', phone: '+41 44 000 00 00',
                country: 'Switzerland', city: 'Zürich',
                projectAddress: 'Bahnhofstrasse 12, 8005 Zürich',
                // Die Zahlen des Vertrags — sie gelten VOR dem, was im Blatt steht.
                projectDetails: [{ id: 990031, pdfUrl: REAL_SHEET, coolingCapacityKw: '82.32', eer: '4.2' }],
            }),
        });
        console.log('§1 →', sent.status, await sent.text());
        await new Promise((resolve) => setTimeout(resolve, 7000));

        const doc = await (prisma as any).ospDocument.findFirst({
            where: { reference: PROJECT }, include: { units: true },
        });
        const unit = doc?.units?.[0];
        check('das Blatt wurde geholt', Boolean(unit?.datasheetFile), String(unit?.datasheetError));
        check('die Ablage ist R2, nicht die Platte des Rechners',
            String(unit?.datasheetFile || '').startsWith('r2:'), String(unit?.datasheetFile));

        const specs = unit?.datasheetSpecs || {};
        check('MEDIUM kommt aus der Zeile, nicht aus dem Fliesstext',
            specs.medium === 'Wasser', String(specs.medium));
        check('das MODELL steht an der Einheit (§1 nennt es nicht)',
            unit?.unitModel === 'AWSCR-150.2CI290' && specs.model === 'AWSCR-150.2CI290',
            String(unit?.unitModel));
        check('ein Chiller bekommt KEINEN COP angedichtet', !specs.cop, String(specs.cop));
        check('die Zahl des Vertrags gilt vor der des Blattes',
            specs.power === '82.32 kW' && specs.eer === '4.2', `${specs.power} / ${specs.eer}`);
        check('Abmessungen und Gewicht stehen da',
            specs.dimensions === '2792 x 1220 x 2530 mm' && specs.weight === '776 kg',
            `${specs.dimensions} / ${specs.weight}`);
        check('der Listenpreis ist der BETRAG', String(specs.listPrice || '').startsWith('CHF'), String(specs.listPrice));

        const md = String(unit?.datasheetMarkdown || '');
        check('die Markdown-Fassung steht an der Einheit', md.length > 500, `${md.length} Zeichen`);
        check('sie beginnt mit den Produktangaben', md.includes('## Produktangaben'), md.slice(0, 40));
        check('sie enthält das ganze Blatt', md.includes('Unit Technical Specifications'));

        /* Der Kern: die Datei verschwindet — und der Server holt sie beim
           Öffnen von selbst nach. Genau dieser Fall ist der Fehler gewesen,
           den die Verkaufsseite als „Dokument nicht abrufbar" gesehen hat. */
        await ospDatasheetStorage.remove(unit.datasheetFile).catch(() => undefined);
        await (prisma as any).ospUnit.update({
            where: { id: unit.id },
            data: { datasheetFile: 'local:osp-datasheet/gibt-es-nicht/2026-09/weg.pdf' },
        });
        const served = await fetch(`${BASE}/osp/units/${unit.id}/datasheet`, { headers: auth });
        check('eine verlorene Datei wird beim Öffnen neu geholt',
            served.status === 200 && (served.headers.get('content-type') || '').includes('pdf'),
            `${served.status} ${served.headers.get('content-length')}`);

        // Und derselbe Griff für das ganze Projekt.
        const bulk = await fetch(`${BASE}/osp/documents/${doc.id}/datasheets`, {
            method: 'POST', headers: auth, body: JSON.stringify({ force: true }),
        });
        const bulkBody: any = await bulk.json();
        check('die Dokumente eines PROJEKTS werden in einem Griff geholt',
            bulk.status === 200 && bulkBody.fetched === 1 && bulkBody.failed === 0,
            JSON.stringify(bulkBody.results));

        const mdRes = await fetch(`${BASE}/osp/units/${unit.id}/markdown`, { headers: auth });
        const mdBody: any = await mdRes.json();
        check('die Textfassung ist abrufbar',
            mdRes.status === 200 && String(mdBody.datasheetMarkdown || '').includes('Produktangaben'));
    } finally {
        const doc = await (prisma as any).ospDocument.findFirst({
            where: { reference: PROJECT }, include: { units: true },
        });
        if (doc) {
            for (const unit of doc.units || []) {
                if (unit.datasheetFile) await ospDatasheetStorage.remove(unit.datasheetFile).catch(() => undefined);
            }
            await (prisma as any).ospDocument.delete({ where: { id: doc.id } }).catch(() => undefined);
        }
        console.log(failures ? `\n${failures} PRÜFUNG(EN) FEHLGESCHLAGEN` : '\nalle Prüfungen bestanden');
        await prisma.$disconnect();
        process.exit(failures ? 1 : 0);
    }
})().catch(async (error) => { console.error(error); await prisma.$disconnect(); process.exit(1); });
