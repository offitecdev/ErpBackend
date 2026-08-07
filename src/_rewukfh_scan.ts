import 'dotenv/config';
import prisma from './infrastructure/database/prisma.client';

const NEEDLE = process.env.SCAN_NEEDLE || 'rewukfh';

const ADDR = ['address', 'addressSupplement', 'postalCode', 'city', 'state', 'country'] as const;

const hits = (row: any, keys: readonly string[]) =>
    keys.filter((k) => String(row[k] ?? '').toLowerCase().includes(NEEDLE.toLowerCase()));

async function main() {
    console.log(`\n=== scanning for "${NEEDLE}" ===\n`);

    const locs = await prisma.customerLocation.findMany({
        where: { OR: ADDR.map((f) => ({ [f]: { contains: NEEDLE } })) },
        include: { customer: { select: { id: true, companyName: true, tenantId: true } } },
    });
    console.log(`CustomerLocation: ${locs.length} row(s)`);
    for (const l of locs) {
        console.log(`  id=${l.id} name=${JSON.stringify(l.name)} kind=${l.kind} customer=${l.customer?.companyName} (${l.customerId}) tenant=${l.customer?.tenantId}`);
        console.log(`    match: ${hits(l, ADDR).map((f) => `${f}=${JSON.stringify((l as any)[f])}`).join(', ')}`);
        console.log(`    full : ${JSON.stringify(Object.fromEntries(ADDR.map((f) => [f, (l as any)[f]])))}`);
    }

    const custs = await prisma.customer.findMany({
        where: { OR: [...ADDR, 'addressName'].map((f) => ({ [f]: { contains: NEEDLE } })) },
        select: { id: true, companyName: true, tenantId: true, addressName: true, address: true, addressSupplement: true, postalCode: true, city: true, state: true, country: true },
    });
    console.log(`\nCustomer (main address): ${custs.length} row(s)`);
    for (const c of custs) {
        console.log(`  id=${c.id} ${c.companyName} tenant=${c.tenantId}`);
        console.log(`    match: ${hits(c, [...ADDR, 'addressName']).map((f) => `${f}=${JSON.stringify((c as any)[f])}`).join(', ')}`);
    }

    const TFIELDS = ['installationAddress', 'deliveryAddress', 'billingAddress'] as const;
    const tenders = await prisma.tender.findMany({
        where: { OR: TFIELDS.map((f) => ({ [f]: { contains: NEEDLE } })) },
        select: { id: true, tenantId: true, installationAddress: true, deliveryAddress: true, billingAddress: true },
    });
    console.log(`\nTender (stored slots): ${tenders.length} row(s)`);
    for (const t of tenders) {
        console.log(`  id=${t.id} tenant=${t.tenantId}`);
        console.log(`    match: ${hits(t, TFIELDS).map((f) => `${f}=${JSON.stringify((t as any)[f])}`).join(' | ')}`);
    }

    console.log('\n=== end ===\n');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
