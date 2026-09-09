/*
 * Probe der Löschregeln (05.09.2026) — OHNE etwas zu löschen.
 *
 * Jeder Fall läuft in einer eigenen Transaktion, die am Ende absichtlich
 * scheitert: der Endzustand wird INNERHALB gemessen, danach rollt alles zurück.
 */
import prisma from '../src/infrastructure/database/prisma.client';
import { assertSalesOrderDeletable, deleteSalesOrderWithin } from '../src/shared/salesOrderDeletion';

const ROLLBACK = 'ROLLBACK-PROBE';

const probe = async (label: string, orderId: string) => {
    const order: any = await (prisma as any).salesOrder.findFirst({ where: { id: orderId } });
    if (!order) return console.log(`${label}: kein Auftrag ${orderId}`);
    const tenantId = order.tenantId;
    const employee: any = await (prisma as any).employee.findFirst({ where: { tenantId }, select: { id: true } })
        || await (prisma as any).employee.findFirst({ select: { id: true } });

    let checks: any;
    try {
        checks = await assertSalesOrderDeletable(prisma as any, order, tenantId);
    } catch (error: any) {
        return console.log(`${label}: ABGELEHNT — ${error.message}`);
    }

    try {
        await (prisma as any).$transaction(async (tx: any) => {
            const result = await deleteSalesOrderWithin(tx, {
                order,
                tenantId,
                employeeId: employee.id,
                familyIds: checks.familyIds,
                lastOfProject: checks.lastOfProject,
            });

            // Endzustand IN der Transaktion.
            const ordersLeft = order.projectId
                ? await tx.salesOrder.count({ where: { projectId: order.projectId } })
                : null;
            const projectLeft = order.projectId
                ? await tx.project.count({ where: { id: order.projectId } })
                : null;
            const tender: any = order.tenderId
                ? await tx.tender.findUnique({ where: { id: order.tenderId }, select: { status: true, sourceStatus: true, projectId: true } })
                : null;
            const orphan = await tx.salesOrder.count({ where: { id: { in: checks.familyIds } } });

            console.log(`${label}:`);
            console.log(`   Familie ${checks.familyIds.length} | letzter des Projekts: ${checks.lastOfProject}`);
            console.log(`   danach: Aufträge weg = ${orphan === 0} | Aufträge im Projekt = ${ordersLeft} | Projektzeilen = ${projectLeft} | projectDeleted = ${result.projectDeleted}`);
            console.log(`   Offerte: ${tender ? `${tender.status} / ${tender.sourceStatus ?? 'null'} / projectId ${tender.projectId ?? 'null'}` : 'keine'}`);

            throw new Error(ROLLBACK);
        }, { timeout: 120000 });
    } catch (error: any) {
        if (error.message !== ROLLBACK) console.log(`${label}: FEHLER — ${error.message}`);
        else console.log(`${label}: zurückgerollt ✔`);
    }
};

(async () => {
    const args = process.argv.slice(2);
    if (args.length) {
        for (const id of args) await probe(id.slice(0, 8), id);
        await prisma.$disconnect();
        return;
    }

    // Kandidaten suchen: ein Nachtrag, ein Hauptauftrag MIT Nachträgen, ein
    // Projekt mit genau EINEM Auftrag, und ein Lieferauftrag ohne Projekt.
    // Nur UNfakturierte Kandidaten — fakturierte lehnt die Regel ohnehin ab.
    const unbilled = { invoices: { none: {} } };
    const addon: any = await (prisma as any).salesOrder.findFirst({
        where: { parentSalesOrderId: { not: null }, ...unbilled },
        orderBy: { createdAt: 'desc' },
        select: { id: true, orderNumber: true, projectId: true },
    });
    const main: any = addon
        ? await (prisma as any).salesOrder.findFirst({ where: { addonSalesOrders: { some: unbilled }, ...unbilled }, select: { id: true, orderNumber: true } })
        : null;
    const delivery: any = await (prisma as any).salesOrder.findFirst({
        where: { projectId: null, ...unbilled },
        orderBy: { createdAt: 'desc' },
        select: { id: true, orderNumber: true, tenderId: true },
    });

    const grouped: any[] = await (prisma as any).salesOrder.groupBy({
        by: ['projectId'],
        where: { projectId: { not: null }, ...unbilled },
        _count: { _all: true },
    });
    const soloProjectId = grouped.find((row: any) => row._count._all === 1)?.projectId;
    const solo: any = soloProjectId
        ? await (prisma as any).salesOrder.findFirst({ where: { projectId: soloProjectId }, select: { id: true, orderNumber: true } })
        : null;

    console.log('Kandidaten:', {
        nachtrag: addon?.orderNumber, haupt: main?.orderNumber,
        einziger: solo?.orderNumber, lieferauftrag: delivery?.orderNumber,
    });
    console.log('---');

    if (addon) await probe(`NACHTRAG ${addon.orderNumber}`, addon.id);
    if (main) await probe(`HAUPTAUFTRAG+NT ${main.orderNumber}`, main.id);
    if (solo) await probe(`EINZIGER AUFTRAG ${solo.orderNumber}`, solo.id);
    if (delivery) await probe(`LIEFERAUFTRAG ${delivery.orderNumber}`, delivery.id);

    await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
