"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.salesOrderFamilyIds = exports.revertTendersToDraft = exports.purgeProjectWithin = exports.uncancelProjectWithin = exports.cancelProjectWithin = exports.assertProjectCancellable = exports.assertProjectDeletable = exports.readProjectLifecycle = exports.uncancelTenderWithin = exports.cancelTenderWithin = exports.assertTenderCancellable = exports.assertTenderDeletable = exports.readTenderLifecycle = exports.uncancelSalesOrderWithin = exports.cancelSalesOrderWithin = exports.revertSalesOrderToDraftWithin = exports.assertSalesOrderCancellable = exports.assertSalesOrderRevertible = exports.readSalesOrderLifecycle = exports.countSalesOrderLinks = void 0;
const nanoid_1 = require("nanoid");
const salesOrderDeletion_1 = require("./salesOrderDeletion");
Object.defineProperty(exports, "purgeProjectWithin", { enumerable: true, get: function () { return salesOrderDeletion_1.purgeProjectWithin; } });
Object.defineProperty(exports, "revertTendersToDraft", { enumerable: true, get: function () { return salesOrderDeletion_1.revertTendersToDraft; } });
Object.defineProperty(exports, "salesOrderFamilyIds", { enumerable: true, get: function () { return salesOrderDeletion_1.salesOrderFamilyIds; } });
/**
 * Alles zählen, was an diesem Auftrag (und seinen Nachträgen) hängt.
 *
 * Die Zählungen laufen PARALLEL: die Datenbank ist entfernt (~45 ms je
 * Anweisung), nacheinander wäre das eine halbe Sekunde für eine Frage, die die
 * Oberfläche bei jedem Öffnen eines Auftrags stellt.
 */
const countSalesOrderLinks = async (db, opts) => {
    const { familyIds, projectId, tenantId } = opts;
    const inFamily = { in: familyIds };
    const now = new Date();
    const [invoices, reports, deliveryReports, stockMovements, extraMaterials, expenses, startedAppointments, upcomingAppointments, addons] = await Promise.all([
        db.invoice.count({ where: { salesOrderId: inFamily } }),
        db.projectReport.count({ where: { salesOrderId: inFamily } }),
        db.deliveryReport.count({ where: { salesOrderId: inFamily, tenantId } }),
        // Lagerbewegungen tragen als Referenz die Projekt-, Nachtrags- oder
        // Offertkennung (siehe die Aufrufer von `adjustArticleStock`): die
        // Familie deckt den Nachtragsfall ab, das Projekt den Montagefall.
        db.stockMovement.count({
            where: { tenantId, referenceId: { in: projectId ? [...familyIds, projectId] : familyIds } },
        }),
        db.projectExtraMaterial.count({ where: { salesOrderId: inFamily } }),
        // Spesen sind erfasste Arbeit: sie fielen beim Zuruecksetzen mit, also
        // sperren sie es (das Storno laesst sie stehen).
        db.projectExpense.count({ where: { salesOrderId: inFamily } }),
        db.appointment.count({
            where: {
                salesOrderId: inFamily,
                OR: [{ status: 'COMPLETED' }, { startTime: { lt: now } }],
            },
        }),
        db.appointment.count({
            where: { salesOrderId: inFamily, startTime: { gte: now }, NOT: { status: 'CANCELLED' } },
        }),
        db.salesOrder.count({ where: { parentSalesOrderId: { in: familyIds }, tenantId } }),
    ]);
    return {
        invoices, reports, deliveryReports, stockMovements, extraMaterials,
        expenses, startedAppointments, upcomingAppointments, addons,
    };
};
exports.countSalesOrderLinks = countSalesOrderLinks;
/**
 * Was mit diesem Auftrag geschehen darf. EINE Abfragerunde, und beide Antworten
 * («zurück in Entwurf» und «stornieren») kommen daraus — die Oberfläche fragt
 * das beim Öffnen einmal und weiss dann, welche Knöpfe sie zeigt.
 */
