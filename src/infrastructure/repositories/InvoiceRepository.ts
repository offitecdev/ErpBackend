import { Prisma } from "@prisma/client";
import prisma from "../database/prisma.client";
import { Invoice, InvoiceCategory, InvoiceStatus } from "../../domain/entities/Invoice";
import { BilledSoFar, IInvoiceFilter, IInvoiceRepository, InvoiceLineItemInput, InvoiceListItem, InvoiceSummaryRow } from "../../domain/repositories/IInvoiceRepository";

/**
 * Rechnungstyp aus dem Beleg ABLEITEN, an dem die Rechnung hängt — sie trägt
 * keine eigene Spalte dafür (siehe `InvoiceCategory`):
 *  - ein Projekt am Beleg          → Projektauftrag
 *  - ein Auftrag ohne Projekt      → Lieferauftrag (Auftragsart INVOICE/REGIE)
 *  - weder Auftrag noch Projekt    → Direktrechnung (selbst ausgefüllt)
 *
 * Wandert ein Auftrag später in ein Projekt, wandern seine Rechnungen mit,
 * ohne dass irgendwo nachgetragen werden müsste.
 */
export const deriveInvoiceCategory = (row: {
    projectId?: string | null;
    salesOrderId?: string | null;
    orderType?: string | null;
}): InvoiceCategory => {
    if (row.projectId) return "PROJECT";
    if (row.salesOrderId) return String(row.orderType || "").startsWith("PROJECT") ? "PROJECT" : "DELIVERY";
    return "DIRECT";
};

const invoiceInclude = {
    // Positionsreihenfolge ist eine Angabe des Belegs, keine Zufälligkeit der
    // Abfrage — die Direktrechnung setzt sie beim Speichern.
    lineItems: { orderBy: { sortOrder: 'asc' as const } },
    customer: { select: { id: true, companyName: true } },
    project: { select: { id: true, projectNumber: true, projectName: true } },
    salesOrder: { select: { id: true, orderNumber: true, orderType: true } },
    issuedBy: { select: { id: true, firstName: true, lastName: true } },
};

export class InvoiceRepository implements IInvoiceRepository {
    async createWithItems(invoice: Partial<Invoice>, items: InvoiceLineItemInput[]): Promise<Invoice> {
        return (await prisma.$transaction(async (tx) => {
            const created = await (tx as any).invoice.create({ data: invoice as any });
            if (items.length > 0) {
                await (tx as any).invoiceLineItem.createMany({
                    data: items.map((item) => ({ ...item, invoiceId: created.id })),
                });
            }
            return (tx as any).invoice.findUnique({ where: { id: created.id }, include: invoiceInclude });
        })) as unknown as Invoice;
    }

    async updateWithItems(id: string, invoice: Partial<Invoice>, items: InvoiceLineItemInput[]): Promise<Invoice> {
        return (await prisma.$transaction(async (tx) => {
            await (tx as any).invoice.update({ where: { id }, data: invoice as any });
            await (tx as any).invoiceLineItem.deleteMany({ where: { invoiceId: id } });
            if (items.length > 0) {
                await (tx as any).invoiceLineItem.createMany({
                    data: items.map((item) => ({ ...item, invoiceId: id })),
                });
            }
            return (tx as any).invoice.findUnique({ where: { id }, include: invoiceInclude });
        })) as unknown as Invoice;
    }

    async findActiveByOrder(salesOrderId: string, tenantId: string): Promise<Invoice | null> {
        return (await (prisma as any).invoice.findFirst({
            where: { salesOrderId, tenantId, status: { not: "CANCELLED" } },
            include: invoiceInclude,
        })) as unknown as Invoice | null;
    }

    async findActiveByProject(projectId: string, tenantId: string): Promise<Invoice | null> {
        return (await (prisma as any).invoice.findFirst({
            where: { projectId, tenantId, status: { not: "CANCELLED" } },
            include: invoiceInclude,
        })) as unknown as Invoice | null;
    }

    async findById(id: string, tenantId: string): Promise<Invoice | null> {
        return (await (prisma as any).invoice.findFirst({
            where: { id, tenantId },
            include: invoiceInclude,
        })) as unknown as Invoice | null;
    }

