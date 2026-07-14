/**
 * One-off back-fill: recompute every tender-based sales order's `totalAmount`
 * (Bestellbetrag / Bestellsumme) so it reflects the final amount incl. VAT and
 * the direct discount — matching the tender offer summary — instead of the bare
 * net sum older orders were stored with.
 *
 * Only base orders created from a tender are touched. Addon orders
 * (parentSalesOrderId set) carry extra-work amounts, not a tender total, and are
 * left untouched. When the order created a project, its plannedBudget is realigned
 * to the recomputed total too.
 *
 * Run:  npx ts-node scripts/recompute-order-totals.ts        (apply)
 *       npx ts-node scripts/recompute-order-totals.ts --dry  (preview only)
 */
import 'dotenv/config';
import prisma from '../src/infrastructure/database/prisma.client';
import { orderTotal } from '../src/presentation/controllers/salesOrder.pricing';

const DRY_RUN = process.argv.includes('--dry');

async function main() {
    const orders = await (prisma as any).salesOrder.findMany({
        where: { parentSalesOrderId: null, tenderId: { not: null } },
        select: { id: true, orderNumber: true, totalAmount: true, projectId: true, tenderId: true },
    });

    console.log(`[recompute] ${orders.length} base tender order(s) found${DRY_RUN ? ' (dry run)' : ''}`);

    let changed = 0;
    for (const order of orders) {
        const tender: any = await (prisma as any).tender.findUnique({
            where: { id: order.tenderId },
            include: { positions: { include: { calculation: true } } },
        });
        if (!tender) {
            console.warn(`  · ${order.orderNumber}: tender ${order.tenderId} missing — skipped`);
            continue;
        }

        const next = orderTotal(tender.positions || [], tender.directDiscount);
        const prev = Number(order.totalAmount || 0);
        // Skip no-op updates (allow for float noise).
        if (Math.abs(next - prev) < 0.005) continue;

        changed++;
        console.log(`  · ${order.orderNumber}: ${prev.toFixed(2)} -> ${next.toFixed(2)}`);
        if (DRY_RUN) continue;

        await (prisma as any).salesOrder.update({ where: { id: order.id }, data: { totalAmount: next } });
        if (order.projectId) {
            await (prisma as any).project.update({ where: { id: order.projectId }, data: { plannedBudget: next } });
        }
    }

    console.log(`[recompute] ${DRY_RUN ? 'would update' : 'updated'} ${changed} order(s)`);
}

main()
    .catch((error) => {
        console.error('[recompute] failed:', error);
        process.exitCode = 1;
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