const readSalesOrderLifecycle = async (db, order, tenantId) => {
    const familyIds = await (0, salesOrderDeletion_1.salesOrderFamilyIds)(db, order, tenantId);
    const counts = await (0, exports.countSalesOrderLinks)(db, { familyIds, projectId: order.projectId ?? null, tenantId });
    const cancelled = Boolean(order.cancelledAt) || String(order.status || '') === 'CANCELLED';
    // «Letzter Auftrag des Projekts» zählt nur AKTIVE Geschwister: ein bereits
    // stornierter Auftrag hält das Projekt nicht am Leben.
    let lastOfProject = false;
    if (order.projectId) {
        const remaining = await db.salesOrder.count({
            where: {
                projectId: order.projectId,
                tenantId,
                cancelledAt: null,
                NOT: { id: { in: familyIds } },
            },
        });
        lastOfProject = remaining === 0;
    }
    const revertBlockers = [];
    if (cancelled)
        revertBlockers.push('CANCELLED');
    if (counts.invoices > 0)
        revertBlockers.push('INVOICE');
    if (counts.reports > 0)
        revertBlockers.push('REPORT');
    if (counts.deliveryReports > 0)
        revertBlockers.push('DELIVERY_REPORT');
    if (counts.stockMovements > 0 || counts.extraMaterials > 0)
        revertBlockers.push('STOCK_MOVEMENT');
    if (counts.expenses > 0)
        revertBlockers.push('EXPENSE');
    if (counts.startedAppointments > 0)
        revertBlockers.push('MONTAGE_STARTED');
    if (counts.addons > 0)
        revertBlockers.push('ADDON');
    const cancelBlockers = cancelled ? ['CANCELLED'] : [];
    return {
        familyIds,
        lastOfProject,
        cancelled,
        counts,
        revertBlockers,
        cancelBlockers,
        canRevertToDraft: revertBlockers.length === 0,
        canCancel: cancelBlockers.length === 0,
    };
};
exports.readSalesOrderLifecycle = readSalesOrderLifecycle;
/** Wirft mit `status`, damit der Aufrufer die Meldung unverändert weiterreicht. */
const refuse = (message, blockers, status = 400) => Object.assign(new Error(message), { status, blockers });
const assertSalesOrderRevertible = (lifecycle) => {
    if (lifecycle.canRevertToDraft)
        return;
    throw refuse('Dieser Auftrag kann nicht mehr in den Entwurf zurueck — er ist bereits in Arbeit. Stornieren Sie ihn stattdessen.', lifecycle.revertBlockers);
};
exports.assertSalesOrderRevertible = assertSalesOrderRevertible;
const assertSalesOrderCancellable = (lifecycle) => {
    if (lifecycle.canCancel)
        return;
    throw refuse('Dieser Auftrag ist bereits storniert.', lifecycle.cancelBlockers);
};
exports.assertSalesOrderCancellable = assertSalesOrderCancellable;
/**
 * ZURÜCK IN ENTWURF. Der Auftrag verschwindet, seine Offerte wird wieder ein
 * Entwurf — und wenn er der letzte des Projekts war, geht das PROJEKT NICHT
 * MIT: es fällt zurück in die Planung (Vorgabe Samet 06.09.2026, ausdrücklich
 * anders als beim früheren Löschen). Damit die freigewordene Offerte danach
 * erneut erteilt werden kann, wird ihre Verknüpfung am Projekt gelöst —
 * `Project.tenderId` ist eindeutig, ein stehengebliebener Verweis liesse
 * «neues Projekt» beim zweiten Anlauf auf einen Schlüsselkonflikt laufen.
 *
 * IMMER innerhalb einer Transaktion aufrufen; `assertSalesOrderRevertible` muss
 * vorher gelaufen sein.
 */
