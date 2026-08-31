import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';
(async () => {
    const rows = await prisma.$queryRawUnsafe<any[]>(`
        SELECT tenantId, imapHost, imapUser, fromEmail, imapCaptureEnabled, imapCaptureRepliesOnly,
               imapWindowMonths, imapInboxFolder, sentFolder,
               CAST(imapUidValidity AS CHAR) AS uidValidity, CAST(imapLastUid AS CHAR) AS lastUid,
               CAST(imapSentUidValidity AS CHAR) AS sentValidity, CAST(imapSentLastUid AS CHAR) AS sentLastUid,
               imapLastSyncAt, imapLastSummary, LEFT(COALESCE(imapLastError,''),160) AS lastError,
               createdAt, updatedAt
        FROM MailSetting`);
    for (const r of rows) { console.log('---'); for (const k of Object.keys(r)) console.log('  ', k, '=', String(r[k])); }
    await prisma.$disconnect();
})();