    /**
     * Fatura listesi — cevap şekli `invoiceInclude` ile birebir aynı, ama iki
     * PARALEL ifadeyle üretiliyor (eskiden altı ARDIŞIK ifade).
     *
     * Prisma'da her `include` ayrı bir sorgu turu demek: veritabanı uzak olduğu
     * için (ifade başına ~100 ms) müşteri/proje/sipariş/personel/kalem ilişkileri
     * tek başına ~450 ms tutuyordu. Skaler ilişkiler artık tek JOIN'de geliyor;
     * kalemler ise aynı WHERE'i alt sorgu olarak kullandığı için sayfa id'lerini
     * beklemek zorunda değil, ilk sorguyla eş zamanlı koşuyor.
     */
    async list(filter: IInvoiceFilter): Promise<InvoiceListItem[]> {
        const conditions: Prisma.Sql[] = [Prisma.sql`i.tenantId = ${filter.tenantId}`];
        if (filter.projectId) conditions.push(Prisma.sql`i.projectId = ${filter.projectId}`);
        if (filter.salesOrderId) conditions.push(Prisma.sql`i.salesOrderId = ${filter.salesOrderId}`);
        if (filter.customerId) conditions.push(Prisma.sql`i.customerId = ${filter.customerId}`);
        if (filter.status) conditions.push(Prisma.sql`i.status = ${filter.status}`);
        // Der Typ steckt nicht in einer Spalte, sondern in der Kombination
        // Projekt/Auftrag/Auftragsart — die Bedingung wird darum GENAUSO
        // formuliert wie die Ableitung selbst (`deriveInvoiceCategory`), damit
        // Filter und angezeigter Typ nie auseinanderlaufen.
        if (filter.category === 'PROJECT') {
            conditions.push(Prisma.sql`(i.projectId IS NOT NULL OR so.orderType LIKE 'PROJECT%')`);
        } else if (filter.category === 'DELIVERY') {
            conditions.push(Prisma.sql`(i.projectId IS NULL AND i.salesOrderId IS NOT NULL AND (so.orderType IS NULL OR so.orderType NOT LIKE 'PROJECT%'))`);
        } else if (filter.category === 'DIRECT') {
            conditions.push(Prisma.sql`(i.projectId IS NULL AND i.salesOrderId IS NULL)`);
        }
        const whereSql = Prisma.join(conditions, ' AND ');
        // Die Unterabfrage der Positionen braucht denselben Auftrags-JOIN, sonst
        // stünde `so.orderType` dort ohne Tabelle.
        const scopeSql = Prisma.sql`
            FROM Invoice i
            LEFT JOIN SalesOrder so ON so.id = i.salesOrderId
            WHERE ${whereSql}
        `;

        const [rows, lineItems] = await Promise.all([
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT
                    i.id, i.tenantId, i.customerId, i.projectId, i.salesOrderId,
                    i.invoiceNumber, i.billingType, i.kind, i.invoiceDate, i.dueDate,
                    i.salespersonName, i.commissionNumber, i.billedPercent, i.baseAmount,
                    i.amount, i.status, i.notes, i.issuedByEmployeeId,
                    i.recipientName, i.recipientAddress, i.introText, i.vatRate,
                    i.createdAt, i.updatedAt,
                    c.companyName AS customerCompanyName,
                    pr.projectName AS projectName,
                    pr.projectNumber AS projectNumber,
                    so.orderNumber AS orderNumber,
                    so.orderType AS orderType,
                    -- Die Offerte hinter dem Auftrag: OHNE sie druckt die
                    -- Gesamtrechnung aus der Liste nur eine Sammelzeile statt
                    -- der Positionen (siehe utils/pdf/invoicePdf.ts).
                    so.tenderId AS orderTenderId,
                    so.paymentStages AS orderPaymentStages,
                    e.firstName AS issuerFirstName,
                    e.lastName AS issuerLastName
                FROM Invoice i
                LEFT JOIN Customer c ON c.id = i.customerId
                LEFT JOIN Project pr ON pr.id = i.projectId
                LEFT JOIN SalesOrder so ON so.id = i.salesOrderId
                LEFT JOIN Employee e ON e.id = i.issuedByEmployeeId
                WHERE ${whereSql}
                -- Neueste zuoberst. Alte Zeilen haben kein Rechnungsdatum, für
                -- sie zählt der Anlagezeitpunkt — sonst fielen sie ans Ende.
                ORDER BY COALESCE(i.invoiceDate, i.createdAt) DESC, i.invoiceNumber DESC
            `),
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
                SELECT li.id, li.invoiceId, li.description, li.sourceType, li.sourceId,
                       li.quantity, li.unitAmount, li.lineTotal, li.unit, li.sortOrder
                FROM InvoiceLineItem li
                WHERE li.invoiceId IN (SELECT i.id ${scopeSql})
                ORDER BY li.sortOrder ASC
            `),
        ]);

        const itemsByInvoice = new Map<string, any[]>();
        for (const item of lineItems) {
            const bucket = itemsByInvoice.get(item.invoiceId);
            if (bucket) bucket.push(item);
            else itemsByInvoice.set(item.invoiceId, [item]);
        }