const revertSalesOrderToDraftWithin = async (tx, opts) => {
    const { order, tenantId, employeeId, lifecycle } = opts;
    const projectId = order.projectId || null;
    // Das Entfernen selbst bleibt an EINER Stelle (Lagerrückgabe, Sätze,
    // Nachträge). Das Projekt fasst es NICHT an — was mit ihm geschieht,
    // entscheidet der Block darunter.
    const { addonIds } = await (0, salesOrderDeletion_1.deleteSalesOrderWithin)(tx, {
        order,
        tenantId,
        employeeId,
        familyIds: lifecycle.familyIds,
    });
    let projectReverted = false;
    if (projectId && lifecycle.lastOfProject) {
        const project = await tx.project.findFirst({
            where: { id: projectId, tenantId },
            select: { id: true, tenderId: true, status: true },
        });
        if (project) {
            await tx.project.update({
                where: { id: projectId },
                data: {
                    status: 'AWAITING_APPROVAL',
                    // Die Offerte ist wieder frei; das Projekt behält seine
                    // eigene Nummer und wartet als leere Planung.
                    tenderId: null,
                    cancelledAt: null,
                    cancelledById: null,
                    cancelReason: null,
                },
            });
            // Auch die Offerte des PROJEKTS (falls eine andere als die des
            // Auftrags) ist damit auftragslos.
            await (0, salesOrderDeletion_1.revertTendersToDraft)(tx, tenantId, employeeId, [project.tenderId], `${order.orderNumber || 'Auftrag'} zurueck in Entwurf; Projekt zurueck in die Planung.`);
            projectReverted = true;
        }
    }
    return { tenderId: order.tenderId || null, projectId, projectReverted, addonIds };
};
exports.revertSalesOrderToDraftWithin = revertSalesOrderToDraftWithin;
/**
 * STORNO EINES AUFTRAGS. Nichts wird entfernt: der Auftrag und seine Nachträge
 * werden als storniert gestempelt, künftige Termine abgesagt, und die Offerte
 * wird — weil Offerte und Auftrag eins zu eins zusammengehören — ebenfalls als
 * storniert markiert (Vorgabe: «die zugehörige Offerte darf als storniert
 * gelten, gelöscht wird sie nicht»). Andere Aufträge des Projekts bleiben
 * unberührt; nur wenn dies der LETZTE aktive war, geht das Projekt mit.
 */
const cancelSalesOrderWithin = async (tx, opts) => {
    const { order, tenantId, employeeId, reason, lifecycle } = opts;
    const now = new Date();
    const familyIds = lifecycle.familyIds;
    await tx.salesOrder.updateMany({
        where: { id: { in: familyIds }, tenantId },
        data: { status: 'CANCELLED', cancelledAt: now, cancelledById: employeeId, cancelReason: reason },
    });
    // Künftige Termine dieser Auftragsfamilie sind gegenstandslos. Vergangene
    // bleiben, wie sie sind — sie sind Geschichte, keine Planung.
    const upcoming = await tx.appointment.findMany({
        where: {
            salesOrderId: { in: familyIds },
            tenantId,
            startTime: { gte: now },
            NOT: { status: 'CANCELLED' },
        },
        select: { id: true },
    });
    if (upcoming.length) {
        await tx.appointment.updateMany({
            where: { id: { in: upcoming.map((row) => row.id) } },
            data: { status: 'CANCELLED' },
        });
    }
    // Die Offerte: gesperrt und als storniert gekennzeichnet, aber MIT ihrer
    // Verknüpfung — sie bleibt der Beleg, aus dem dieser Auftrag entstand.
    const tenderId = order.tenderId || null;
    if (tenderId) {
        const tender = await tx.tender.findFirst({
            where: { id: tenderId, tenantId },
            select: { id: true, status: true },
        });
        if (tender && tender.status !== 'Cancelled') {
            await tx.tender.update({
                where: { id: tenderId },
                data: { status: 'Cancelled', cancelledAt: now, cancelledById: employeeId, cancelReason: reason },
            });
            await tx.tenderActivityLog.create({
                data: {
                    id: (0, nanoid_1.nanoid)(12),
                    tenantId,
                    tenderId,
                    employeeId,
                    actionType: 'SALES_ORDER_CANCELLED',
                    fieldName: 'status',
                    oldValue: tender.status,
                    newValue: 'Cancelled',
                    description: `${order.orderNumber || 'Auftrag'} storniert.`,
                },
            });
        }
    }
    // Das Projekt fällt NUR mit dem letzten aktiven Auftrag.
    let projectCancelled = false;
    const projectId = order.projectId || null;
    if (projectId && lifecycle.lastOfProject) {
        await tx.project.updateMany({
            where: { id: projectId, tenantId },
            data: { status: 'CANCELLED', cancelledAt: now, cancelledById: employeeId, cancelReason: reason },
        });
        projectCancelled = true;
    }
    return {
        salesOrderIds: familyIds,
        tenderId,
        projectId,
        projectCancelled,
        cancelledAppointmentIds: upcoming.map((row) => row.id),
    };
};
exports.cancelSalesOrderWithin = cancelSalesOrderWithin;
/**
 * STORNO ZURÜCKNEHMEN. Der Beleg lebt wieder — mit demselben Umfang, den das
 * Storno getroffen hat: Auftrag samt Nachträgen, seine Offerte und, wenn es
 * mitgegangen war, das Projekt. Abgesagte Termine bleiben abgesagt; sie neu
 * anzusetzen ist eine Entscheidung, keine Rücknahme.
 */
