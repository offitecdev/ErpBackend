import { Prisma } from '@prisma/client';

import { GetBillingSummaryUseCase } from '../application/use-cases/billing/GetBillingSummaryUseCase';
import { InvoiceRepository } from '../infrastructure/repositories/InvoiceRepository';
import { billingTargetsForGroup } from './minderung';

/**
 * ── BUCHHALTUNG: ÜBERSICHTEN (17.09.2026, Schritt 7 / G14, G19) ─────────────
 *
 *   `loadToBill`         «Zu verrechnen» — was jetzt (oder bald) in Rechnung
 *                        gestellt werden sollte: fällige Raten, abgeschlossene
 *                        Projekte, gelieferte Lieferaufträge, offene Nachträge.
 *   `loadAccountingFigures`  die vier Zahlen der Rechnungsliste und die
 *                        Altersstruktur der überfälligen Beträge.
 *
 * Beide rechnen mit dem Kalendertag der Person (`today`), damit «fällig» und
 * «überfällig» dasselbe heissen wie in ihrer Liste.
 */

type Db = any;

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const DAY_MS = 86400000;
const SOON_DAYS = 14;

const isDay = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const dayOf = (value: Date | string | null | undefined): string | null => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
};
const daysBetween = (from: string, to: string) =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export type ToBillReason =
    | 'STAGE_DUE'       // Rate des Zahlungsplans ist fällig
    | 'STAGE_SOON'      // Rate wird in den nächsten 14 Tagen fällig
    | 'FIRST_STAGE'     // Anzahlung (erste Rate ohne Datum), noch nichts verrechnet
    | 'PROJECT_DONE'    // Projekt abgeschlossen, Rest offen
    | 'DELIVERED'       // Lieferauftrag mit unterschriebenem Lieferschein
    | 'ADDON'           // Nachtrag noch nicht (ganz) verrechnet
    | 'OPEN';           // offen, ohne Anlass

export type ToBillUrgency = 'NOW' | 'SOON' | 'LATER';

export interface ToBillItem {
    salesOrderId: string;
    orderNumber: string;
    isAddon: boolean;
    parentNumber: string | null;
    customerName: string | null;
    projectId: string | null;
    projectLabel: string | null;
    reason: ToBillReason;
    urgency: ToBillUrgency;
    dueDate: string | null;
    stageIndex: number | null;
    stageLabel: string | null;
    baseAmount: number;
    billedAmount: number;
    remainingAmount: number;
    proposedPercent: number;
    proposedAmount: number;
    proposedKind: 'RECHNUNG' | 'AKONTO' | 'ZWISCHEN' | 'SCHLUSS';
    draftId: string | null;
}

const DONE_PROJECT = new Set(['COMPLETED', 'SPECIALLY_CLOSED']);
const URGENCY_RANK: Record<ToBillUrgency, number> = { NOW: 0, SOON: 1, LATER: 2 };

