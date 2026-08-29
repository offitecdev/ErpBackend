import { nanoid } from 'nanoid';
import prisma from '../src/infrastructure/database/prisma.client';
import { createEnquiriesFromMails } from '../src/infrastructure/services/enquiryFromMail';

/* MAIL -> ANFRAGE: was passiert, wenn eine Nachricht der Kategorie «Anfragen»
   zugeordnet wird. Geprueft werden die drei Regeln:
     1. aus EINGEHENDER Post wird eine Anfrage (ohne Kunden),
     2. dieselbe Mail wird NICHT zweimal zur Anfrage,
     3. GESENDETE Post wird gar nicht erst eine. */

(async () => {
    const tenant = await prisma.tenant.findFirst({ select: { id: true, tenantName: true } });
    if (!tenant) throw new Error('kein Mandant');
    const tenantId = tenant.id;
    const employee = await prisma.employee.findFirst({ where: { tenantId }, select: { id: true } });
    console.log('Mandant:', tenant.tenantName);

    const inId = nanoid(12);
    const outId = nanoid(12);
    const sentAt = new Date(Date.now() - 3 * 24 * 3600 * 1000); // vor drei Tagen

    await prisma.mailMessage.createMany({
        data: [
            {
                id: inId, tenantId, direction: 'IN', origin: 'IMAP',
                subject: 'Offertanfrage Lueftung', fromName: 'Beat Muster',
                fromAddress: 'beat@fremdefirma.example',
                toRecipients: [{ name: 'Offitec', address: 'info@offitec.ch' }],
                bodyText: 'Guten Tag, wir bauen um und braeuchten eine Offerte.',
                bodyPreview: 'Guten Tag, wir bauen um …', sentAt,
            },
            {
                id: outId, tenantId, direction: 'OUT', origin: 'ERP',
                subject: 'Unsere Antwort', fromName: 'Offitec', fromAddress: 'info@offitec.ch',
                toRecipients: [{ name: 'Beat', address: 'beat@fremdefirma.example' }],
                bodyText: 'Gern.', bodyPreview: 'Gern.', sentAt: new Date(),
            },
        ],
    });
    console.log('Zwei Testnachrichten angelegt (1 IN, 1 OUT).');

    // 1. + 3. Beide auf einmal zuordnen
    const first = await createEnquiriesFromMails(tenantId, [inId, outId], employee?.id ?? null);
    console.log('1. Lauf  ->', JSON.stringify(first));

    const rows = await prisma.enquiry.findMany({
        where: { tenantId, mailMessageId: { in: [inId, outId] } },
        select: { id: true, source: true, status: true, subject: true, email: true, companyName: true, customerId: true, createdAt: true, mailMessageId: true },
    });
    console.log('Angelegt:', rows.length);
    for (const row of rows) {
        console.log('  ', row.source, '|', row.subject, '|', row.email,
            '| Kunde:', row.customerId ?? 'keiner',
            '| aus OUT?', row.mailMessageId === outId,
            '| Datum = Empfang?', Math.abs(row.createdAt.getTime() - sentAt.getTime()) < 2000);
    }

    // 2. Nochmals zuordnen — es darf KEINE zweite Anfrage entstehen
    const second = await createEnquiriesFromMails(tenantId, [inId, outId], employee?.id ?? null);
    const after = await prisma.enquiry.count({ where: { tenantId, mailMessageId: { in: [inId, outId] } } });
    console.log('2. Lauf  ->', JSON.stringify(second), '| Anfragen jetzt:', after);

    // Aufraeumen
    await prisma.enquiry.deleteMany({ where: { tenantId, mailMessageId: { in: [inId, outId] } } });
    await prisma.mailMessage.deleteMany({ where: { id: { in: [inId, outId] } } });
    console.log('aufgeraeumt.');
    await prisma.$disconnect();
})().catch(async (error) => {
    console.error('FEHLER:', error);
    await prisma.$disconnect();
    process.exit(1);
});