const uncancelSalesOrderWithin = async (tx, opts) => {
    const { order, tenantId, employeeId, familyIds } = opts;
    await tx.salesOrder.updateMany({
        where: { id: { in: familyIds }, tenantId },
        data: { status: 'ORDERED', cancelledAt: null, cancelledById: null, cancelReason: null },
    });
    const tenderId = order.tenderId || null;
    if (tenderId) {
        const tender = await tx.tender.findFirst({
            where: { id: tenderId, tenantId },
            select: { id: true, status: true },
        });
        if (tender && tender.status === 'Cancelled') {
            await tx.tender.update({
                where: { id: tenderId },
                // Die Offerte war «Approved», als der Auftrag entstand — dorthin
                // zurück; nur eine Offerte ohne Auftrag fiele auf «Draft».
                data: { status: 'Approved', cancelledAt: null, cancelledById: null, cancelReason: null },
            });
            await tx.tenderActivityLog.create({
                data: {
                    id: (0, nanoid_1.nanoid)(12),
                    tenantId,
                    tenderId,
                    employeeId,
                    actionType: 'SALES_ORDER_UNCANCELLED',
                    fieldName: 'status',
                    oldValue: 'Cancelled',
                    newValue: 'Approved',
                    description: `${order.orderNumber || 'Auftrag'}: Storno aufgehoben.`,
                },
            });
        }
    }
    let projectRestored = false;
    const projectId = order.projectId || null;
    if (projectId) {
        const project = await tx.project.findFirst({
            where: { id: projectId, tenantId },
            select: { id: true, status: true },
        });
        if (project && project.status === 'CANCELLED') {
            await tx.project.update({
                where: { id: projectId },
                data: { status: 'ACTIVE', cancelledAt: null, cancelledById: null, cancelReason: null },
            });
            projectRestored = true;
        }
    }
    return { salesOrderIds: familyIds, tenderId, projectId, projectRestored };
};
exports.uncancelSalesOrderWithin = uncancelSalesOrderWithin;
/**
 * Was mit dieser Offerte geschehen darf.
 *
 * GELÖSCHT wird nur ein Entwurf, an dem nichts hängt. Sobald ein Auftrag oder
 * ein Projekt daraus entstanden ist, bleibt die Offerte als Beleg stehen —
 * dann gibt es nur noch das Storno, und auch das führt über den AUFTRAG,
 * solange der lebt (sonst stünde ein aktiver Auftrag auf einer stornierten
 * Offerte).
 */
