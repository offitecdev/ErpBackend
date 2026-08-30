/* Automatisches Etikett (30.08.2026): was WÜRDE eingesammelt? Nur lesen —
   zeigt je Kategorie, wie viele gespeicherte Nachrichten sie beim Anlegen
   rückwirkend bekommen hätte, und was der nächste Abruf künftig einsortiert. */
import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';

(async () => {
    const categories = await prisma.mailCategory.findMany({
        select: { id: true, tenantId: true, kind: true, entityId: true, name: true },
        orderBy: { displayOrder: 'asc' },
    });
    console.log(`Kategorien: ${categories.length}`);
    for (const cat of categories) {
        if (!cat.entityId || (cat.kind !== 'CUSTOMER' && cat.kind !== 'STAFF')) {
            console.log(`  ${cat.kind.padEnd(8)} ${cat.name} — (kein automatisches Etikett)`);
            continue;
        }
        const where = cat.kind === 'CUSTOMER'
            ? { tenantId: cat.tenantId, customerId: cat.entityId }
            : { tenantId: cat.tenantId, employeeId: cat.entityId, matchSource: 'AUTO_EMPLOYEE' };
        const [total, unlabelled, mine] = await Promise.all([
            prisma.mailMessage.count({ where }),
            prisma.mailMessage.count({ where: { ...where, categoryId: null } }),
            prisma.mailMessage.count({ where: { ...where, categoryId: cat.id } }),
        ]);
        console.log(`  ${cat.kind.padEnd(8)} ${cat.name} — ${total} passende, davon ${mine} bereits etikettiert, ${unlabelled} ohne Etikett (würden eingesammelt)`);
    }

    /* Gegenprobe: wie viel Post hängt an einem Kunden, für den es (noch) keine
       Kategorie gibt? Das bleibt bewusst liegen — angelegt wird nichts. */
    const byCustomer = await prisma.$queryRaw<Array<{ tenantId: string; companyName: string; mails: bigint }>>`
        SELECT m.tenantId, cu.companyName, COUNT(*) AS mails
        FROM MailMessage m
        JOIN Customer cu ON cu.id = m.customerId
        LEFT JOIN MailCategory mc ON mc.tenantId = m.tenantId AND mc.kind = 'CUSTOMER' AND mc.entityId = m.customerId
        WHERE m.categoryId IS NULL AND mc.id IS NULL
        GROUP BY m.tenantId, cu.companyName
        ORDER BY mails DESC
        LIMIT 15`;
    console.log('\nKunden MIT Post, aber OHNE Kategorie (Top 15):');
    for (const row of byCustomer) console.log(`  ${row.companyName}: ${Number(row.mails)}`);

    await prisma.$disconnect();
})();
