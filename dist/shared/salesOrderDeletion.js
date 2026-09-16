"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteSalesOrderWithin = exports.purgeProjectWithin = exports.assertSalesOrderDeletable = exports.salesOrderFamilyIds = exports.revertTendersToDraft = void 0;
const nanoid_1 = require("nanoid");
const articleStock_1 = require("./articleStock");
/**
 * DER AUFTRAG IST WEG → DIE OFFERTE IST WIEDER EIN ENTWURF (Benutzerregel
 * 29.08.2026: «wird das Projekt gelöscht, verschwindet es aus den Aufträgen und
 * wird wieder ein Entwurf»).
 *
 * `createFromTender` stempelt beim Eröffnen DREI Dinge auf die Offerte —
 * `status: 'Approved'`, `sourceStatus: 'Verkaufsauftrag'` und `projectId` —,
 * und genau diese drei werden hier zurückgenommen. Alle drei müssen weg:
 *
 *  • `status` sperrt die Offerte gegen jede Bearbeitung (überall im
 *    TenderController steht `if (tender.status !== 'Draft')`), sie wäre also
 *    unbrauchbar und trotzdem auftragslos.
 *  • `projectId` UND `sourceStatus` entscheiden zusammen, in welchem Topf die
 *    Offertliste die Zeile zeigt (`TenderRepository.buildLeanWhere`:
 *    `orderState = 'draft'` verlangt `projectId IS NULL` UND einen
 *    sourceStatus ausserhalb von ORDER_SOURCE_VALUES). Bliebe eines von
 *    beiden stehen, stünde die Offerte weiter unter «Auftrag» — bei einem
 *    Auftrag, den es nicht mehr gibt.
 *
 * `Tender.projectId` ist übrigens KEIN Fremdschlüssel (die Beziehung hängt an
 * `Project.tenderId`), das Löschen des Projekts räumt die Spalte also NICHT
 * von selbst auf — sie zeigt danach auf eine Zeile, die es nicht mehr gibt.
 */
const revertTendersToDraft = async (tx, tenantId, employeeId, tenderIds, description) => {
    const ids = [...new Set(tenderIds.filter(Boolean))];
    if (!ids.length)
        return;
    // Die alten Zustände für das Protokoll — vor dem Überschreiben gelesen.
    const before = await tx.tender.findMany({
        where: { id: { in: ids }, tenantId },
        select: { id: true, status: true },
    });
    if (!before.length)
        return;
    await tx.tender.updateMany({
        where: { id: { in: before.map((row) => row.id) }, tenantId },
        data: { status: 'Draft', sourceStatus: null, projectId: null },
    });
    // Die Offerte darf nicht stillschweigend zurückfallen: ihr Verlauf trägt
    // die Eröffnung des Auftrags, also auch dessen Rücknahme.
    await tx.tenderActivityLog.createMany({
        data: before.map((row) => ({
            id: (0, nanoid_1.nanoid)(12),
            tenantId,
            tenderId: row.id,
            employeeId,
            actionType: 'SALES_ORDER_DELETED',
            fieldName: 'status',
            oldValue: row.status,
            newValue: 'Draft',
            description,
        })),
    });
};
exports.revertTendersToDraft = revertTendersToDraft;
/** Der Auftrag und die Nachträge, die mit ihm fallen. */
const salesOrderFamilyIds = async (db, order, tenantId) => {
    if (order.parentSalesOrderId)
        return [order.id];
    const addons = await db.salesOrder.findMany({
        where: { parentSalesOrderId: order.id, tenantId },
        select: { id: true },
    });
    return [order.id, ...addons.map((addon) => addon.id)];
};
exports.salesOrderFamilyIds = salesOrderFamilyIds;
/**
 * Prüft, ob dieser Auftrag überhaupt fallen darf, und sagt gleich mit, ob sein
 * Projekt danach ohne Auftrag zurückbliebe. Wirft mit `status` — der Aufrufer
 * gibt die Meldung unverändert weiter.
 *
 * `lastOfProject` ist seit dem 06.09.2026 nur noch eine AUSKUNFT: das Projekt
 * fällt hier nicht mehr mit. Es bleibt trotzdem stehen, weil in diesem Fall
 * auch die Rechnungen des Projekts geprüft sein müssen.
 */