const readTenderLifecycle = async (db, tender) => {
    const [salesOrder, project] = await Promise.all([
        db.salesOrder.findFirst({
            where: { tenderId: tender.id, tenantId: tender.tenantId },
            select: { id: true, orderNumber: true, cancelledAt: true, projectId: true },
        }),
        db.project.findFirst({
            where: { tenderId: tender.id, tenantId: tender.tenantId },
            select: { id: true },
        }),
    ]);
    const status = String(tender.status || '');
    const cancelled = Boolean(tender.cancelledAt) || status === 'Cancelled';
    const projectId = project?.id || salesOrder?.projectId || tender.projectId || null;
    const deleteBlockers = [];
    if (cancelled)
        deleteBlockers.push('CANCELLED');
    if (salesOrder)
        deleteBlockers.push('SALES_ORDER');
    if (projectId)
        deleteBlockers.push('PROJECT');
    // Angenommen/exportiert = die Offerte ist aus dem Haus; kein Entwurf mehr.
    if (status !== 'Draft' && !deleteBlockers.length)
        deleteBlockers.push('SALES_ORDER');
    const cancelBlockers = [];
    if (cancelled)
        cancelBlockers.push('CANCELLED');
    if (salesOrder && !salesOrder.cancelledAt)
        cancelBlockers.push('SALES_ORDER');
    return {
        cancelled,
        salesOrderId: salesOrder?.id || null,
        salesOrderNumber: salesOrder?.orderNumber || null,
        salesOrderCancelled: Boolean(salesOrder?.cancelledAt),
        projectId,
        deleteBlockers,
        cancelBlockers,
        canDelete: deleteBlockers.length === 0,
        canCancel: cancelBlockers.length === 0,
    };
};
exports.readTenderLifecycle = readTenderLifecycle;
const assertTenderDeletable = (lifecycle) => {
    if (lifecycle.canDelete)
        return;
    throw refuse(lifecycle.cancelled
        ? 'Eine stornierte Offerte wird nicht geloescht — sie bleibt als Beleg stehen.'
        : 'Diese Offerte haengt an einem Auftrag oder Projekt und kann nicht geloescht werden. Stornieren Sie sie stattdessen.', lifecycle.deleteBlockers, 403);
};
exports.assertTenderDeletable = assertTenderDeletable;
const assertTenderCancellable = (lifecycle) => {
    if (lifecycle.canCancel)
        return;
    throw refuse(lifecycle.cancelled
        ? 'Diese Offerte ist bereits storniert.'
        : `Aus dieser Offerte ist der Auftrag ${lifecycle.salesOrderNumber || ''} entstanden. Stornieren Sie den Auftrag — die Offerte folgt.`.replace('  ', ' '), lifecycle.cancelBlockers);
};
exports.assertTenderCancellable = assertTenderCancellable;
const cancelTenderWithin = async (tx, opts) => {
    const { tenderId, tenantId, employeeId, reason, previousStatus } = opts;
    await tx.tender.update({
        where: { id: tenderId },
        data: { status: 'Cancelled', cancelledAt: new Date(), cancelledById: employeeId, cancelReason: reason },
    });
    await tx.tenderActivityLog.create({
        data: {
            id: (0, nanoid_1.nanoid)(12),
            tenantId,
            tenderId,
            employeeId,
            actionType: 'TENDER_CANCELLED',
            fieldName: 'status',
            oldValue: previousStatus,
            newValue: 'Cancelled',
            description: reason ? `Offerte storniert: ${reason}` : 'Offerte storniert.',
        },
    });
};
exports.cancelTenderWithin = cancelTenderWithin;
const uncancelTenderWithin = async (tx, opts) => {
    const { tenderId, tenantId, employeeId, restoreTo } = opts;
    await tx.tender.update({
        where: { id: tenderId },
        data: { status: restoreTo, cancelledAt: null, cancelledById: null, cancelReason: null },
    });
    await tx.tenderActivityLog.create({
        data: {
            id: (0, nanoid_1.nanoid)(12),
            tenantId,
            tenderId,
            employeeId,
            actionType: 'TENDER_UNCANCELLED',
            fieldName: 'status',
            oldValue: 'Cancelled',
            newValue: restoreTo,
            description: 'Storno der Offerte aufgehoben.',
        },
    });
};
exports.uncancelTenderWithin = uncancelTenderWithin;
/**
 * Was mit diesem Projekt geschehen darf.
 *
 * GELÖSCHT wird nur ein Projekt, an dem nichts mehr hängt — kein Auftrag, keine
 * Rechnung, kein Rapport, keine Lagerbewegung. Der Weg dahin führt über die
 * Aufträge: jeder einzelne geht «zurück in Entwurf», und was übrigbleibt, ist
 * eine leere Planung, die man wegräumen darf.
 *
 * STORNIERT wird ein Projekt nicht von oben: es fällt mit seinem LETZTEN
 * aktiven Auftrag. Steht kein aktiver Auftrag mehr darin (leere Planung, oder
 * alle Aufträge bereits storniert), darf man es auch von Hand stornieren.
 */
