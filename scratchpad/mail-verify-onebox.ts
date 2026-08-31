/* Nachweis, dass das Postfach nach dem Umbau in JEDER Firma des Baums
   dasselbe ist — dieselben Abfragen wie die Endpunkte, nur ohne HTTP. */
import dotenv from 'dotenv';
dotenv.config({ path: `${__dirname}/../.env` });
import prisma from '../src/infrastructure/database/prisma.client';
import { getMailTenantId, getCompanyTreeTenantIds } from '../src/presentation/controllers/serviceTenantScope';
import { getAddressBook } from '../src/infrastructure/services/outlook/mailCustomerMatcher';
import { getCategoryIndex } from '../src/infrastructure/services/outlook/mailAutoCategory';

const n = (value: unknown) => Number(value ?? 0);

(async () => {
    const tenants = await prisma.tenant.findMany({ select: { id: true, tenantName: true } });
    for (const tenant of tenants) {
        const mailTenantId = await getMailTenantId(tenant.id);
        const treeIds = await getCompanyTreeTenantIds(tenant.id);
        const [stats] = await prisma.$queryRawUnsafe<any[]>(`
            SELECT SUM(m.deletedAt IS NULL AND m.direction = 'IN')  AS inbox,
                   SUM(m.deletedAt IS NULL AND m.direction = 'OUT') AS sent,
                   SUM(m.deletedAt IS NOT NULL)                     AS bin
              FROM MailMessage m WHERE m.tenantId = ?`, mailTenantId);
        const categories = await prisma.mailCategory.count({ where: { tenantId: mailTenantId } });
        console.log(`\n${tenant.tenantName} (${tenant.id})`);
        console.log(`  Postfach-Mandant : ${mailTenantId}`);
        console.log(`  Firmenbaum       : ${treeIds.join(', ') || '(leer)'}`);
        console.log(`  Posteingang      : ${n(stats?.inbox)}   Gesendet: ${n(stats?.sent)}   Papierkorb: ${n(stats?.bin)}`);
        console.log(`  Kategorien       : ${categories}`);
    }

    // Adressbuch + Kategorienindex, wie der Abruf sie sieht.
    const book = await getAddressBook('main-tenant');
    const index = await getCategoryIndex('main-tenant');
    console.log('\nAdressbuch (aus Sicht von main-tenant, Schlüssel = Stamm)');
    console.log('  Kundenadressen  :', book.byAddress.size);
    console.log('  Firmendomains   :', book.byDomain.size);
    console.log('  Personenadressen:', book.byEmployee.size);
    console.log('  Firmen je Kunde :', book.customerTenantById.size, '| je Person:', book.employeeTenantById.size);
    console.log('  Etiketten       : Kunden', index.byCustomer.size, '/ Personal', index.byStaff.size);

    await prisma.$disconnect();
})();
