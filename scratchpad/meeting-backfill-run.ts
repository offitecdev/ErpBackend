/* Termine aus dem Postfach nachholen — derselbe Durchgang wie POST /meetings/backfill. */
import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';
import { captureInbox } from '../src/infrastructure/services/ImapCaptureService';

(async () => {
    const tenantId = process.argv[2] || 'offitec-root';
    console.log('Nachholen für', tenantId, '…');
    const summary = await captureInbox(tenantId, { calendarOnly: true });
    console.log(JSON.stringify({ ...summary, preview: undefined }, null, 2));
    await prisma.$disconnect();
    process.exit(0);
})();