const readProjectLifecycle = async (db, project) => {
    const [orders, activeOrders, invoices, reports, deliveryReports, stockMovements] = await Promise.all([
        db.salesOrder.count({ where: { projectId: project.id, tenantId: project.tenantId } }),
        db.salesOrder.count({ where: { projectId: project.id, tenantId: project.tenantId, cancelledAt: null } }),
        db.invoice.count({ where: { projectId: project.id } }),
        db.projectReport.count({ where: { projectId: project.id } }),
        db.deliveryReport.count({ where: { projectId: project.id, tenantId: project.tenantId } }),
        db.stockMovement.count({ where: { tenantId: project.tenantId, referenceId: project.id } }),
    ]);
    const cancelled = Boolean(project.cancelledAt) || String(project.status || '') === 'CANCELLED';
    const deleteBlockers = [];
    if (orders > 0)
        deleteBlockers.push('SALES_ORDER');
    if (invoices > 0)
        deleteBlockers.push('INVOICE');
    if (reports > 0)
        deleteBlockers.push('REPORT');
    if (deliveryReports > 0)
        deleteBlockers.push('DELIVERY_REPORT');
    if (stockMovements > 0)
        deleteBlockers.push('STOCK_MOVEMENT');
    const cancelBlockers = [];
    if (cancelled)
        cancelBlockers.push('CANCELLED');
    if (activeOrders > 0)
        cancelBlockers.push('SALES_ORDER');
    return {
        cancelled,
        orderCount: orders,
        activeOrderCount: activeOrders,
        invoices,
        reports,
        deliveryReports,
        stockMovements,
        deleteBlockers,
        cancelBlockers,
        canDelete: deleteBlockers.length === 0,
        canCancel: cancelBlockers.length === 0,
    };
};
exports.readProjectLifecycle = readProjectLifecycle;
const assertProjectDeletable = (lifecycle) => {
    if (lifecycle.canDelete)
        return;
    throw refuse(lifecycle.deleteBlockers.includes('SALES_ORDER')
        ? 'An diesem Projekt haengen noch Auftraege. Setzen Sie diese zuerst zurueck in den Entwurf oder stornieren Sie sie.'
        : 'An diesem Projekt haengen Rechnungen, Rapporte oder Lagerbewegungen — es kann nicht geloescht werden.', lifecycle.deleteBlockers);
};
exports.assertProjectDeletable = assertProjectDeletable;
const assertProjectCancellable = (lifecycle) => {
    if (lifecycle.canCancel)
        return;
    throw refuse(lifecycle.cancelled
        ? 'Dieses Projekt ist bereits storniert.'
        : 'Ein Projekt wird nicht von oben storniert: stornieren Sie die Auftraege. Mit dem letzten aktiven Auftrag geht das Projekt mit.', lifecycle.cancelBlockers);
};
exports.assertProjectCancellable = assertProjectCancellable;
const cancelProjectWithin = async (tx, opts) => {
    await tx.project.updateMany({
        where: { id: opts.projectId, tenantId: opts.tenantId },
        data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelledById: opts.employeeId,
            cancelReason: opts.reason,
        },
    });
};
exports.cancelProjectWithin = cancelProjectWithin;
const uncancelProjectWithin = async (tx, opts) => {
    await tx.project.updateMany({
        where: { id: opts.projectId, tenantId: opts.tenantId },
        data: {
            // Ohne Auftrag ist es wieder eine Planung, mit Auftrag ein laufendes
            // Projekt — genau die zwei Zustände, aus denen es storniert wurde.
            status: opts.hasOrders ? 'ACTIVE' : 'AWAITING_APPROVAL',
            cancelledAt: null,
            cancelledById: null,
            cancelReason: null,
        },
    });
};
exports.uncancelProjectWithin = uncancelProjectWithin;
//# sourceMappingURL=documentLifecycle.js.map