const assertSalesOrderDeletable = async (db, order, tenantId) => {
    const familyIds = await (0, exports.salesOrderFamilyIds)(db, order, tenantId);
    const invoiceCount = await db.invoice.count({ where: { salesOrderId: { in: familyIds } } });
    if (invoiceCount > 0) {
        throw Object.assign(new Error('Faturalandırılmış bir sipariş silinemez.'), { status: 400 });
    }
    // Bleibt nach diesem Auftrag kein einziger mehr im Projekt, müssen auch
    // SEINE Rechnungen geprüft sein — sonst stünde eine Rechnung auf einem
    // Projekt ohne jeden Auftrag.
    let lastOfProject = false;
    if (order.projectId) {
        const remaining = await db.salesOrder.count({
            where: { projectId: order.projectId, tenantId, NOT: { id: { in: familyIds } } },
        });
        lastOfProject = remaining === 0;
        if (lastOfProject) {
            const projectInvoices = await db.invoice.count({ where: { projectId: order.projectId } });
            if (projectInvoices > 0) {
                throw Object.assign(new Error('Faturalandırılmış bir proje silinemez.'), { status: 400 });
            }
        }
    }
    return { familyIds, lastOfProject };
};
exports.assertSalesOrderDeletable = assertSalesOrderDeletable;
/** Zusatzmaterial zurück ins Lager — in beiden Zweigen dieselbe Buchung. */
const restockExtraMaterials = async (tx, where, context) => {
    const rows = await tx.projectExtraMaterial.findMany({
        where,
        select: { id: true, articleId: true, quantity: true },
    });
    for (const row of rows) {
        // Rueckgaengig = Gegenbuchung: verbrauchtes Material kommt zurueck, eine
        // Minderung (Minusmenge) geht wieder hinaus (16.09.2026).
        await (0, articleStock_1.bookConsumption)(tx, {
            tenantId: context.tenantId,
            articleId: row.articleId,
            employeeId: context.employeeId,
            quantity: -Number(row.quantity || 0),
            referenceId: context.referenceId,
            description: 'Zusatzmaterial iadesi',
        });
    }
    if (rows.length) {
        await tx.projectExtraMaterial.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    }
};
/**
 * Das Projekt selbst räumen — alles, was nach dem Fallen seiner Aufträge noch
 * an ihm hängt. EINZIGER Aufrufer seit dem 06.09.2026: `deleteProject`, und
 * auch der erst, wenn `assertProjectDeletable` nichts mehr gefunden hat.
 */
const purgeProjectWithin = async (tx, opts) => {
    const { projectId, tenantId, employeeId } = opts;
    // Stok iadesi silmeden ÖNCE.
    await restockExtraMaterials(tx, { projectId }, { tenantId, employeeId, referenceId: projectId });
    // Raporlar randevulardan ÖNCE (rapor→randevu bağı var); rapor görselleri ve
    // malzemeleri cascade ile düşer.
    await tx.projectReport.deleteMany({ where: { projectId } });
    await tx.projectExpense.deleteMany({ where: { projectId } });
    await tx.appointment.deleteMany({ where: { projectId } });
    await tx.deliveryReport.deleteMany({ where: { projectId, tenantId } });
    await tx.signatureRequest.deleteMany({ where: { projectId, tenantId } });
    await tx.project.delete({ where: { id: projectId } });
    // Sicherheitsnetz: `Tender.projectId` ist kein Fremdschlüssel, eine
    // vergessene Verknüpfung zählte sonst weiter als «Auftrag».
    await tx.tender.updateMany({ where: { projectId, tenantId }, data: { projectId: null } });
    // Ebenso das WARTENDE Projekt einer zurückgesetzten Offerte (16.09.2026):
    // die frühere AB-Nummer bleibt als Spur, das Projekt gibt es nicht mehr.
    await tx.tender.updateMany({ where: { revertedProjectId: projectId, tenantId }, data: { revertedProjectId: null } });
};
exports.purgeProjectWithin = purgeProjectWithin;
/**
 * Der eigentliche Schnitt — IMMER innerhalb einer Transaktion aufrufen.
 * `assertSalesOrderDeletable` muss vorher gelaufen sein.
 */
