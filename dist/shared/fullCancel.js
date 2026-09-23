"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.executeFullCancel = exports.planFullCancel = void 0;
const documentLifecycle_1 = require("./documentLifecycle");
const documentGovernance_1 = require("./documentGovernance");
const invoiceDrafts_1 = require("./invoiceDrafts");
const InvoiceCreditUseCase_1 = require("../application/use-cases/billing/InvoiceCreditUseCase");
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const planFullCancel = async (db, tenantId, scope) => {
    const empty = (blocker) => ({
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
    let project = null;
    let projectWillCancel = false;
    let rootNumber = null;
    let customerId = null;
    const mainOrderIds = [];
    const familyIds = new Set();
    /** Aufträge, deren Rechnungen mitgeregelt werden (auch früher stornierte). */
    const invoiceOrderIds = new Set();
    if (scope.kind === 'ORDER') {
        const order = await db.salesOrder.findFirst({ where: { id: scope.salesOrderId, tenantId } });
        if (!order)
            return empty('NOT_FOUND');
        rootNumber = order.orderNumber;
        customerId = order.customerId ?? null;
        const lifecycle = await (0, documentLifecycle_1.readSalesOrderLifecycle)(db, order, tenantId);
        lifecycle.familyIds.forEach((id) => { invoiceOrderIds.add(id); });
        if (!lifecycle.cancelled) {
            mainOrderIds.push(order.id);
            lifecycle.familyIds.forEach((id) => { familyIds.add(id); });
        }
        if (order.projectId && !order.parentSalesOrderId && lifecycle.lastOfProject) {
            project = await db.project.findFirst({ where: { id: order.projectId, tenantId } });
            projectWillCancel = Boolean(project && !project.cancelledAt && project.status !== 'CANCELLED');
        }
    }
    else {
        project = await db.project.findFirst({ where: { id: scope.projectId, tenantId } });
        if (!project)
            return empty('NOT_FOUND');
        rootNumber = project.projectNumber ?? null;
        customerId = project.customerId ?? null;
        projectWillCancel = !project.cancelledAt && project.status !== 'CANCELLED';
        const all = await db.salesOrder.findMany({
            where: { projectId: project.id, tenantId },
            select: { id: true, parentSalesOrderId: true, cancelledAt: true, status: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
        });
        all.forEach((row) => { invoiceOrderIds.add(row.id); });
        for (const row of all) {
            if (row.parentSalesOrderId)
                continue;
            if (row.cancelledAt || row.status === 'CANCELLED')
                continue;
            mainOrderIds.push(row.id);
            const lifecycle = await (0, documentLifecycle_1.readSalesOrderLifecycle)(db, row, tenantId);
            lifecycle.familyIds.forEach((id) => { familyIds.add(id); });
        }
    }
    const orders = familyIds.size
        ? await db.salesOrder.findMany({
            where: { id: { in: [...familyIds] }, tenantId },
            select: {
                id: true, orderNumber: true, parentSalesOrderId: true, totalAmount: true,
                tender: { select: { id: true, tenderNumber: true, status: true } },
            },
            orderBy: [{ parentSalesOrderId: 'asc' }, { createdAt: 'asc' }],
        })
        : [];
    const invoiceScope = [];
    if (invoiceOrderIds.size)
        invoiceScope.push({ salesOrderId: { in: [...invoiceOrderIds] } });
    if (project && projectWillCancel)
        invoiceScope.push({ projectId: project.id });
    const invoiceRows = invoiceScope.length
        ? await db.invoice.findMany({
            where: {
                tenantId,
                OR: invoiceScope,
                status: { in: ['DRAFT', 'ISSUED', 'PAID'] },
                kind: { notIn: [...invoiceDrafts_1.CREDIT_KINDS] },
            },
            orderBy: { createdAt: 'asc' },
            select: { id: true, tenantId: true, invoiceNumber: true, kind: true, status: true, amount: true, salesOrderId: true },
        })
        : [];
    const invoices = [];
    for (const row of invoiceRows) {
        let action = 'NONE';
        let creditable = 0;
        let paidAmount = 0;
        let openAmount = 0;
        if (row.status === 'DRAFT')
            action = 'DISCARD';
        else {
            // Ohne Zahlung und Gutschrift → Storno-Rechnung; sonst Gutschrift
            // (verrechnet den offenen Rest, zurückgezahlt wird das Eingegangene).
            const lifecycle = await (0, documentLifecycle_1.readInvoiceLifecycle)(db, row);
            paidAmount = lifecycle.paidAmount;
            openAmount = lifecycle.openAmount;
            if (lifecycle.canCancel)
                action = 'STORNO';
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
    const appointmentScope = [];
    if (familyIds.size)
        appointmentScope.push({ salesOrderId: { in: [...familyIds] } });
    if (project && projectWillCancel)
        appointmentScope.push({ projectId: project.id, salesOrderId: null });
    const upcoming = appointmentScope.length
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
    const plan = {
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
    if (nothing)
        plan.blockers.push('NOTHING_TO_CANCEL');
    return plan;
};
exports.planFullCancel = planFullCancel;
/**
 * Ausführen — IMMER in EINER Transaktion. Der Plan wird darin neu gelesen,
 * damit zwischen Vorschau und Klick nichts unbemerkt dazwischenkommt.
 * `credits`: Rechnungskennung → gutzuschreibender Betrag (0 = keine Gutschrift).
 */
const executeFullCancel = async (tx, opts) => {
    const { tenantId, scope, reason, credits, actor } = opts;
    const plan = await (0, exports.planFullCancel)(tx, tenantId, scope);
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
    const documents = [];
    for (const row of plan.invoices) {
        if (row.action === 'STORNO') {
            documents.push(await (0, InvoiceCreditUseCase_1.stornoInvoiceWithin)(tx, { invoiceId: row.id, tenantId, reason, actor }));
        }
        else if (row.action === 'GUTSCHRIFT') {
            const requested = Object.prototype.hasOwnProperty.call(credits, row.id) ? Number(credits[row.id]) : row.creditable;
            if (!Number.isFinite(requested) || requested < 0) {
                throw Object.assign(new Error('Ungültiger Betrag für die Gutschrift.'), { status: 400, code: 'CREDIT_AMOUNT_INVALID' });
            }
            if (requested > 0.005) {
                documents.push(await (0, InvoiceCreditUseCase_1.creditInvoiceWithin)(tx, { invoiceId: row.id, tenantId, amount: requested, reason, actor }));
            }
        }
    }
    // 2. Die Aufträge — der Reihe nach; der letzte nimmt das Projekt mit.
    const salesOrderIds = [];
    const cancelledAppointmentIds = [];
    let projectCancelled = false;
    for (const orderId of plan.mainOrderIds) {
        const order = await tx.salesOrder.findFirst({ where: { id: orderId, tenantId } });
        if (!order || order.cancelledAt)
            continue;
        const lifecycle = await (0, documentLifecycle_1.readSalesOrderLifecycle)(tx, order, tenantId);
        const cancelled = await (0, documentLifecycle_1.cancelSalesOrderWithin)(tx, { order, tenantId, employeeId: actor.employeeId, reason, lifecycle });
        salesOrderIds.push(...cancelled.salesOrderIds);
        cancelledAppointmentIds.push(...cancelled.cancelledAppointmentIds);
        projectCancelled = projectCancelled || cancelled.projectCancelled;
        await (0, documentGovernance_1.recordDocumentEvent)(tx, {
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
        await (0, documentLifecycle_1.cancelProjectWithin)(tx, {
            projectId: plan.project.id,
            tenantId,
            employeeId: actor.employeeId,
            reason,
            appointmentIds: orphanIds,
        });
        cancelledAppointmentIds.push(...orphanIds);
        projectCancelled = true;
    }
    else if (plan.project?.willCancel && projectCancelled) {
        // Geparkte Termine ohne Auftrag gehen mit dem Projekt.
        const orphanIds = plan.upcomingAppointmentIds.filter((id) => !cancelledAppointmentIds.includes(id));
        if (orphanIds.length) {
            await tx.appointment.updateMany({ where: { id: { in: orphanIds }, tenantId }, data: { status: 'CANCELLED' } });
            cancelledAppointmentIds.push(...orphanIds);
        }
    }
    // 4. Ein Eintrag für den ganzen Vorgang.
    await (0, documentGovernance_1.recordDocumentEvent)(tx, {
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
exports.executeFullCancel = executeFullCancel;
//# sourceMappingURL=fullCancel.js.map