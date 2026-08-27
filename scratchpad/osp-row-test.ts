import dotenv from 'dotenv';
dotenv.config();
import { nanoid } from 'nanoid';
import prisma from '../src/infrastructure/database/prisma.client';
import { pickDatasheetUrl } from '../src/infrastructure/services/ospDatasheet';

/**
 * Schreibt EINE Wegwerf-Zeile auf einen Test-Mandanten, prueft, dass die neuen
 * JSON-Spalten sauber hin- und zurueckkommen, und raeumt wieder auf.
 */
const ENTRY = {
    projectNumber: '0000000-1',
    projectName: 'Wegwerf (Selbsttest)',
    username: 'Test',
    surname: 'Lauf',
    email: 'test@example.invalid',
    category: 'heat pump',
    type: 'water to water',
    model: 'TEST-1',
    created_at: '2026-08-27T09:14:07.482',
    datasheetUrl: 'https://osp.offitec.ch/files/test.pdf',
    proposalUrl: 'https://osp.offitec.ch/projects/0000000',
};

(async () => {
    const id = nanoid(12);
    const tenantId = '__osp_selftest__';
    const url = pickDatasheetUrl(ENTRY);
    console.log('picked datasheet url:', url);

    await (prisma as any).ospDocument.create({
        data: {
            id,
            tenantId,
            reference: '0000000-1',
            projectNumber: '0000000',
            documentId: '1',
            projectName: ENTRY.projectName,
            status: 'LISTED',
            datasheetUrl: url,
            rawPayload: ENTRY as any,
            datasheetSpecs: { power: '227.3 kW', cop: '3.82', powerIsCooling: false } as any,
        },
    });

    const back = await (prisma as any).ospDocument.findUnique({ where: { id } });
    console.log('datasheetUrl  ->', back.datasheetUrl);
    console.log('rawPayload    ->', JSON.stringify(back.rawPayload));
    console.log('datasheetSpecs->', JSON.stringify(back.datasheetSpecs));
    console.log('specs.power is a real value:', back.datasheetSpecs?.power === '227.3 kW');
    console.log('raw payload survived intact:', back.rawPayload?.model === 'TEST-1');

    await (prisma as any).ospDocument.delete({ where: { id } });
    const gone = await (prisma as any).ospDocument.findUnique({ where: { id } });
    console.log('cleaned up:', gone === null);

    const leftovers = await (prisma as any).ospDocument.count({ where: { tenantId } });
    console.log('rows left on the test tenant:', leftovers);
    await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e?.message || e); process.exit(1); });