const deleteSalesOrderWithin = async (tx, opts) => {
    const { order, tenantId, employeeId, familyIds } = opts;
    const projectId = order.projectId || null;
    const isAddon = Boolean(order.parentSalesOrderId);
    const addonIds = familyIds.filter((id) => id !== order.id);
    if (isAddon && projectId) {
        // EK SİPARİŞ İPTALİ (kullanıcı isteği 2026-08-07): kullanılan ek
        // malzemeler STOĞA İADE edilir. Yeni model ekleri kayıtlarını kendi
        // kimliğiyle damgalı taşır; ESKİ ekler için aynı iade, üst siparişe
        // damgalı kalmış ZAMAN DİLİMİ kayıtlarına uygulanır (önceki ek → bu ek;
        // okuma tarafındaki pencereyle birebir).
        const siblings = await tx.salesOrder.findMany({
            where: { parentSalesOrderId: order.parentSalesOrderId, projectId, tenantId, NOT: { id: order.id } },
            select: { id: true, createdAt: true },
        });
        const previousAddon = siblings
            .filter((sibling) => new Date(sibling.createdAt).getTime() < new Date(order.createdAt).getTime())
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null;
        const legacyWindow = {
            salesOrderId: order.parentSalesOrderId,
            addedAt: {
                ...(previousAddon ? { gt: previousAddon.createdAt } : {}),
                lte: order.createdAt,
            },
        };
        await restockExtraMaterials(tx, { projectId, OR: [{ salesOrderId: order.id }, legacyWindow] }, { tenantId, employeeId, referenceId: projectId });
        // Gider, rapor ve randevular SİLİNMEZ — saha kaydı yok edilmez. Üst
        // siparişe geri damgalanır ve bekleyen havuza döner; bir sonraki ek
        // sipariş isterse yeniden faturalar.
        const returnStamp = { salesOrderId: order.parentSalesOrderId };
        await tx.projectExpense.updateMany({ where: { projectId, salesOrderId: order.id }, data: returnStamp });
        await tx.projectReport.updateMany({ where: { projectId, salesOrderId: order.id }, data: returnStamp });
        await tx.appointment.updateMany({ where: { projectId, salesOrderId: order.id }, data: returnStamp });
    }
    if (!isAddon && projectId) {
        // Records normally carry the parent order id, but sweep the whole family
        // in case anything was ever stamped with an addon id. Reports own their
        // materials/images via onDelete: Cascade.
        await tx.projectReport.deleteMany({ where: { projectId, salesOrderId: { in: familyIds } } });
        await restockExtraMaterials(tx, { projectId, salesOrderId: { in: familyIds } }, { tenantId, employeeId, referenceId: projectId });
        await tx.projectExpense.deleteMany({ where: { projectId, salesOrderId: { in: familyIds } } });
        // Appointment assignments cascade on Appointment delete.
        await tx.appointment.deleteMany({ where: { projectId, salesOrderId: { in: familyIds } } });
    }
    // Nachträge tragen keine eigenen Sätze (sie rechnen die Zeitscheibe des
    // Hauptauftrags ab, oben gelöscht) — sie fallen ganz, nicht auf null.
    if (!isAddon && addonIds.length) {
        await tx.salesOrder.deleteMany({ where: { id: { in: addonIds } } });
    }
    await tx.salesOrder.delete({ where: { id: order.id } });
    // Ein gelöschter HAUPTauftrag lässt seine Offerte auftragslos zurück —
    // dieselbe Regel wie beim Projekt, und für den Lieferauftrag (ohne Projekt)
    // der einzige Weg zurück in den Entwurf. Nachträge tragen keine Offerte.
    if (!isAddon) {
        await (0, exports.revertTendersToDraft)(tx, tenantId, employeeId, [order.tenderId], `${order.orderNumber || 'Auftrag'} silindi; teklif taslaga dondu.`);
    }
    // Das PROJEKT bleibt stehen (Vorgabe Samet 06.09.2026). Was mit ihm
    // geschieht — zurück in die Planung, storniert oder gelöscht —, entscheidet
    // der Aufrufer in `documentLifecycle.ts`; hier fällt nur der Auftrag.
    return { projectDeleted: false, addonIds };
};
exports.deleteSalesOrderWithin = deleteSalesOrderWithin;
//# sourceMappingURL=salesOrderDeletion.js.map