export const loadToBill = async (db: Db, tenantId: string, today: string): Promise<ToBillItem[]> => {
    const day = isDay(today) ? today : new Date().toISOString().slice(0, 10);
    const orders: any[] = await db.salesOrder.findMany({
        where: { tenantId, cancelledAt: null, NOT: { status: 'CANCELLED' } },
        select: {
            id: true, orderNumber: true, parentSalesOrderId: true, totalAmount: true, paymentStages: true,
            projectId: true, createdAt: true,
            customer: { select: { companyName: true } },
            project: { select: { id: true, projectNumber: true, projectName: true, status: true } },
        },
    });
    if (!orders.length) return [];

    const byId = new Map(orders.map((row) => [row.id, row]));
    const addonsByParent = new Map<string, any[]>();
    for (const row of orders) {
        if (!row.parentSalesOrderId) continue;
        const bucket = addonsByParent.get(row.parentSalesOrderId);
        if (bucket) bucket.push(row);
        else addonsByParent.set(row.parentSalesOrderId, [row]);
    }
    const targets = orders
        .filter((row) => !row.parentSalesOrderId)
        .flatMap((row) => billingTargetsForGroup(row, addonsByParent.get(row.id) ?? [], true));
    // Nachträge, deren Hauptauftrag nicht (mehr) aktiv ist, stehen für sich.
    for (const row of orders) {
        if (row.parentSalesOrderId && !byId.has(row.parentSalesOrderId)) {
            targets.push({ salesOrderId: row.id, baseAmount: Math.max(0, Number(row.totalAmount || 0)), paymentStages: row.paymentStages ?? null });
        }
    }

    const ids = orders.map((row) => row.id);
    const repo = new InvoiceRepository();
    const [invoices, delivered, drafts] = await Promise.all([
        repo.listForOrders(tenantId, ids),
        db.deliveryReport.findMany({
            where: { tenantId, salesOrderId: { in: ids }, isSigned: true },
            select: { salesOrderId: true },
        }),
        db.invoice.findMany({
            where: { tenantId, salesOrderId: { in: ids }, status: 'DRAFT' },
            select: { id: true, salesOrderId: true },
            orderBy: { createdAt: 'desc' },
        }),
    ]);
    const summaries = new GetBillingSummaryUseCase(repo).buildBatchFromInvoices(targets as any, invoices as any);
    const deliveredIds = new Set(delivered.map((row: any) => row.salesOrderId));
    const draftByOrder = new Map<string, string>();
    for (const row of drafts) if (!draftByOrder.has(row.salesOrderId)) draftByOrder.set(row.salesOrderId, row.id);

    const items: ToBillItem[] = [];
    for (const target of targets) {
        const order = byId.get(target.salesOrderId);
        const summary: any = summaries.get(target.salesOrderId);
        if (!order || !summary) continue;
        if (Number(target.baseAmount) <= 0.005) continue;
        const remaining = Number(summary.remainingPercent || 0);
        if (remaining <= 0.005 || Number(summary.remainingAmount || 0) <= 0.005) continue;

        const parent = order.parentSalesOrderId ? byId.get(order.parentSalesOrderId) : null;
        const project = order.project ?? parent?.project ?? null;
        const billedPercent = Number(summary.billedPercent || 0);
        const next = summary.nextStage ?? null;
        const stage = next ? summary.paymentStages?.[next.index] ?? null : null;
        const stageDay = next?.date && isDay(String(next.date).slice(0, 10)) ? String(next.date).slice(0, 10) : null;

        let reason: ToBillReason = 'OPEN';
        let urgency: ToBillUrgency = 'LATER';
        if (project && DONE_PROJECT.has(String(project.status))) { reason = 'PROJECT_DONE'; urgency = 'NOW'; }
        else if (!project && deliveredIds.has(order.id)) { reason = 'DELIVERED'; urgency = 'NOW'; }
        else if (stageDay && stageDay <= day) { reason = 'STAGE_DUE'; urgency = 'NOW'; }
        else if (stageDay && daysBetween(day, stageDay) <= SOON_DAYS) { reason = 'STAGE_SOON'; urgency = 'SOON'; }
        else if (next && next.index === 0 && billedPercent <= 0.005 && !stageDay) { reason = 'FIRST_STAGE'; urgency = 'NOW'; }
        else if (order.parentSalesOrderId) { reason = 'ADDON'; urgency = 'SOON'; }

        // Vorschlag: bei fälliger Rate die Rate, sonst (Abschluss) der Rest.
        const useStage = next && (reason === 'STAGE_DUE' || reason === 'STAGE_SOON' || reason === 'FIRST_STAGE' || reason === 'OPEN');
        const percent = round2(Math.min(remaining, useStage ? Number(next.suggestedPercent || remaining) : remaining));
        const closes = percent >= remaining - 0.005;
        const amount = closes ? round2(Number(summary.remainingAmount || 0)) : round2((Number(target.baseAmount) * percent) / 100);
        const kind = closes ? (billedPercent > 0.005 ? 'SCHLUSS' : 'RECHNUNG') : (billedPercent > 0.005 ? 'ZWISCHEN' : 'AKONTO');

        items.push({
            salesOrderId: order.id,
            orderNumber: order.orderNumber,
            isAddon: Boolean(order.parentSalesOrderId),
            parentNumber: parent?.orderNumber ?? null,
            customerName: order.customer?.companyName ?? parent?.customer?.companyName ?? null,
            projectId: project?.id ?? null,
            projectLabel: project ? [project.projectNumber, project.projectName].filter(Boolean).join(' · ') : null,
            reason,
            urgency,
            dueDate: useStage ? stageDay : null,
            stageIndex: useStage ? next.index : null,
            stageLabel: useStage ? (stage?.label ?? null) : null,
            baseAmount: round2(Number(target.baseAmount)),
            billedAmount: round2(Number(summary.billedAmount || 0)),
            remainingAmount: round2(Number(summary.remainingAmount || 0)),
            proposedPercent: percent,
            proposedAmount: amount,
            proposedKind: kind,
            draftId: draftByOrder.get(order.id) ?? null,
        });
    }

    return items.sort((a, b) =>
        URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency]
        || String(a.dueDate ?? '9999').localeCompare(String(b.dueDate ?? '9999'))
        || a.orderNumber.localeCompare(b.orderNumber));
};

