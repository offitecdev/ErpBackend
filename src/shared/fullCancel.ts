import {
    cancelProjectWithin,
    cancelSalesOrderWithin,
    readInvoiceLifecycle,
    readSalesOrderLifecycle,
} from './documentLifecycle';
import { recordDocumentEvent } from './documentGovernance';
import { CREDIT_KINDS } from './invoiceDrafts';
import {
    creditInvoiceWithin,
    stornoInvoiceWithin,
    type CreditDocumentResult,
} from '../application/use-cases/billing/InvoiceCreditUseCase';

/**
 * ── «GESAMTEN VORGANG STORNIEREN» (17.09.2026, Schritt 6 / F1) ──────────────
 *
 * Der Vorschlag des Kollegen, umgesetzt auf dem bestehenden Storno:
 *
 *   • EIN Knopf nimmt den ganzen Vorgang zurück — Aufträge samt Nachträgen,
 *     ihre Offerten, das Projekt, die künftigen Termine.
 *   • Jede ausgestellte Rechnung wird dabei geregelt: offen → Storno-Rechnung,
 *     bezahlt → Gutschrift (Betrag voreingestellt, änderbar, 0 = die
 *     Buchhaltung regelt es später), Entwurf → verworfen.
 *   • Zuerst eine VORSCHAU (`planFullCancel`), dann die Ausführung in EINER
 *     Transaktion (`executeFullCancel`): scheitert ein Beleg, geschieht nichts.
 *   • Nichts wird gelöscht; jeder Schritt steht im Belegverlauf.
 *
 * Umfang:
 *   ORDER    der Auftrag mit seinen Nachträgen — und das Projekt, wenn es sein
 *            letzter aktiver Auftrag ist (dieselbe Regel wie das Einzelstorno).
 *   PROJECT  jeder aktive Auftrag des Projekts und das Projekt selbst; offene
 *            Rechnungen früher stornierter Aufträge werden mitgeregelt.
 */

type Db = any;

export type FullCancelScope = { kind: 'ORDER'; salesOrderId: string } | { kind: 'PROJECT'; projectId: string };
export type FullCancelInvoiceAction = 'STORNO' | 'GUTSCHRIFT' | 'DISCARD' | 'NONE';
export type FullCancelBlocker = 'NOT_FOUND' | 'NOTHING_TO_CANCEL';

