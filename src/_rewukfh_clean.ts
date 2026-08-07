import 'dotenv/config';
import prisma from './infrastructure/database/prisma.client';

/**
 * Removes the junk token "rewukfh" that was typed into a customer address's
 * Country field and then copied, as formatted text, into tender address slots.
 *
 * Only that token is touched: the tender `lsc5b889Ro` holds other nonsense
 * ("pwoiuefhp", "874374 dfvouie") whose intended value cannot be known, so it
 * is left exactly as it is. Run with APPLY=1 to write; otherwise dry-run.
 */
const NEEDLE = 'rewukfh';
const APPLY = process.env.APPLY === '1';

/** Drops the token from a formatted address: as a trailing ", rewukfh" on a
 *  line, or as a line that is nothing but the token. */
const strip = (value: string): string =>
    value
        .split('\n')
        .map((line) => line.replace(/,\s*rewukfh\s*$/i, '').trim())
        .filter((line) => line.toLowerCase() !== NEEDLE)
        .join('\n');

async function main() {
    console.log(`\n=== cleanup (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);

    const locs = await prisma.customerLocation.findMany({
        where: { country: { contains: NEEDLE } },
        select: { id: true, name: true, country: true },
    });
    for (const l of locs) {
        console.log(`CustomerLocation ${l.id} (${l.name}): country ${JSON.stringify(l.country)} -> null`);
        if (APPLY) await prisma.customerLocation.update({ where: { id: l.id }, data: { country: null } });
    }

    const TFIELDS = ['installationAddress', 'deliveryAddress', 'billingAddress'] as const;
    const tenders = await prisma.tender.findMany({
        where: { OR: TFIELDS.map((f) => ({ [f]: { contains: NEEDLE } })) },
        select: { id: true, installationAddress: true, deliveryAddress: true, billingAddress: true },
    });
    for (const t of tenders) {
        const data: Record<string, string | null> = {};
        for (const f of TFIELDS) {
            const current = (t as any)[f] as string | null;
            if (!current || !current.toLowerCase().includes(NEEDLE)) continue;
            const next = strip(current);
            data[f] = next || null;
            console.log(`Tender ${t.id}.${f}:\n    ${JSON.stringify(current)}\n -> ${JSON.stringify(data[f])}`);
        }
        if (APPLY && Object.keys(data).length) await prisma.tender.update({ where: { id: t.id }, data });
    }

    console.log(`\n=== ${APPLY ? 'written' : 'nothing written (set APPLY=1)'} ===\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