export interface AccountingFigures {
    open: { amount: number; count: number };
    overdue: { amount: number; count: number };
    issuedMonth: { amount: number; count: number };
    paidMonth: { amount: number; count: number };
    /** Überfällige offene Beträge nach Tagen seit Fälligkeit. */
    aging: Array<{ bucket: '1-30' | '31-60' | '61-90' | '90+'; amount: number; count: number }>;
    /** Gutschriften, deren Rückzahlung noch aussteht. */
    refundsOpen: { amount: number; count: number };
    toBillNow: number;
}

export const loadAccountingFigures = async (db: Db, tenantId: string, today: string): Promise<AccountingFigures> => {
    const day = isDay(today) ? today : new Date().toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const [openRows, issuedRows, paidRows, toBill] = await Promise.all([
        db.$queryRaw(Prisma.sql`
            SELECT i.id, i.kind, i.amount, i.dueDate,
                (SELECT COALESCE(SUM(p.amount), 0) FROM InvoicePayment p WHERE p.invoiceId = i.id) AS paidSum,
                (SELECT COALESCE(SUM(g.amount), 0) FROM Invoice g
                    WHERE g.reversesInvoiceId = i.id AND g.kind = 'GUTSCHRIFT' AND g.status <> 'DRAFT') AS creditSum
            FROM Invoice i
            WHERE i.tenantId = ${tenantId} AND i.status = 'ISSUED' AND i.kind <> 'STORNO'
        `) as Promise<any[]>,
        db.$queryRaw(Prisma.sql`
            SELECT COUNT(*) AS n, COALESCE(SUM(i.amount), 0) AS total
            FROM Invoice i
            WHERE i.tenantId = ${tenantId}
              AND i.status IN ('ISSUED', 'PAID') AND i.kind <> 'STORNO'
              AND DATE_FORMAT(COALESCE(i.invoiceDate, i.createdAt), '%Y-%m') = ${month}
        `) as Promise<any[]>,
        db.$queryRaw(Prisma.sql`
            SELECT COUNT(DISTINCT p.invoiceId) AS n, COALESCE(SUM(p.amount), 0) AS total
            FROM InvoicePayment p
            WHERE p.tenantId = ${tenantId} AND p.kind = 'PAYMENT'
              AND DATE_FORMAT(p.paidAt, '%Y-%m') = ${month}
        `) as Promise<any[]>,
        loadToBill(db, tenantId, day),
    ]);

    const figures: AccountingFigures = {
        open: { amount: 0, count: 0 },
        overdue: { amount: 0, count: 0 },
        issuedMonth: { amount: round2(Number(issuedRows[0]?.total ?? 0)), count: Number(issuedRows[0]?.n ?? 0) },
        paidMonth: { amount: round2(Number(paidRows[0]?.total ?? 0)), count: Number(paidRows[0]?.n ?? 0) },
        aging: [
            { bucket: '1-30', amount: 0, count: 0 },
            { bucket: '31-60', amount: 0, count: 0 },
            { bucket: '61-90', amount: 0, count: 0 },
            { bucket: '90+', amount: 0, count: 0 },
        ],
        refundsOpen: { amount: 0, count: 0 },
        toBillNow: toBill.filter((row) => row.urgency === 'NOW').length,
    };
    for (const row of openRows) {
        const amount = Math.abs(Number(row.amount || 0));
        const paid = Math.abs(Number(row.paidSum || 0));
        if (row.kind === 'GUTSCHRIFT') {
            const open = round2(amount - paid);
            if (open > 0.005) { figures.refundsOpen.amount = round2(figures.refundsOpen.amount + open); figures.refundsOpen.count += 1; }
            continue;
        }
        const open = round2(amount - paid - Math.abs(Number(row.creditSum || 0)));
        if (open <= 0.005) continue;
        figures.open.amount = round2(figures.open.amount + open);
        figures.open.count += 1;
        const due = dayOf(row.dueDate);
        if (!due || due >= day) continue;
        figures.overdue.amount = round2(figures.overdue.amount + open);
        figures.overdue.count += 1;
        const late = daysBetween(due, day);
        const bucket = figures.aging[late <= 30 ? 0 : late <= 60 ? 1 : late <= 90 ? 2 : 3]!;
        bucket.amount = round2(bucket.amount + open);
        bucket.count += 1;
    }
    return figures;
};
