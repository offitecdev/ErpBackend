/* Rückwärtskompatibilität (20.09.2026): Die OSP kann noch auf der DRITTEN
 * Vertragsfassung stehen, wenn wir die vierte schon ausspielen. Dort war der
 * Körper eine LISTE, in der jede Einheit das Projekt wiederholte und ihre
 * Referenz "4820193-57" hiess.
 *
 * Geprüft wird, dass genau das weiterhin ankommt — und zwar als EINE Anfrage
 * mit zwei Einheiten, nicht als zwei Anfragen. Wegwerf-Projektnummer, wird am
 * Ende entfernt.
 */
import dotenv from 'dotenv';
dotenv.config();
import prisma from '../src/infrastructure/database/prisma.client';

const BASE = 'http://localhost:3000/api/v1';
const PROJECT = '9000002';

let failures = 0;
const check = (label: string, ok: boolean, detail = '') => {
    console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
};

(async () => {
    const setting = await (prisma as any).ospSetting.findFirst({
        where: { NOT: { webhookKey: null } }, select: { webhookKey: true },
    });
    if (!setting?.webhookKey) { console.log('kein Webhook-Schlüssel — nichts zu prüfen.'); process.exit(0); }
    const hook = { 'Content-Type': 'application/json', 'X-OSP-Integration-Key': setting.webhookKey };

    const shared = {
        projectName: 'Wegwerf alte Form',
        username: 'Anna', surname: 'Keller', companyName: 'Keller AG',
        email: 'anna.keller@example.invalid',
        country: 'Switzerland', city: 'Zürich',
        projectAddress: 'Bahnhofstrasse 12, 8005 Zürich',
    };
    const legacy = [
        { ...shared, projectNumber: `${PROJECT}-771`, coolingCapacityKw: '90.0', eer: '3.0' },
        { ...shared, projectNumber: `${PROJECT}-772`, heatingCapacityKw: '110.0', cop: '4.0' },
    ];

    try {
        const res = await fetch(`${BASE}/osp/webhook`, { method: 'POST', headers: hook, body: JSON.stringify(legacy) });
        console.log('§1 (dritte Fassung) →', res.status, await res.text());
        await new Promise((r) => setTimeout(r, 900));

        const rows = await (prisma as any).ospDocument.findMany({
            where: { projectNumber: PROJECT },
            include: { units: true },
        });
        check('die alte LISTE ergibt EINE Anfrage', rows.length === 1, `rows=${rows.length}`);
        check('die Referenz ist die nackte Projektnummer', rows[0]?.reference === PROJECT, rows[0]?.reference);
        check('beide Belege wurden zu Einheiten', rows[0]?.units?.length === 2, `units=${rows[0]?.units?.length}`);
        check('die Dokument-Ids stammen aus der zusammengesetzten Referenz',
            rows[0]?.units?.map((u: any) => u.ospDocumentId).sort().join(',') === '771,772',
            rows[0]?.units?.map((u: any) => u.ospDocumentId).join(','));
        check('die Zahlen jeder Einheit stehen an IHR',
            rows[0]?.units?.find((u: any) => u.ospDocumentId === '771')?.datasheetSpecs?.power === '90 kW'
            || rows[0]?.units?.find((u: any) => u.ospDocumentId === '771')?.datasheetSpecs?.power === '90.0 kW',
            JSON.stringify(rows[0]?.units?.find((u: any) => u.ospDocumentId === '771')?.datasheetSpecs));

        // Eine Änderung der alten Form (EIN Objekt auf der Änderungsadresse).
        const change = await fetch(`${BASE}/osp/webhook/change`, {
            method: 'POST', headers: hook,
            body: JSON.stringify({ ...shared, projectNumber: `${PROJECT}-772`, changes: ['recalculated'], cop: '4.4' }),
        });
        console.log('§1b alt (change) →', change.status, await change.text());
        await new Promise((r) => setTimeout(r, 700));

        const after = await (prisma as any).ospDocument.findFirst({
            where: { projectNumber: PROJECT }, include: { units: true },
        });
        check('die Änderung trifft die richtige Einheit',
            JSON.stringify(after?.units?.find((u: any) => u.ospDocumentId === '772')?.changes) === JSON.stringify(['recalculated']),
            JSON.stringify(after?.units?.find((u: any) => u.ospDocumentId === '772')?.changes));
        check('die alte Form schreibt KEINE Projektänderung', !after?.changes, JSON.stringify(after?.changes));
        check('die andere Einheit bleibt unangetastet',
            !after?.units?.find((u: any) => u.ospDocumentId === '771')?.changes);
    } finally {
        await (prisma as any).ospDocument.deleteMany({ where: { projectNumber: PROJECT } }).catch(() => undefined);
        console.log(failures ? `\n${failures} PRÜFUNG(EN) FEHLGESCHLAGEN` : '\nalle Prüfungen bestanden');
        await prisma.$disconnect();
        process.exit(failures ? 1 : 0);
    }
})().catch(async (error) => { console.error(error); await prisma.$disconnect(); process.exit(1); });
