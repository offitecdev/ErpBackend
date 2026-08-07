"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const prisma_client_1 = __importDefault(require("./infrastructure/database/prisma.client"));
const NEEDLE = process.env.SCAN_NEEDLE || 'rewukfh';
const ADDR = ['address', 'addressSupplement', 'postalCode', 'city', 'state', 'country'];
const hits = (row, keys) => keys.filter((k) => String(row[k] ?? '').toLowerCase().includes(NEEDLE.toLowerCase()));
async function main() {
    console.log(`\n=== scanning for "${NEEDLE}" ===\n`);
    const locs = await prisma_client_1.default.customerLocation.findMany({
        where: { OR: ADDR.map((f) => ({ [f]: { contains: NEEDLE } })) },
        include: { customer: { select: { id: true, companyName: true, tenantId: true } } },
    });
    console.log(`CustomerLocation: ${locs.length} row(s)`);
    for (const l of locs) {
        console.log(`  id=${l.id} name=${JSON.stringify(l.name)} kind=${l.kind} customer=${l.customer?.companyName} (${l.customerId}) tenant=${l.customer?.tenantId}`);
        console.log(`    match: ${hits(l, ADDR).map((f) => `${f}=${JSON.stringify(l[f])}`).join(', ')}`);
        console.log(`    full : ${JSON.stringify(Object.fromEntries(ADDR.map((f) => [f, l[f]])))}`);
    }
    const custs = await prisma_client_1.default.customer.findMany({
        where: { OR: [...ADDR, 'addressName'].map((f) => ({ [f]: { contains: NEEDLE } })) },
        select: { id: true, companyName: true, tenantId: true, addressName: true, address: true, addressSupplement: true, postalCode: true, city: true, state: true, country: true },
    });
    console.log(`\nCustomer (main address): ${custs.length} row(s)`);
    for (const c of custs) {
        console.log(`  id=${c.id} ${c.companyName} tenant=${c.tenantId}`);
        console.log(`    match: ${hits(c, [...ADDR, 'addressName']).map((f) => `${f}=${JSON.stringify(c[f])}`).join(', ')}`);
    }
    const TFIELDS = ['installationAddress', 'deliveryAddress', 'billingAddress'];
    const tenders = await prisma_client_1.default.tender.findMany({
        where: { OR: TFIELDS.map((f) => ({ [f]: { contains: NEEDLE } })) },
        select: { id: true, tenantId: true, installationAddress: true, deliveryAddress: true, billingAddress: true },
    });
    console.log(`\nTender (stored slots): ${tenders.length} row(s)`);
    for (const t of tenders) {
        console.log(`  id=${t.id} tenant=${t.tenantId}`);
        console.log(`    match: ${hits(t, TFIELDS).map((f) => `${f}=${JSON.stringify(t[f])}`).join(' | ')}`);
    }
    console.log('\n=== end ===\n');
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma_client_1.default.$disconnect());
//# sourceMappingURL=_rewukfh_scan.js.map