export interface FullCancelPlan {
    scope: FullCancelScope['kind'];
    rootId: string;
    rootNumber: string | null;
    customer: { id: string; companyName: string; email: string | null } | null;
    project: { id: string; projectNumber: string | null; projectName: string; willCancel: boolean } | null;
    orders: Array<{ id: string; orderNumber: string; isAddon: boolean; totalAmount: number }>;
    tenders: Array<{ id: string; tenderNumber: string | null }>;
    invoices: Array<{
        id: string;
        invoiceNumber: string;
        kind: string;
        status: string;
        amount: number;
        salesOrderId: string | null;
        action: FullCancelInvoiceAction;
        /** Bei GUTSCHRIFT: höchstens so viel darf gutgeschrieben werden. */
        creditable: number;
        /** Eingegangenes Geld und offener Rest — die Oberfläche rechnet die Rückzahlung. */
        paidAmount: number;
        openAmount: number;
    }>;
    upcomingAppointmentIds: string[];
    /** Aufträge (Hauptaufträge), die der Reihe nach storniert werden. */
    mainOrderIds: string[];
    /** Alle Auftragskennungen im Umfang (für Absagen und Rechnungen). */
    familyIds: string[];
    needsInvoiceRight: boolean;
    blockers: FullCancelBlocker[];
}

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export const planFullCancel = async (db: Db, tenantId: string, scope: FullCancelScope): Promise<FullCancelPlan> => {
    const empty = (blocker: FullCancelBlocker): FullCancelPlan => ({
        scope: scope.kind,
        rootId: scope.kind === 'ORDER' ? scope.salesOrderId : scope.projectId,
        rootNumber: null,
        customer: null,
        project: null,
        orders: [],
        tenders: [],
        invoices: [],
        upcomingAppointmentIds: [],
        mainOrderIds: [],
        familyIds: [],
        needsInvoiceRight: false,
        blockers: [blocker],
    });

    let project: any = null;
    let projectWillCancel = false;
    let rootNumber: string | null = null;
    let customerId: string | null = null;
    const mainOrderIds: string[] = [];
    const familyIds = new Set<string>();
    /** Aufträge, deren Rechnungen mitgeregelt werden (auch früher stornierte). */
    const invoiceOrderIds = new Set<string>();

    if (scope.kind === 'ORDER') {
        const order = await db.salesOrder.findFirst({ where: { id: scope.salesOrderId, tenantId } });
        if (!order) return empty('NOT_FOUND');
        rootNumber = order.orderNumber;
        customerId = order.customerId ?? null;
        const lifecycle = await readSalesOrderLifecycle(db, order, tenantId);
        lifecycle.familyIds.forEach((id) => { invoiceOrderIds.add(id); });
        if (!lifecycle.cancelled) {
            mainOrderIds.push(order.id);
            lifecycle.familyIds.forEach((id) => { familyIds.add(id); });
        }
        if (order.projectId && !order.parentSalesOrderId && lifecycle.lastOfProject) {
            project = await db.project.findFirst({ where: { id: order.projectId, tenantId } });
            projectWillCancel = Boolean(project && !project.cancelledAt && project.status !== 'CANCELLED');
        }
    } else {
        project = await db.project.findFirst({ where: { id: scope.projectId, tenantId } });
        if (!project) return empty('NOT_FOUND');
        rootNumber = project.projectNumber ?? null;
        customerId = project.customerId ?? null;
        projectWillCancel = !project.cancelledAt && project.status !== 'CANCELLED';
        const all: any[] = await db.salesOrder.findMany({
            where: { projectId: project.id, tenantId },
            select: { id: true, parentSalesOrderId: true, cancelledAt: true, status: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
        });
        all.forEach((row) => { invoiceOrderIds.add(row.id); });
        for (const row of all) {
            if (row.parentSalesOrderId) continue;
            if (row.cancelledAt || row.status === 'CANCELLED') continue;
            mainOrderIds.push(row.id);
            const lifecycle = await readSalesOrderLifecycle(db, row, tenantId);
            lifecycle.familyIds.forEach((id) => { familyIds.add(id); });
        }
    }

    const orders: any[] = familyIds.size
        ? await db.salesOrder.findMany({
            where: { id: { in: [...familyIds] }, tenantId },
            select: {
                id: true, orderNumber: true, parentSalesOrderId: true, totalAmount: true,
                tender: { select: { id: true, tenderNumber: true, status: true } },
            },
            orderBy: [{ parentSalesOrderId: 'asc' }, { createdAt: 'asc' }],
        })
        : [];

    const invoiceScope: any[] = [];
    if (invoiceOrderIds.size) invoiceScope.push({ salesOrderId: { in: [...invoiceOrderIds] } });
    if (project && projectWillCancel) invoiceScope.push({ projectId: project.id });
    const invoiceRows: any[] = invoiceScope.length
        ? await db.invoice.findMany({
            where: {
                tenantId,
                OR: invoiceScope,
                status: { in: ['DRAFT', 'ISSUED', 'PAID'] },
                kind: { notIn: [...CREDIT_KINDS] },
            },
            orderBy: { createdAt: 'asc' },
            select: { id: true, tenantId: true, invoiceNumber: true, kind: true, status: true, amount: true, salesOrderId: true },
        })
        : [];
    const invoices: FullCancelPlan['invoices'] = [];
    for (const row of invoiceRows) {
        let action: FullCancelInvoiceAction = 'NONE';
        let creditable = 0;
        let paidAmount = 0;
        let openAmount = 0;
        if (row.status === 'DRAFT') action = 'DISCARD';
        else {
            // Ohne Zahlung und Gutschrift → Storno-Rechnung; sonst Gutschrift
            // (verrechnet den offenen Rest, zurückgezahlt wird das Eingegangene).
            const lifecycle = await readInvoiceLifecycle(db, row);
            paidAmount = lifecycle.paidAmount;
            openAmount = lifecycle.openAmount;
            if (lifecycle.canCancel) action = 'STORNO';
            else if (lifecycle.canCredit) {
                creditable = lifecycle.creditableAmount;
                action = 'GUTSCHRIFT';
            }
        }
        invoices.push({
            id: row.id,
            invoiceNumber: row.invoiceNumber,
            kind: row.kind,
            status: row.status,
            amount: round2(Number(row.amount || 0)),
            salesOrderId: row.salesOrderId ?? null,
            action,
            creditable,
            paidAmount,
            openAmount,
        });
    }

    const appointmentScope: any[] = [];
    if (familyIds.size) appointmentScope.push({ salesOrderId: { in: [...familyIds] } });
    if (project && projectWillCancel) appointmentScope.push({ projectId: project.id, salesOrderId: null });
    const upcoming: any[] = appointmentScope.length
        ? await db.appointment.findMany({
            where: { tenantId, startTime: { gte: new Date() }, NOT: { status: 'CANCELLED' }, OR: appointmentScope },
            select: { id: true },
        })
        : [];

    const customer = customerId
        ? await db.customer.findFirst({
            where: { id: customerId, tenantId },
            select: { id: true, companyName: true, mainEmail: true },
        })
        : null;

    const tenders = orders
        .filter((row) => !row.parentSalesOrderId && row.tender && row.tender.status !== 'Cancelled')
        .map((row) => ({ id: row.tender.id, tenderNumber: row.tender.tenderNumber ?? null }));

    const plan: FullCancelPlan = {
        scope: scope.kind,
        rootId: scope.kind === 'ORDER' ? scope.salesOrderId : scope.projectId,
        rootNumber,
        customer: customer ? { id: customer.id, companyName: customer.companyName, email: customer.mainEmail ?? null } : null,
        project: project
            ? { id: project.id, projectNumber: project.projectNumber ?? null, projectName: project.projectName, willCancel: projectWillCancel }
            : null,
        orders: orders.map((row) => ({
            id: row.id,
            orderNumber: row.orderNumber,
            isAddon: Boolean(row.parentSalesOrderId),
            totalAmount: round2(Number(row.totalAmount || 0)),
        })),
        tenders,
        invoices,
        upcomingAppointmentIds: upcoming.map((row) => row.id),
        mainOrderIds,
        familyIds: [...familyIds],
        needsInvoiceRight: invoices.some((row) => row.action === 'STORNO' || row.action === 'GUTSCHRIFT'),
        blockers: [],
    };
    const nothing = !mainOrderIds.length && !projectWillCancel
        && !invoices.some((row) => row.action !== 'NONE');
    if (nothing) plan.blockers.push('NOTHING_TO_CANCEL');
    return plan;
};

export interface FullCancelResult {
    documents: CreditDocumentResult[];
    salesOrderIds: string[];
    projectCancelled: boolean;
    cancelledAppointmentIds: string[];
}

/**
 * Ausführen — IMMER in EINER Transaktion. Der Plan wird darin neu gelesen,
 * damit zwischen Vorschau und Klick nichts unbemerkt dazwischenkommt.
 * `credits`: Rechnungskennung → gutzuschreibender Betrag (0 = keine Gutschrift).
 */
export const executeFullCancel = async (
    tx: Db,
    opts: {
        tenantId: string;
        scope: FullCancelScope;
        reason: string;
        credits: Record<string, number>;
        actor: { employeeId: string; ip?: string | null };
        /** Was die Vorschau zeigte — weicht der neue Stand ab, wird abgebrochen. */
        expectedInvoiceIds?: string[];
    },
): Promise<FullCancelResult> => {
    const { tenantId, scope, reason, credits, actor } = opts;
    const plan = await planFullCancel(tx, tenantId, scope);
    if (plan.blockers.length) {
        throw Object.assign(new Error('Für diesen Vorgang gibt es nichts mehr zu stornieren.'), {
            status: 409, code: plan.blockers[0], blockers: plan.blockers,
        });
    }
    if (opts.expectedInvoiceIds) {
        const now = plan.invoices.filter((row) => row.action !== 'NONE').map((row) => row.id).sort().join(',');
        const before = [...opts.expectedInvoiceIds].sort().join(',');
        if (now !== before) {
            throw Object.assign(new Error('Die Rechnungen dieses Vorgangs haben sich inzwischen geändert. Bitte die Vorschau neu laden.'), {
                status: 409, code: 'PLAN_CHANGED',
            });
        }
    }

    // 1. Die Belege: Storno-Rechnung bzw. Gutschrift.
    const documents: CreditDocumentResult[] = [];
    for (const row of plan.invoices) {
        if (row.action === 'STORNO') {
            documents.push(await stornoInvoiceWithin(tx, { invoiceId: row.id, tenantId, reason, actor }));
        } else if (row.action === 'GUTSCHRIFT') {
            const requested = Object.prototype.hasOwnProperty.call(credits, row.id) ? Number(credits[row.id]) : row.creditable;
            if (!Number.isFinite(requested) || requested < 0) {
                throw Object.assign(new Error('Ungültiger Betrag für die Gutschrift.'), { status: 400, code: 'CREDIT_AMOUNT_INVALID' });
            }
            if (requested > 0.005) {
                documents.push(await creditInvoiceWithin(tx, { invoiceId: row.id, tenantId, amount: requested, reason, actor }));
            }
        }
    }

    // 2. Die Aufträge — der Reihe nach; der letzte nimmt das Projekt mit.
    const salesOrderIds: string[] = [];
    const cancelledAppointmentIds: string[] = [];
    let projectCancelled = false;
    for (const orderId of plan.mainOrderIds) {
        const order = await tx.salesOrder.findFirst({ where: { id: orderId, tenantId } });
        if (!order || order.cancelledAt) continue;
        const lifecycle = await readSalesOrderLifecycle(tx, order, tenantId);
        const cancelled = await cancelSalesOrderWithin(tx, { order, tenantId, employeeId: actor.employeeId, reason, lifecycle });
        salesOrderIds.push(...cancelled.salesOrderIds);
        cancelledAppointmentIds.push(...cancelled.cancelledAppointmentIds);
        projectCancelled = projectCancelled || cancelled.projectCancelled;
        await recordDocumentEvent(tx, {
            tenantId,
            entityType: order.parentSalesOrderId ? 'ADDON_ORDER' : 'SALES_ORDER',
            entityId: order.id,
            documentNumber: order.orderNumber,
            action: 'CANCELLED',
            actorId: actor.employeeId,
            reason,
            snapshot: { fullCancel: true, projectCancelled: cancelled.projectCancelled },
            links: { projectId: order.projectId ?? null, tenderId: order.tenderId ?? null },
            ipAddress: actor.ip ?? null,
        });
    }

    // 3. Das Projekt, wenn es noch steht (Projektumfang ohne aktive Aufträge).
    if (plan.project?.willCancel && !projectCancelled) {
        const orphanIds = plan.upcomingAppointmentIds.filter((id) => !cancelledAppointmentIds.includes(id));
        await cancelProjectWithin(tx, {
            projectId: plan.project.id,
            tenantId,
            employeeId: actor.employeeId,
            reason,
            appointmentIds: orphanIds,
        });
        cancelledAppointmentIds.push(...orphanIds);
        projectCancelled = true;
    } else if (plan.project?.willCancel && projectCancelled) {
        // Geparkte Termine ohne Auftrag gehen mit dem Projekt.
        const orphanIds = plan.upcomingAppointmentIds.filter((id) => !cancelledAppointmentIds.includes(id));
        if (orphanIds.length) {
            await tx.appointment.updateMany({ where: { id: { in: orphanIds }, tenantId }, data: { status: 'CANCELLED' } });
            cancelledAppointmentIds.push(...orphanIds);
        }
    }

    // 4. Ein Eintrag für den ganzen Vorgang.
    await recordDocumentEvent(tx, {
        tenantId,
        entityType: scope.kind === 'PROJECT' ? 'PROJECT' : 'SALES_ORDER',
        entityId: plan.rootId,
        documentNumber: plan.rootNumber,
        action: 'FULL_CANCELLED',
        actorId: actor.employeeId,
        reason,
        snapshot: {
            orders: plan.orders.map((row) => row.orderNumber),
            projectCancelled,
            documents: documents.map((doc) => ({ number: doc.invoiceNumber, kind: doc.kind, amount: doc.amount, reverses: doc.reversesNumber })),
            appointments: cancelledAppointmentIds.length,
        },
        links: { projectId: plan.project?.id ?? null },
        ipAddress: actor.ip ?? null,
    });

    return { documents, salesOrderIds, projectCancelled, cancelledAppointmentIds };
};