        return rows.map((row) => ({
            id: row.id,
            tenantId: row.tenantId,
            customerId: row.customerId ?? null,
            projectId: row.projectId ?? null,
            salesOrderId: row.salesOrderId ?? null,
            invoiceNumber: row.invoiceNumber,
            billingType: row.billingType,
            kind: row.kind ?? 'RECHNUNG',
            // Der Typ ist ABGELEITET (keine Spalte) — hier einmal berechnet,
            // damit Liste, Filter und PDF dieselbe Antwort sehen.
            category: deriveInvoiceCategory(row),
            orderType: row.orderType ?? null,
            invoiceDate: row.invoiceDate ?? null,
            dueDate: row.dueDate ?? null,
            salespersonName: row.salespersonName ?? null,
            commissionNumber: row.commissionNumber ?? null,
            billedPercent: Number(row.billedPercent ?? 0),
            baseAmount: Number(row.baseAmount ?? 0),
            amount: Number(row.amount ?? 0),
            status: row.status,
            notes: row.notes ?? null,
            // Direktrechnung: Empfänger, Einleitung und Steuersatz stehen auf
            // der Rechnung selbst; bei Auftragsrechnungen sind sie leer.
            recipientName: row.recipientName ?? null,
            recipientAddress: row.recipientAddress ?? null,
            introText: row.introText ?? null,
            vatRate: row.vatRate == null ? null : Number(row.vatRate),
            issuedByEmployeeId: row.issuedByEmployeeId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            lineItems: itemsByInvoice.get(row.id) ?? [],
            customer: row.customerId
                ? { id: row.customerId, companyName: row.customerCompanyName }
                : null,
            project: row.projectId
                ? { id: row.projectId, projectNumber: row.projectNumber ?? null, projectName: row.projectName }
                : null,
            salesOrder: row.salesOrderId
                ? {
                    id: row.salesOrderId,
                    orderNumber: row.orderNumber,
                    orderType: row.orderType ?? null,
                    tenderId: row.orderTenderId ?? null,
                    paymentStages: row.orderPaymentStages ?? null,
                }
                : null,
            issuedBy: row.issuedByEmployeeId
                ? { id: row.issuedByEmployeeId, firstName: row.issuerFirstName, lastName: row.issuerLastName }
                : null,
        })) as unknown as InvoiceListItem[];
    }

    // Feeds the batch billing summary only, so it selects the summary columns
    // instead of the full `invoiceInclude` — no line items, no joined customer /
    // project / order / employee rows for every invoice of every listed order.
    async listForOrders(tenantId: string, salesOrderIds: string[]): Promise<InvoiceSummaryRow[]> {
        if (salesOrderIds.length === 0) return [];
        return (await (prisma as any).invoice.findMany({
            where: { tenantId, salesOrderId: { in: salesOrderIds } },
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                salesOrderId: true,
                invoiceNumber: true,
                billingType: true,
                kind: true,
                billedPercent: true,
                amount: true,
                status: true,
                createdAt: true,
            },
        })) as unknown as InvoiceSummaryRow[];
    }

    async countForTenant(tenantId: string): Promise<number> {
        return (prisma as any).invoice.count({ where: { tenantId } });
    }

    // Yüzde ve tutar AYNI toplama sorgusundan gelir — kapanış faturası kalan
    // frankı kuruşu kuruşuna alacağı için ikisine de ihtiyaç var, ek tur yok.
    private async sumBilled(where: any): Promise<BilledSoFar> {
        const agg = await (prisma as any).invoice.aggregate({
            where: { ...where, status: { not: "CANCELLED" } },
            _sum: { billedPercent: true, amount: true },
        });
        return {
            percent: Number(agg?._sum?.billedPercent || 0),
            amount: Number(agg?._sum?.amount || 0),
        };
    }

    async sumBilledForOrder(salesOrderId: string): Promise<BilledSoFar> {
        return this.sumBilled({ salesOrderId });
    }

    async sumBilledForProject(projectId: string): Promise<BilledSoFar> {
        return this.sumBilled({ projectId });
    }

    async updateStatus(id: string, tenantId: string, status: InvoiceStatus): Promise<Invoice> {
        const existing = await (prisma as any).invoice.findFirst({ where: { id, tenantId } });
        if (!existing) throw new Error("Fatura bulunamadı.");
        await (prisma as any).invoice.update({ where: { id }, data: { status } });
        return (await (prisma as any).invoice.findUnique({ where: { id }, include: invoiceInclude })) as unknown as Invoice;
    }

    async delete(id: string, tenantId: string): Promise<void> {
        const existing = await (prisma as any).invoice.findFirst({ where: { id, tenantId } });
        if (!existing) throw new Error("Fatura bulunamadı.");
        await prisma.$transaction(async (tx) => {
            await (tx as any).invoiceLineItem.deleteMany({ where: { invoiceId: id } });
            await (tx as any).invoice.delete({ where: { id } });
        });
    }
}
