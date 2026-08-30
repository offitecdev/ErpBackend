import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';

/* Abruf kurz anhalten bzw. wieder einschalten — damit die Zusammenführung
   nicht gegen einen laufenden Durchgang arbeitet.
     ts-node scratchpad/mail-capture-pause.ts off
     ts-node scratchpad/mail-capture-pause.ts on   */
(async () => {
    const on = process.argv[2] === 'on';
    const before = await prisma.mailSetting.findMany({ select: { tenantId: true, imapCaptureEnabled: true } });
    console.log('before:', JSON.stringify(before));
    const result = await prisma.mailSetting.updateMany({ data: { imapCaptureEnabled: on } });
    console.log(on ? 'capture ON' : 'capture OFF', '→', result.count, 'row(s)');
    await prisma.$disconnect();
})();
