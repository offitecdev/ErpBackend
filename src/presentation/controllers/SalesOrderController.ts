import { Request, Response } from 'express';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import prisma from '../../infrastructure/database/prisma.client';
import { GetBillingSummaryUseCase } from '../../application/use-cases/billing/GetBillingSummaryUseCase';
import { InvoiceRepository } from '../../infrastructure/repositories/InvoiceRepository';
import { orderTotal } from './salesOrder.pricing';
import { normalizePaymentStages, serializePaymentStages, validatePaymentStages } from '../../application/utils/paymentSchedule';
import { isModuleEnabledForTenant } from '../../shared/tenantModules';
import { formatDocumentNumber, nextDocumentNumber, parseDocumentNumber, raiseDocumentCounter } from '../../shared/documentNumber';
import { statusForAppointmentDay } from '../../shared/appointmentDay';
import { assertSalesOrderDeletable, deleteSalesOrderWithin, salesOrderFamilyIds } from '../../shared/salesOrderDeletion';
import {
    assertSalesOrderCancellable,
    assertSalesOrderRevertible,
    cancelSalesOrderWithin,
    readSalesOrderLifecycle,
    revertSalesOrderToDraftWithin,
    uncancelSalesOrderWithin,
} from '../../shared/documentLifecycle';
import { buildAppointmentCancellation, queueAppointmentCancellation } from '../../infrastructure/services/calendarMailService';

const billingSummaryUseCase = new GetBillingSummaryUseCase(new InvoiceRepository());

// Resolve billing summaries for a set of orders with one invoice query (no N+1).
// `baseAmount` comes from the already-loaded order rows, so no extra lookups are made.
const safeBatchSummaries = async (
    tenantId: string,
    targets: Array<{ salesOrderId: string; baseAmount: number; paymentStages?: string | null }>
) => {
    try {
        return await billingSummaryUseCase.executeBatch(tenantId, targets);
    } catch {
        return new Map<string, Awaited<ReturnType<typeof billingSummaryUseCase.execute>>>();
    }
};

// Aynı özet hesabı, faturalar zaten yüklendiğinde (liste uç noktaları fatura
// sorgusunu sipariş sorgusuyla paralel çalıştırır). Hata durumunda liste
// çökmesin diye özetler boş kalır — `safeBatchSummaries` ile aynı davranış.
// Exportiert: die Nachtragsliste (AddonOrderController) rechnet ihre Spalten
// «fakturiert / offen» mit genau denselben Helfern, damit Auftrags- und
// Nachtragsliste nie andere Zahlen zeigen.
export const summariesFromInvoices = (
    targets: Array<{ salesOrderId: string; baseAmount: number; paymentStages?: string | null }>,
    invoices: any[],
) => {
    try {
        return billingSummaryUseCase.buildBatchFromInvoices(targets, invoices);
    } catch {
        return new Map<string, Awaited<ReturnType<typeof billingSummaryUseCase.execute>>>();
    }
};

// The list only ever shows "total / invoiced / remaining", and remaining is
// derived client-side from these figures. Sending the whole summary would ship
// every invoice row of every order, so the list gets just these three.
// `billedPercent` rides along because "fully billed" is decided on the share:
// without it the list cannot tell a rappen of rounding dust (open balance 0.00)
// from a real remainder.
export const listBillingFigures = (summary: { baseAmount: number; billedAmount: number; billedPercent: number } | undefined) =>
    summary
        ? { baseAmount: summary.baseAmount, billedAmount: summary.billedAmount, billedPercent: summary.billedPercent }
        : null;

// Auftragsbestätigung: der Einleitungstext der Titelseite ist derselbe
// Rich-Text wie das Anschreiben der Offerte, aus dem er startet — also
// dieselbe Obergrenze.
const CONFIRMATION_NOTE_MAX = 40000;

/**
 * Die Absagen der TERMINE einer Auftragsfamilie einsammeln, solange die Zeilen
 * noch existieren. Verschickt werden sie erst nach dem erfolgreichen Eingriff —
 * ein gescheiterter Schnitt darf keinen Termin aus fremden Kalendern werfen.
 * Storno und «zurück in den Entwurf» benutzen beide diesen Weg.
 */
export const collectFamilyAppointmentCancellations = async (familyIds: string[], tenantId: string) => {
    const rows: any[] = await (prisma as any).appointment.findMany({
        where: {
            salesOrderId: { in: familyIds },
            tenantId,
            startTime: { gte: new Date() },
            NOT: { status: 'CANCELLED' },
        },
        select: { id: true },
    });
    return Promise.all(rows.map((row: any) => buildAppointmentCancellation(row.id).catch(() => null)));
};

type OrderMode = 'PROJECT_NEW' | 'PROJECT_EXISTING' | 'INVOICE';

const allowedOrderModes = new Set<OrderMode>(['PROJECT_NEW', 'PROJECT_EXISTING', 'INVOICE']);

