import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';
import { repairImportedMeetingOwners } from '../src/infrastructure/services/calendarImportService';
(async () => {
    const n = await repairImportedMeetingOwners(process.argv[2] || 'offitec-root');
    console.log('nachgetragen:', n);
    await prisma.$disconnect();
})();
