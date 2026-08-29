/* Postfach-Umbau: läuft der Erstabruf? Zählt frische MailMessage-Zeilen und
   zeigt den Lesestand. */
import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';

(async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    const [fresh, total, withHtml, unmatched, settings, categories] = await Promise.all([
        prisma.mailMessage.count({ where: { createdAt: { gte: tenMinutesAgo } } }),
        prisma.mailMessage.count(),
        prisma.mailMessage.count({ where: { NOT: { bodyHtml: null } } }),
        prisma.mailMessage.count({ where: { customerId: null, employeeId: null, matchSource: null } }),
        prisma.mailSetting.findMany({ select: { tenantId: true, imapLastUid: true, imapSentLastUid: true, imapLastSummary: true, imapLastError: true, imapLastSyncAt: true } }),
        prisma.mailCategory.findMany({ select: { tenantId: true, kind: true, name: true, color: true } }),
    ]);
    console.log('neu (10 min):', fresh, '| gesamt:', total, '| mit HTML:', withHtml, '| ohne Zuordnung:', unmatched);
    for (const s of settings) console.log(s.tenantId, 'lastUid:', String(s.imapLastUid), 'sentUid:', String(s.imapSentLastUid), '|', s.imapLastSummary, '|', s.imapLastError ? `FEHLER: ${s.imapLastError.slice(0, 120)}` : 'ok', '|', s.imapLastSyncAt);
    console.log('Kategorien:', categories);
    await prisma.$disconnect();
})();