export class SalesOrderController {
    /**
     * Sipariş listesi. Dört ilişki de çoktan-bire olduğu için hepsi TEK sorguda
     * JOIN'lenir; cevap şekli eski `include` çıktısıyla birebir aynı.
     *
     * Prisma her `include`u ayrı bir sorgu turu olarak çalıştırıyordu ve
     * veritabanı uzak (ifade başına ~100 ms): bu uç nokta beş ARDIŞIK ifade
     * harcıyordu, artık bir tane.
     */
    async list(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const conditions: Prisma.Sql[] = [Prisma.sql`so.tenantId = ${tenantId}`];
            if (req.query.customerId) {
                conditions.push(Prisma.sql`so.customerId = ${String(req.query.customerId)}`);
            }
            if (req.query.search) {
                const pattern = `%${String(req.query.search)}%`;
                // legacyNumber gehört dazu: die AB-Umstellung (29.08.2026) hat
                // jeden alten AU-Code dorthin gelegt, und ein Kunde, der eine
                // schon verschickte Bestätigung sucht, tippt genau diesen Code.
                conditions.push(Prisma.sql`(
                    so.orderNumber LIKE ${pattern}
                    OR so.legacyNumber LIKE ${pattern}
                    OR t.tenderNumber LIKE ${pattern}
                    OR c.companyName LIKE ${pattern}
                    OR p.projectName LIKE ${pattern}
                )`);
            }

            const rows = await prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT
                    so.id, so.tenantId, so.customerId, so.tenderId, so.projectId,
                    so.parentSalesOrderId, so.revisionNumber, so.orderNumber, so.orderType,
                    so.status, so.totalAmount, so.paymentStages, so.createdByEmployeeId,
                    so.createdAt, so.updatedAt, so.orderDate,
                    so.cancelledAt, so.cancelReason,
                    c.companyName AS customerCompanyName,
                    c.mainEmail AS customerMainEmail,
                    c.mainPhone AS customerMainPhone,
                    t.tenderNumber AS tenderNumber,
                    t.status AS tenderStatus,
                    t.projectId AS tenderProjectId,
                    p.projectName AS projectName,
                    p.status AS projectStatus,
                    e.firstName AS creatorFirstName,
                    e.lastName AS creatorLastName,
                    e.email AS creatorEmail
                FROM SalesOrder so
                LEFT JOIN Customer c ON c.id = so.customerId
                LEFT JOIN Tender t ON t.id = so.tenderId
                LEFT JOIN Project p ON p.id = so.projectId
                LEFT JOIN Employee e ON e.id = so.createdByEmployeeId
                WHERE ${Prisma.join(conditions, ' AND ')}
                ORDER BY so.createdAt DESC
            `);

            const orders = rows.map((row) => ({
                id: row.id,
                tenantId: row.tenantId,
                customerId: row.customerId ?? null,
                tenderId: row.tenderId ?? null,
                projectId: row.projectId ?? null,
                parentSalesOrderId: row.parentSalesOrderId ?? null,
                revisionNumber: row.revisionNumber ?? null,
                orderNumber: row.orderNumber,
                orderType: row.orderType,
                status: row.status,
                // STORNO (06.09.2026): die Liste zeigt einen stornierten Auftrag
                // weiter an — als storniert, nicht als offen.
                cancelledAt: row.cancelledAt ?? null,
                cancelReason: row.cancelReason ?? null,
                totalAmount: Number(row.totalAmount ?? 0),
                paymentStages: row.paymentStages ?? null,
                createdByEmployeeId: row.createdByEmployeeId,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                orderDate: row.orderDate ?? null,
                customer: row.customerId
                    ? {
                        id: row.customerId,
                        companyName: row.customerCompanyName,
                        mainEmail: row.customerMainEmail ?? null,
                        mainPhone: row.customerMainPhone ?? null,
                    }
                    : null,
                tender: row.tenderId
                    ? {
                        id: row.tenderId,
                        tenderNumber: row.tenderNumber,
                        status: row.tenderStatus,
                        projectId: row.tenderProjectId ?? null,
                    }
                    : null,
                project: row.projectId
                    ? { id: row.projectId, projectName: row.projectName, status: row.projectStatus }
                    : null,
                createdBy: row.createdByEmployeeId
                    ? {
                        id: row.createdByEmployeeId,
                        firstName: row.creatorFirstName,
                        lastName: row.creatorLastName,
                        email: row.creatorEmail,
                    }
                    : null,
            }));

            res.status(200).json(orders);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // "Siparişlerim" – top-level orders with their addon orders.
    //
    // This is a list feed, not a detail feed: it carries exactly the columns the
    // My Orders table renders (order no, customer, status, total, invoiced,
    // remaining) plus the ids the project flow screens group by. Everything else
    // — the tender/project/creator relations, the customer's contact details, the
    // per-order invoice list inside the billing summary — belongs to
    // `getById` and is deliberately not selected here.
    async myOrders(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;

            // Project-list read model: one row per main order, with only the
            // fields used for technical/billing percentages and the addon badge.
            // In particular this skips customer/project relations and the entire
            // parallel invoice-summary query used by the My Orders page.
            if (String(req.query.view || '') === 'project-list') {
                const rows = await prisma.$queryRaw<Array<{
                    id: string;
                    orderNumber: string;
                    totalAmount: number | string | null;
                    projectId: string | null;
                    addonCount: number | bigint | string | null;
                }>>(Prisma.sql`
                    SELECT
                        mainOrder.id,
                        mainOrder.orderNumber,
                        mainOrder.totalAmount,
                        mainOrder.projectId,
                        COUNT(addon.id) AS addonCount
                    FROM SalesOrder mainOrder
                    LEFT JOIN SalesOrder addon
                      ON addon.parentSalesOrderId = mainOrder.id
                     AND addon.tenantId = mainOrder.tenantId
                    WHERE mainOrder.tenantId = ${tenantId}
                      AND mainOrder.parentSalesOrderId IS NULL
                    GROUP BY mainOrder.id, mainOrder.orderNumber, mainOrder.totalAmount, mainOrder.projectId, mainOrder.createdAt
                    ORDER BY mainOrder.createdAt DESC
                `);
                return res.status(200).json(rows.map((row) => ({
                    id: row.id,
                    orderNumber: row.orderNumber,
                    totalAmount: Number(row.totalAmount || 0),
                    projectId: row.projectId ?? null,
                    addonCount: Number(row.addonCount || 0),
                })));
            }

            const where: any = { tenantId, parentSalesOrderId: null };
            if (req.query.search) {
                const search = String(req.query.search);
                where.OR = [
                    { orderNumber: { contains: search } },
                    // Yeniden numaralandırmadan önceki kod da aranabilir.
                    { legacyNumber: { contains: search } },
                    { customer: { companyName: { contains: search } } },
                    { project: { projectNumber: { contains: search } } },
                    { project: { projectName: { contains: search } } },
                ];
            }

            // Üç ilişki sorgusu (üst siparişler + müşteri + ek siparişler) tek
            // JOIN'e indi ve fatura özetleri artık sipariş sorgusunu BEKLEMİYOR:
            // aynı WHERE'i alt sorgu olarak kullandığı için ikisi paralel koşuyor.
            // Uzak veritabanında her ifade ~100 ms olduğundan bu uç nokta dört
            // ardışık turdan iki paralel tura indi.
            const [orders, invoiceRows] = await Promise.all([
                (prisma as any).salesOrder.findMany({
                    where,
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true,
                        orderNumber: true,
                        totalAmount: true,
                        createdAt: true,
                        // Teklif onaylanırken seçilen yol (proje siparişi / teslimat
                        // siparişi) listede rozet olarak gösterilir.
                        orderType: true,
                        // STORNO (06.09.2026): ein stornierter Auftrag bleibt in
                        // der Liste — durchgestrichen, mit rotem Zeichen.
                        cancelledAt: true,
                        // Kept: the project screens filter the same feed by project.
                        projectId: true,
                        // Sipariş listesi bağlı projeyi gösterir; projesi OLMAYAN
                        // sipariş (teklifin "fatura/teslimat" yolu) listede
                        // "Teslimat siparişi" olarak işaretlenir.
                        project: { select: { id: true, projectNumber: true, projectName: true } },
                        customer: { select: { id: true, companyName: true } },
                        addonSalesOrders: {
                            orderBy: [{ revisionNumber: 'asc' }, { createdAt: 'asc' }],
                            // Liste ek siparişleri kendi satırları olarak da gösterir;
                            // satırdaki tarih ek işin ait olduğu gün (orderDate),
                            // yoksa oluşturulma tarihidir.
                            select: { id: true, orderNumber: true, totalAmount: true, createdAt: true, orderDate: true, cancelledAt: true },
                        },
                    },
                }),
                // Listelenen siparişlerin (ve ek siparişlerinin) faturaları.
                (prisma as any).invoice.findMany({
                    where: {
                        tenantId,
                        OR: [
                            { salesOrder: { is: where } },
                            { salesOrder: { is: { tenantId, parentSalesOrder: { is: where } } } },
                        ],
                    },
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true,
                        salesOrderId: true,
                        invoiceNumber: true,
                        billingType: true,
                        billedPercent: true,
                        amount: true,
                        status: true,
                        createdAt: true,
                    },
                }),
            ]);

            const targets = orders.flatMap((order: any) => [
                { salesOrderId: order.id, baseAmount: Number(order.totalAmount || 0) },
                ...(order.addonSalesOrders || []).map((addon: any) => ({
                    salesOrderId: addon.id,
                    baseAmount: Number(addon.totalAmount || 0),
                })),
            ]);
            const summaries = summariesFromInvoices(targets, invoiceRows);

            const enriched = orders.map((order: any) => ({
                ...order,
                billingSummary: listBillingFigures(summaries.get(order.id)),
                addonSalesOrders: (order.addonSalesOrders || []).map((addon: any) => ({
                    ...addon,
                    billingSummary: listBillingFigures(summaries.get(addon.id)),
                })),
            }));

            res.status(200).json(enriched);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // Single order detail – project, assembly phases (reports), costs, addons, billing
    async getById(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const id = String(req.params.id);

            const order: any = await (prisma as any).salesOrder.findFirst({
                where: { id, tenantId },
                include: {
                    customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true, address: true } },
                    // Adresler ve teslim tarihi SİPARİŞTE DEĞİL, teklifte durur — sipariş
                    // görünümünün "Übersicht" sekmesi bunları buradan okur. Hangisinin
                    // gösterileceğini sipariş türü belirler: proje siparişinde nihai adres
                    // MONTAJ adresidir, teslimat siparişinde doğrudan TESLİMAT adresi ve
                    // teslim tarihi (projede teslim tarihi YOKTUR, randevular taşır).
                    tender: {
                        select: {
                            id: true,
                            tenderNumber: true,
                            commissionNumber: true,
                            // Rechnung bölümündeki Verkäufer alanı buradan ön-dolar:
                            // teklifin satıcısı, yoksa teklifi oluşturan kişi.
                            salespersonName: true,
                            createdBy: { select: { firstName: true, lastName: true } },
                            billingAddress: true,
                            installationAddress: true,
                            deliveryAddress: true,
                            internalDeliveryDate: true,
                        },
                    },
                    project: {
                        select: {
                            id: true, projectName: true, status: true, cancelledAt: true, plannedBudget: true, actualCost: true,
                            startDate: true, endDate: true,
                            phases: { select: { id: true, phaseName: true, progressPercentage: true, isCompleted: true } },
                        },
                    },
                    parentSalesOrder: { select: { id: true, orderNumber: true, cancelledAt: true } },
                    addonSalesOrders: {
                        orderBy: [{ revisionNumber: 'asc' }, { createdAt: 'asc' }],
                        select: { id: true, orderNumber: true, orderType: true, status: true, cancelledAt: true, cancelReason: true, revisionNumber: true, totalAmount: true, paymentStages: true, createdAt: true, orderDate: true },
                    },
                    reports: {
                        orderBy: { workDate: 'asc' },
                        select: {
                            // reportDate: ek siparişlerin dilimi sunucuda reportDate ile
                            // kesilir (createAddonOrderForParent); ek sipariş popup'ının
                            // istemci tarafı dilimlemesi aynı alanı kullanır.
                            id: true, workDate: true, reportDate: true, reportType: true, operationsDone: true, technicalNotes: true,
                            workedMinutes: true, overtimeMinutes: true, overtimeCost: true, overtimeHourlyRate: true, isSigned: true, signedAt: true,
                            employee: { select: { id: true, firstName: true, lastName: true } },
                        },
                    },
                    expenses: { select: { id: true, expenseType: true, amount: true, description: true, expenseDate: true } },
                    extraMaterials: {
                        select: {
                            id: true, quantity: true, unitPrice: true, description: true, addedAt: true,
                            article: { select: { id: true, name: true, articleCode: true } },
                        },
                    },
                    createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                },
            });

            if (!order) return res.status(404).json({ error: 'Sipariş bulunamadı.' });

            const summaries = await safeBatchSummaries(tenantId, [
                { salesOrderId: order.id, baseAmount: Number(order.totalAmount || 0), paymentStages: order.paymentStages ?? null },
                ...(order.addonSalesOrders || []).map((addon: any) => ({
                    salesOrderId: addon.id,
                    baseAmount: Number(addon.totalAmount || 0),
                    paymentStages: addon.paymentStages ?? null,
                })),
            ]);
            const billingSummary = summaries.get(order.id) ?? null;
            const addonSalesOrders = (order.addonSalesOrders || []).map((addon: any) => ({
                ...addon,
                billingSummary: summaries.get(addon.id) ?? null,
            }));

            const expensesTotal = (order.expenses || []).reduce((sum: number, e: any) => sum + Number(e.amount || 0), 0);
            const extraMaterialsTotal = (order.extraMaterials || []).reduce((sum: number, m: any) => sum + Number(m.quantity || 0) * Number(m.unitPrice || 0), 0);
            const overtimeTotal = (order.reports || []).reduce((sum: number, r: any) => sum + Number(r.overtimeCost || 0), 0);
            const addonTotal = (order.addonSalesOrders || []).reduce((sum: number, a: any) => sum + Number(a.totalAmount || 0), 0);

            res.status(200).json({
                ...order,
                addonSalesOrders,
                billingSummary,
                costSummary: {
                    orderAmount: Number(order.totalAmount || 0),
                    expensesTotal,
                    extraMaterialsTotal,
                    overtimeTotal,
                    addonTotal,
                    grandTotal: Number(order.totalAmount || 0) + addonTotal,
                },
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    // Set or clear the order's payment schedule (dated percent stages summing to 100).
    /**
     * EINEN AUFTRAG ZURÜCKNEHMEN — von der Auftragsansicht aus, für JEDE Art:
     * Projektauftrag, Nachtrag und (neu) den Lieferauftrag, der gar kein
     * Projekt hat und darum über die Projektadresse nie löschbar war.
     *
     * Die Regeln selbst stehen in `shared/salesOrderDeletion`: mitfallende
     * Nachträge, Lagerrückgabe, Offerte zurück auf «Entwurf», und das Projekt,
     * das mit seinem letzten Auftrag verschwindet.
     */
    /**
     * ── LÖSCHEN, STORNO, ZURÜCK IN ENTWURF ───────────────────────────────────
     *
     * Vorgabe Samet (06.09.2026): ein Auftrag ist ein Beleg. Solange noch nichts
     * geschehen ist, darf er ZURÜCK IN DEN ENTWURF — er verschwindet, und seine
     * Offerte ist wieder änderbar. Sobald etwas daran hängt (Rechnung,
     * Lagerbewegung, Rapport, begonnene Montage, Nachträge), gibt es nur noch
     * das STORNO: die Zeile bleibt mit allen Sätzen stehen.
     *
     * Diese Auskunft holt sich die Auftragsansicht beim Öffnen, damit sie den
     * richtigen Knopf zeigt statt beim Klick abzublitzen.
     */
    async lifecycle(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const id = String(req.params.id);
            const order: any = await (prisma as any).salesOrder.findFirst({ where: { id, tenantId } });
            if (!order) return res.status(404).json({ error: 'Sipariş bulunamadı.' });

            const lifecycle = await readSalesOrderLifecycle(prisma as any, order, tenantId);
            res.json({
                ...lifecycle,
                orderNumber: order.orderNumber,
                isAddon: Boolean(order.parentSalesOrderId),
                projectId: order.projectId ?? null,
                tenderId: order.tenderId ?? null,
                cancelledAt: order.cancelledAt ?? null,
                cancelReason: order.cancelReason ?? null,
            });
        } catch (error: any) {
            res.status(error?.status || 400).json({ error: error.message });
        }
    }

    /**
     * ZURÜCK IN ENTWURF. Der Auftrag geht, die Offerte wird wieder ein Entwurf,
     * und war es der letzte Auftrag des Projekts, fällt das Projekt in die
     * Planung zurück — es wird NICHT gelöscht (das ist der Unterschied zum
     * früheren Verhalten). Andere Aufträge des Projekts bleiben unberührt.
     *
     * `DELETE /sales-orders/:id` landet für Hauptaufträge in derselben Methode:
     * es gibt für einen Auftrag nur diesen einen Weg zurück, und alte Aufrufer
     * sollen ihn nicht umgehen können.
     */
    async revertToDraft(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const id = String(req.params.id);

            const order: any = await (prisma as any).salesOrder.findFirst({ where: { id, tenantId } });
            if (!order) return res.status(404).json({ error: 'Sipariş bulunamadı.' });

            const lifecycle = await readSalesOrderLifecycle(prisma as any, order, tenantId);
            assertSalesOrderRevertible(lifecycle);

            // Mit dem Auftrag fallen seine angesetzten Termine. Die Absagen
            // werden EINGESAMMELT, solange die Zeilen noch da sind, und erst
            // nach dem erfolgreichen Zuruecksetzen verschickt — sonst stuende
            // der Termin weiter in fremden Kalendern (derselbe Weg wie beim
            // Loeschen eines einzelnen Termins).
            const cancellations = await collectFamilyAppointmentCancellations(lifecycle.familyIds, tenantId);

            const result = await (prisma as any).$transaction(async (tx: any) => revertSalesOrderToDraftWithin(tx, {
                order,
                tenantId,
                employeeId: req.user!.id,
                lifecycle,
            }));

            for (const cancellation of cancellations) {
                queueAppointmentCancellation(cancellation, req.user!.id);
            }

            // `tenderId` ist der Weg zurück: dort steht der Entwurf, den jemand
            // gerade wieder bearbeiten will. `projectReverted` sagt, dass das
            // Projekt noch da, aber leer ist.
            res.json({ ...result, orderNumber: order.orderNumber, isAddon: Boolean(order.parentSalesOrderId) });
        } catch (error: any) {
            res.status(error?.status || 400).json({ error: error.message, blockers: error?.blockers });
        }
    }

    /**
     * STORNO. Der Auftrag und seine Nachträge werden zurückgenommen, ohne dass
     * eine Zeile verschwindet; künftige Termine werden abgesagt (und die schon
     * verschickten Einladungen zurückgezogen). Das Projekt geht NUR mit, wenn
     * dies sein letzter aktiver Auftrag war — stehen weitere darin, läuft es
     * weiter.
     */
    async cancel(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const id = String(req.params.id);

            const order: any = await (prisma as any).salesOrder.findFirst({ where: { id, tenantId } });
            if (!order) return res.status(404).json({ error: 'Sipariş bulunamadı.' });

            const lifecycle = await readSalesOrderLifecycle(prisma as any, order, tenantId);
            assertSalesOrderCancellable(lifecycle);

            const reason = String(req.body?.reason || '').trim().slice(0, 500) || null;

            // Die Absagen EINSAMMELN, solange die Termine noch stehen — genau
            // wie beim Löschen eines Termins. Verschickt wird erst, wenn das
            // Storno durchgelaufen ist.
            const cancellations = await collectFamilyAppointmentCancellations(lifecycle.familyIds, tenantId);

            const result = await (prisma as any).$transaction(async (tx: any) => cancelSalesOrderWithin(tx, {
                order,
                tenantId,
                employeeId: req.user!.id,
                reason,
                lifecycle,
            }));

            for (const cancellation of cancellations) {
                queueAppointmentCancellation(cancellation, req.user!.id);
            }

            res.json({ ...result, orderNumber: order.orderNumber, isAddon: Boolean(order.parentSalesOrderId) });
        } catch (error: any) {
            res.status(error?.status || 400).json({ error: error.message, blockers: error?.blockers });
        }
    }

    /** Storno aufheben — Auftrag, Nachträge, Offerte und Projekt leben wieder. */
    async uncancel(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const id = String(req.params.id);

            const order: any = await (prisma as any).salesOrder.findFirst({ where: { id, tenantId } });
            if (!order) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
            if (!order.cancelledAt && order.status !== 'CANCELLED') {
                return res.status(400).json({ error: 'Dieser Auftrag ist nicht storniert.' });
            }
            // Ein Nachtrag lebt nur mit seinem Hauptauftrag: der darf nicht
            // storniert bleiben, während der Nachtrag wieder aktiv wird.
            if (order.parentSalesOrderId) {
                const parent: any = await (prisma as any).salesOrder.findFirst({
                    where: { id: order.parentSalesOrderId, tenantId },
                    select: { orderNumber: true, cancelledAt: true },
                });
                if (parent?.cancelledAt) {
                    return res.status(400).json({
                        error: `Der Hauptauftrag ${parent.orderNumber || ''} ist storniert. Heben Sie dessen Storno auf — der Nachtrag folgt.`,
                    });
                }
            }

            const familyIds = await salesOrderFamilyIds(prisma as any, order, tenantId);
            const result = await (prisma as any).$transaction(async (tx: any) => uncancelSalesOrderWithin(tx, {
                order,
                tenantId,
                employeeId: req.user!.id,
                familyIds,
            }));

            res.json({ ...result, orderNumber: order.orderNumber });
        } catch (error: any) {
            res.status(error?.status || 400).json({ error: error.message });
        }
    }

    /**
     * `DELETE /sales-orders/:id` — der alte Weg, mit den neuen Regeln.
     *
     * Ein HAUPTAUFTRAG wird nicht mehr «gelöscht»: er geht zurück in den
     * Entwurf, mit denselben Bedingungen (nichts darf geschehen sein). Ein
     * NACHTRAG dagegen ist kein eigener Vertrag, sondern der Rechnungsschnitt
     * über eine Zeitscheibe des Hauptauftrags — solange keine Rechnung an ihm
     * hängt, verschwindet er ganz und seine Sätze kehren zum Hauptauftrag
     * zurück.
     */
    async remove(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const id = String(req.params.id);

            const order: any = await (prisma as any).salesOrder.findFirst({ where: { id, tenantId } });
            if (!order) return res.status(404).json({ error: 'Sipariş bulunamadı.' });

            if (!order.parentSalesOrderId) return this.revertToDraft(req, res);

            if (order.cancelledAt || order.status === 'CANCELLED') {
                return res.status(400).json({
                    error: 'Ein stornierter Nachtrag bleibt als Beleg stehen und wird nicht geloescht.',
                    blockers: ['CANCELLED'],
                });
            }

            const { familyIds } = await assertSalesOrderDeletable(prisma as any, order, tenantId);

            const result = await (prisma as any).$transaction(async (tx: any) => deleteSalesOrderWithin(tx, {
                order,
                tenantId,
                employeeId: req.user!.id,
                familyIds,
            }));

            res.json({ ...result, projectId: order.projectId ?? null, orderNumber: order.orderNumber, isAddon: true });
        } catch (error: any) {
            res.status(error?.status || 400).json({ error: error.message, blockers: error?.blockers });
        }
    }

    async updatePaymentStages(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const id = String(req.params.id);
            const raw = req.body?.paymentStages;

            let serialized: string | null = null;
            if (raw !== null && raw !== undefined && raw !== '') {
                const stages = normalizePaymentStages(raw);
                const stageError = stages ? validatePaymentStages(stages) : 'Geçersiz ödeme planı.';
                if (stageError) return res.status(400).json({ error: stageError });
                serialized = serializePaymentStages(stages!);
            }

            // Ein STORNIERTER Auftrag wird nicht mehr bearbeitet — er steht als
            // Beleg da (Vorgabe Samet 06.09.2026).
            const result = await (prisma as any).salesOrder.updateMany({
                where: { id, tenantId, cancelledAt: null },
                data: { paymentStages: serialized },
            });
            if (result.count === 0) {
                const exists = await (prisma as any).salesOrder.count({ where: { id, tenantId } });
                return exists
                    ? res.status(400).json({ error: 'Ein stornierter Auftrag kann nicht geaendert werden.' })
                    : res.status(404).json({ error: 'Sipariş bulunamadı.' });
            }

            res.status(200).json({ message: 'Ödeme planı güncellendi.', paymentStages: serialized });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    /**
     * AUFTRAGSBESTÄTIGUNG — Einleitungstext und «Gültig bis» des Auftrags.
     *
     * Beide gehören zusammen: EIN Fenster bearbeitet sie, also schreibt sie EIN
     * Endpunkt. Ein weggelassenes Feld bleibt unangetastet (das Fenster kann
     * auch nur den Text ändern); ein leeres Feld setzt auf NULL zurück, und
     * dann greift wieder die Vorgabe — der Text der Offerte und Auftragsdatum
     * plus einen Monat. Deshalb wird der Standard hier NICHT eingesetzt: er
     * wäre danach nicht mehr von einer bewussten Eingabe zu unterscheiden.
     */
    async updateOrderConfirmation(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const id = String(req.params.id);
            const body = req.body ?? {};
            const data: Record<string, any> = {};

            if ('confirmationNote' in body) {
                const raw = body.confirmationNote;
                if (raw !== null && raw !== undefined && typeof raw !== 'string') {
                    return res.status(400).json({ error: 'Einleitungstext ungültig.' });
                }
                const text = typeof raw === 'string' ? raw.trim() : '';
                if (text.length > CONFIRMATION_NOTE_MAX) {
                    return res.status(400).json({ error: `Einleitungstext darf höchstens ${CONFIRMATION_NOTE_MAX} Zeichen lang sein.` });
                }
                data.confirmationNote = text.length > 0 ? text : null;
            }

            if ('confirmationValidUntil' in body) {
                const raw = body.confirmationValidUntil;
                if (raw === null || raw === undefined || raw === '') {
                    data.confirmationValidUntil = null;
                } else {
                    const parsed = new Date(String(raw));
                    if (Number.isNaN(parsed.getTime())) {
                        return res.status(400).json({ error: 'Gültigkeitsdatum ungültig.' });
                    }
                    data.confirmationValidUntil = parsed;
                }
            }

            if (Object.keys(data).length === 0) {
                return res.status(400).json({ error: 'Keine Änderung übermittelt.' });
            }

            // Ein stornierter Auftrag wird nicht mehr bearbeitet (06.09.2026).
            const result = await (prisma as any).salesOrder.updateMany({ where: { id, tenantId, cancelledAt: null }, data });
            if (result.count === 0) {
                const exists = await (prisma as any).salesOrder.count({ where: { id, tenantId } });
                return exists
                    ? res.status(400).json({ error: 'Ein stornierter Auftrag kann nicht geaendert werden.' })
                    : res.status(404).json({ error: 'Sipariş bulunamadı.' });
            }

            const saved = await (prisma as any).salesOrder.findFirst({
                where: { id, tenantId },
                select: { confirmationNote: true, confirmationValidUntil: true },
            });
            res.status(200).json({
                message: 'Auftragsbestätigung gespeichert.',
                confirmationNote: saved?.confirmationNote ?? null,
                confirmationValidUntil: saved?.confirmationValidUntil ?? null,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async createFromTender(req: Request, res: Response) {
        try {
            const tenantId = req.user!.tenantId;
            const employeeId = req.user!.id;
            const tenderId = String(req.body.tenderId || '').trim();
            const mode = String(req.body.mode || '') as OrderMode;
            // Proje adı artık teklifte GİRİLMEZ: sistem üretir (aşağıda koda eşitlenir).
            // Gövdede `projectName` gelse bile yok sayılır.
            const existingProjectId = String(req.body.projectId || '').trim();
            const overtimeHourlyRate = Math.max(0, Number(req.body.overtimeHourlyRate || 0));
            // Teslimat siparişinde (proje açılmayan yol) teslim tarihi ZORUNLUDUR:
            // siparişin tek zaman taahhüdü budur, projeli siparişte ise takvimi
            // randevular taşır. Tarih teklifin `internalDeliveryDate` alanına yazılır.
            const rawDeliveryDate = String(req.body.deliveryDate || '').trim();
            const deliveryDate = rawDeliveryDate ? new Date(rawDeliveryDate) : null;
            if (rawDeliveryDate && Number.isNaN(deliveryDate!.getTime())) {
                return res.status(400).json({ error: 'Teslim tarihi gecersiz.' });
            }

            if (!tenderId) return res.status(400).json({ error: 'Teklif ID zorunludur.' });
            if (!allowedOrderModes.has(mode)) return res.status(400).json({ error: 'Gecersiz siparis turu.' });
            if (mode === 'PROJECT_EXISTING' && !existingProjectId) return res.status(400).json({ error: 'Proje secimi zorunludur.' });

            const result = await prisma.$transaction(async (tx) => {
                const tender: any = await (tx as any).tender.findUnique({
                    where: { id: tenderId },
                    include: {
                        positions: { include: { calculation: true } },
                        // Der Ersteller reist mit: die Auftragsbestätigung nennt ihn
                        // als Verkäufer, und auf diesem Zweig (Auftrag bestand schon)
                        // ist das nicht zwingend die Person, die gerade klickt.
                        salesOrder: { include: { createdBy: { select: { id: true, firstName: true, lastName: true, email: true } } } },
                    },
                });
                if (!tender || tender.tenantId !== tenantId) throw new Error('Teklif bulunamadi.');
                // Aus einer STORNIERTEN Offerte entsteht kein Auftrag (Vorgabe
                // Samet 06.09.2026) — erst das Storno aufheben.
                if (tender.status === 'Cancelled' || tender.cancelledAt) {
                    throw new Error('Aus einer stornierten Offerte kann kein Auftrag entstehen.');
                }
                if (!tender.customerId) throw new Error('Siparis icin teklifin musterisi olmalidir.');

                // Sipariş zaten açılmışsa hiçbir şey doğrulanmaz/yazılmaz —
                // bu çağrı mevcut siparişi geri vermekten ibarettir.
                if (tender.salesOrder) {
                    return {
                        salesOrder: tender.salesOrder,
                        project: tender.salesOrder.projectId
                            ? await (tx as any).project.findUnique({ where: { id: tender.salesOrder.projectId } })
                            : null,
                        reused: true,
                    };
                }

                // Teslimat siparişi: gövdeden gelen tarih yoksa teklifte kayıtlı
                // olan kabul edilir; ikisi de yoksa sipariş açılmaz.
                const effectiveDeliveryDate = deliveryDate ?? tender.internalDeliveryDate ?? null;
                if (mode === 'INVOICE' && !effectiveDeliveryDate) {
                    throw new Error('Teslimat siparisi icin teslim tarihi zorunludur.');
                }
                if (deliveryDate) {
                    await (tx as any).tender.update({
                        where: { id: tenderId },
                        data: { internalDeliveryDate: deliveryDate },
                    });
                }

                const totalAmount = orderTotal(tender.positions || [], tender.directDiscount, tender.extraDiscount);
                let project: any = null;
                let scheduleSlots: any[] = [];

                if (mode === 'PROJECT_NEW' || mode === 'PROJECT_EXISTING') {
                    // Company category ("Numara" profile) decides; no category = every module.
                    if (!await isModuleEnabledForTenant(tenantId, 'projects', tx)) {
                        throw new Error('Proje modulu aktif degil.');
                    }
                }

                if (mode === 'PROJECT_NEW') {
                    scheduleSlots = await (tx as any).offerScheduleSlot.findMany({
                        where: { tenderId },
                        orderBy: { startTime: 'asc' },
                        include: { technicianAssignments: true },
                    });
                    // Projenin ADI KODUDUR (PR-2026-10001) ve sayaç kaldığı yerden
                    // devam eder. Eskiden teklif kodu (A-2026-5980) ada
                    // kopyalanıyordu; proje listesinde ad sütunu teklif
                    // sütununu tekrar ediyor, proje kendi kimliğini taşımıyordu.
                    const projectNumber = await nextDocumentNumber(tenantId, 'PROJECT', tx);
                    project = await (tx as any).project.create({
                        data: {
                            id: nanoid(10),
                            tenantId,
                            customerId: tender.customerId,
                            tenderId,
                            managerId: employeeId,
                            projectNumber,
                            projectName: projectNumber,
                            status: 'ACTIVE',
                            plannedBudget: totalAmount,
                            actualCost: 0,
                            startDate: scheduleSlots[0]?.startTime || new Date(),
                            bookingToken: crypto.randomBytes(32).toString('hex'),
                            overtimeHourlyRate,
                            overtimeTolerancePercent: 15,
                        },
                    });
                }

                if (mode === 'PROJECT_EXISTING') {
                    project = await (tx as any).project.findFirst({
                        where: { id: existingProjectId, tenantId },
                    });
                    if (!project) throw new Error('Proje bulunamadi.');
                }

                // Sipariş kodu teklifin kodunu AYNEN izler (kullanıcı isteği):
                // AN-2026-10007 → AB-2026-10007. Yıl ve sıra tekliften kopyalanır,
                // yalnızca önek değişir — teklifle siparişin kod sonu hep eşittir.
                // Aynı kodu paylaşan İKİNCİ teklif sürümü siparişe çevrilirse
                // FARKLI bir numara VERİLMEZ: aynı kod "-2" ("-3", …) ekini alır
                // (kullanıcı isteği: AB-2026-10046 → AB-2026-10046-2). Sayaç
                // yalnızca çözümlenemeyen (çok eski/dış) teklif kodları için
                // devreye girer.
                const parsedTenderNumber = parseDocumentNumber(tender.tenderNumber, 'QUOTE');
                let orderNumber: string | null = null;
                if (parsedTenderNumber) {
                    const candidate = formatDocumentNumber('ORDER', parsedTenderNumber.year, parsedTenderNumber.seq);
                    const taken = await (tx as any).salesOrder.findFirst({
                        where: { tenantId, orderNumber: candidate },
                        select: { id: true },
                    });
                    if (!taken) {
                        orderNumber = candidate;
                    } else {
                        const siblings: Array<{ orderNumber: string }> = await (tx as any).salesOrder.findMany({
                            where: { tenantId, orderNumber: { startsWith: `${candidate}-` } },
                            select: { orderNumber: true },
                        });
                        let maxSuffix = 1;
                        for (const sibling of siblings) {
                            const suffix = Number(sibling.orderNumber.slice(candidate.length + 1));
                            if (Number.isFinite(suffix) && suffix > maxSuffix) maxSuffix = suffix;
                        }
                        orderNumber = `${candidate}-${maxSuffix + 1}`;
                    }
                    // Sayaç türetilen sıranın altında kalmasın: sayaçtan üretilecek
                    // bir sonraki yedek kod bu sırayı ikinci kez dağıtamaz.
                    await raiseDocumentCounter(tenantId, 'ORDER', parsedTenderNumber.seq, tx);
                }
                if (!orderNumber) orderNumber = await nextDocumentNumber(tenantId, 'ORDER', tx);
                const salesOrder = await (tx as any).salesOrder.create({
                    data: {
                        id: nanoid(10),
                        tenantId,
                        customerId: tender.customerId,
                        tenderId,
                        projectId: project?.id || null,
                        orderNumber,
                        orderType: mode,
                        status: 'ORDERED',
                        totalAmount,
                        paymentStages: tender.paymentStages ?? null,
                        createdByEmployeeId: employeeId,
                    },
                    include: { createdBy: { select: { id: true, firstName: true, lastName: true, email: true } } },
                });

                if (project?.id && scheduleSlots.length > 0) {
                    // Carry each proposal slot's technician assignment forward into
                    // the project appointment so both screens stay in sync.
                    for (const slot of scheduleSlots) {
                        const appointment = await (tx as any).appointment.create({
                            data: {
                                id: nanoid(10),
                                tenantId,
                                projectId: project.id,
                                salesOrderId: salesOrder.id,
                                customerId: tender.customerId,
                                // Wer den Auftrag erteilt, hat auch diese Termine gesetzt.
                                // KEINE automatische Teammail hier: ein Auftrag legt
                                // mehrere Termine auf einmal an, das waere ein Schwall.
                                createdByEmployeeId: employeeId,
                                assignedTechId: slot.assignedTechId || null,
                                startTime: slot.startTime,
                                endTime: slot.endTime,
                                // Der Tag entscheidet (03.09.2026): ein Slot, dessen Tag
                                // vorbei ist, wird als abgeschlossener Termin übernommen.
                                status: statusForAppointmentDay(slot),
                                notes: slot.notes,
                                isLocked: true,
                            },
                        });
                        const technicianIds = [...new Set((slot.technicianAssignments || []).map((assignment: any) => assignment.technicianId).filter(Boolean))];
                        if (technicianIds.length) {
                            await (tx as any).projectAppointmentAssignment.createMany({
                                data: technicianIds.map((technicianId) => ({
                                    id: nanoid(10),
                                    appointmentId: appointment.id,
                                    technicianId,
                                })),
                                skipDuplicates: true,
                            });
                        }
                    }
                }

                await (tx as any).tender.update({
                    where: { id: tenderId },
                    data: {
                        status: 'Approved',
                        sourceStatus: 'Verkaufsauftrag',
                        projectId: project?.id || null,
                    },
                });

                await (tx as any).customerActivity.create({
                    data: {
                        id: nanoid(10),
                        customerId: tender.customerId,
                        employeeId,
                        activityType: 'SALES_ORDER_CREATED',
                        description: `${orderNumber} siparisi olusturuldu.`,
                        referenceId: salesOrder.id,
                        activityDate: new Date(),
                    },
                });

                await (tx as any).tenderActivityLog.create({
                    data: {
                        id: nanoid(12),
                        tenantId,
                        tenderId,
                        employeeId,
                        actionType: 'SALES_ORDER_CREATED',
                        fieldName: 'salesOrder',
                        oldValue: tender.status,
                        newValue: orderNumber,
                        description: `${orderNumber} siparisi olusturuldu.`,
                    },
                });

                return { salesOrder, project, reused: false };
            });

            res.status(result.reused ? 200 : 201).json({
                message: result.reused ? 'Bu teklif icin siparis zaten olusturulmus.' : 'Siparis olusturuldu.',
                ...result,
            });
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
