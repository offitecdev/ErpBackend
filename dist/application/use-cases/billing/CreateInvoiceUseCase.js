"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateInvoiceUseCase = void 0;
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const documentNumber_1 = require("../../../shared/documentNumber");
const invoiceErrors_1 = require("./invoiceErrors");
const invoiceDrafts_1 = require("../../../shared/invoiceDrafts");
const INVOICE_KINDS = ["RECHNUNG", "AKONTO", "ZWISCHEN", "SCHLUSS"];
const parseIsoDate = (value) => {
    if (!value)
        return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};
const DEFAULT_PARTIAL_PERCENT = 60;
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
class CreateInvoiceUseCase {
    invoiceRepository;
    constructor(invoiceRepository) {
        this.invoiceRepository = invoiceRepository;
    }
    async execute(input) {
        const { data, lineItems } = await this.build(input);
        if (input.draft) {
            // Der Entwurf trägt noch keine Nummer — sie wird erst beim
            // Ausstellen gezogen, damit die RE-Reihe keine Lücken bekommt.
            return this.invoiceRepository.createWithItems({ ...data, invoiceNumber: '', status: 'DRAFT' }, lineItems);
        }
        // Fatura kodu RE- serisinden gelir ve her dilde aynıdır. Eskiden
        // `countForTenant() + 1` kullanılıyordu; silinen/iptal edilen bir fatura
        // sayımı düşürdüğü için aynı numara ikinci kez dağıtılabiliyordu —
        // DocumentCounter yalnızca ileri gider.
        const invoiceNumber = await (0, documentNumber_1.nextDocumentNumber)(input.tenantId, 'INVOICE');
        return this.invoiceRepository.createWithItems({ ...data, invoiceNumber }, lineItems);
    }
    /**
     * Prüfen und rechnen, OHNE zu speichern. Erstellen, einen Entwurf neu
     * rechnen und einen Entwurf ausstellen benutzen dieselbe Strecke — ein
     * ausgestellter Entwurf rechnet also mit dem Stand beim Ausstellen.
     */
    async build(input) {
        const { tenantId, issuedByEmployeeId } = input;
        const salesOrderId = input.salesOrderId?.trim() || null;
        const projectId = input.projectId?.trim() || null;
        if ((!salesOrderId && !projectId) || (salesOrderId && projectId)) {
            throw (0, invoiceErrors_1.invoiceError)('ONE_TARGET', 'Faturalandırma için tek bir hedef (sipariş veya proje) belirtin.');
        }
        // Resolve base amount + line item sources
        let baseAmount = 0;
        let customerId = null;
        let resolvedProjectId = projectId;
        // Tekliften devralınan meta — istek göndermezse buradan doldurulur.
        let tenderSalesperson = null;
        let tenderCommission = null;
        const sources = [];
        if (salesOrderId) {
            const order = await prisma_client_1.default.salesOrder.findFirst({
                where: { id: salesOrderId, tenantId },
                include: {
                    tender: {
                        select: {
                            salespersonName: true,
                            commissionNumber: true,
                            // Verkäufer boşsa teklifin SAHİBİ satıcıdır — teklif PDF'i de
                            // Verkäufer satırında oluşturanı basar, fatura onu izler.
                            createdBy: { select: { firstName: true, lastName: true } },
                        },
                    },
                },
            });
            if (!order)
                throw (0, invoiceErrors_1.invoiceError)('ORDER_NOT_FOUND', 'Sipariş bulunamadı.', { status: 404 });
            // Ein stornierter Auftrag wird nicht mehr fakturiert (Vorgabe Samet
            // 06.09.2026): er steht als Beleg da, aber er verlangt kein Geld.
            if (order.cancelledAt || order.status === "CANCELLED") {
                throw (0, invoiceErrors_1.invoiceError)('ORDER_CANCELLED', 'Ein stornierter Auftrag kann nicht fakturiert werden.', { status: 409 });
            }
            // MINDERUNG (16.09.2026): ein Nachtrag mit Minussumme wird nicht
            // selbst verrechnet — er mindert die Grundlage seines Hauptauftrags.
            if (order.parentSalesOrderId && Number(order.totalAmount || 0) < 0) {
                throw (0, invoiceErrors_1.invoiceError)('ADDON_MINDERUNG_NOT_BILLABLE', 'Eine Minderung wird nicht selbst verrechnet — sie wird von der Rechnung des Hauptauftrags abgezogen.', { status: 409 });
            }
            baseAmount = Number(order.totalAmount || 0);
            customerId = order.customerId || null;
            resolvedProjectId = order.projectId || null;
            const tenderCreator = [order.tender?.createdBy?.firstName, order.tender?.createdBy?.lastName]
                .filter(Boolean).join(" ").trim();
            tenderSalesperson = order.tender?.salespersonName || tenderCreator || null;
            tenderCommission = order.tender?.commissionNumber || null;
            sources.push({
                description: `Sipariş ${order.orderNumber}`,
                sourceType: "ORDER",
                sourceId: order.id,
                quantity: 1,
                unitAmount: baseAmount,
                lineTotal: baseAmount,
            });
            // Die aktiven Minderungen des Hauptauftrags stehen als eigene
            // Minuszeilen auf der Rechnung und senken ihre Grundlage.
            if (!order.parentSalesOrderId) {
                const minderungen = await prisma_client_1.default.salesOrder.findMany({
                    where: {
                        tenantId,
                        parentSalesOrderId: order.id,
                        cancelledAt: null,
                        NOT: { status: "CANCELLED" },
                        totalAmount: { lt: 0 },
                    },
                    orderBy: [{ revisionNumber: "asc" }, { createdAt: "asc" }],
                    select: { id: true, orderNumber: true, totalAmount: true },
                });
                for (const addon of minderungen) {
                    const amount = Number(addon.totalAmount || 0);
                    baseAmount = round2(baseAmount + amount);
                    sources.push({
                        description: `Minderung ${addon.orderNumber}`,
                        sourceType: "ORDER",
                        sourceId: addon.id,
                        quantity: 1,
                        unitAmount: amount,
                        lineTotal: amount,
                    });
                }
            }
        }
        else if (projectId) {
            const project = await prisma_client_1.default.project.findFirst({
                where: { id: projectId, tenantId },
                include: { salesOrders: { select: { id: true, orderNumber: true, totalAmount: true, cancelledAt: true } } },
            });
            if (!project)
                throw (0, invoiceErrors_1.invoiceError)('PROJECT_NOT_FOUND', 'Proje bulunamadı.', { status: 404 });
            if (project.cancelledAt || project.status === "CANCELLED") {
                throw (0, invoiceErrors_1.invoiceError)('PROJECT_CANCELLED', 'Ein storniertes Projekt kann nicht fakturiert werden.', { status: 409 });
            }
            customerId = project.customerId || null;
            // Stornierte Auftraege zaehlen nicht mehr zur Rechnungsgrundlage.
            const orders = (project.salesOrders || []).filter((row) => !row.cancelledAt);
            if (orders.length > 0) {
                for (const order of orders) {
                    const amount = Number(order.totalAmount || 0);
                    baseAmount += amount;
                    sources.push({
                        description: `Sipariş ${order.orderNumber}`,
                        sourceType: "ORDER",
                        sourceId: order.id,
                        quantity: 1,
                        unitAmount: amount,
                        lineTotal: amount,
                    });
                }
            }
            if (baseAmount <= 0) {
                baseAmount = Number(project.plannedBudget || 0);
                sources.length = 0;
                sources.push({
                    description: `Proje ${project.projectName} (planlanan bütçe)`,
                    sourceType: "MANUAL",
                    sourceId: project.id,
                    quantity: 1,
                    unitAmount: baseAmount,
                    lineTotal: baseAmount,
                });
            }
        }
        if (baseAmount <= 0) {
            throw (0, invoiceErrors_1.invoiceError)('NOTHING_TO_BILL', 'Faturalandırılacak tutar bulunamadı (0).');
        }
        // Invoices accumulate: each billing action creates a NEW invoice and the
        // summed billedPercent across active invoices is the billing progress
        // (matches GetBillingSummaryUseCase). Corrections go through the cancel
        // flow, which releases the cancelled invoice's percentage again.
        const billed = salesOrderId
            ? await this.invoiceRepository.sumBilledForOrder(salesOrderId)
            : await this.invoiceRepository.sumBilledForProject(projectId);
        const billedSoFar = billed.percent;
        const remaining = Math.max(0, round2(100 - billedSoFar));
        if (remaining <= 0.005) {
            throw (0, invoiceErrors_1.invoiceError)('FULLY_BILLED', 'Bu hedef zaten tamamen faturalandırılmış.', { status: 409 });
        }
        // Fatura türü: istemci gönderirse doğrula, göndermezse billingType +
        // mevcut faturalandırma durumundan türet (eski istemciler değişmeden
        // çalışsın diye).
        let kind;
        if (input.kind) {
            if (!INVOICE_KINDS.includes(input.kind)) {
                throw (0, invoiceErrors_1.invoiceError)('INVALID_KIND', 'Geçersiz fatura türü.');
            }
            kind = input.kind;
        }
        else {
            // Die Art wird NIE gefragt (G17): sie folgt aus dem Prozentsatz.
            // Ein Prozentsatz, der genau den offenen Rest trifft, schliesst ab.
            const requested = input.percent == null ? null : Number(input.percent);
            const coversRest = requested != null && Number.isFinite(requested)
                && Math.abs(requested - remaining) <= 0.005;
            const closes = input.billingType === "FULL"
                || (input.billingType == null && requested == null)
                || coversRest;
            if (closes)
                kind = billedSoFar > 0.005 ? "SCHLUSS" : "RECHNUNG";
            else
                kind = billedSoFar > 0.005 ? "ZWISCHEN" : "AKONTO";
        }
        if (kind === "RECHNUNG" && billedSoFar > 0.005) {
            throw (0, invoiceErrors_1.invoiceError)('FULL_ONLY_FIRST', 'Tam fatura yalnızca hiç fatura kesilmemişken oluşturulabilir. Kalan tutar için Schlussrechnung kullanın.', { status: 409 });
        }
        // Determine percent. RECHNUNG/SCHLUSS = the open remainder;
        // AKONTO/ZWISCHEN = requested (default 60%), capped by what is open.
        let percent;
        if (kind === "RECHNUNG" || kind === "SCHLUSS") {
            percent = remaining;
        }
        else {
            const requested = input.percent == null ? DEFAULT_PARTIAL_PERCENT : Number(input.percent);
            if (!Number.isFinite(requested) || requested <= 0 || requested > 100) {
                throw (0, invoiceErrors_1.invoiceError)('INVALID_PERCENT', 'Geçersiz faturalandırma oranı. 0 ile 100 arasında olmalıdır.');
            }
            if (requested > remaining + 0.005) {
                throw (0, invoiceErrors_1.invoiceError)('MAX_PERCENT', `En fazla %${remaining} faturalandırılabilir.`, { params: { percent: remaining } });
            }
            percent = round2(requested);
        }
        // KAPANIŞ FATURASI KALAN FRANKI ALIR (Vorgabe 19.08.2026). Yüzdeden
        // hesaplanan tutar her faturada kuruşa yuvarlandığı için (%33.33 +
        // %33.33 + %33.34 → 4'094.99 ≠ 4'095.00), hedefi %100'e tamamlayan
        // fatura yüzdesinden değil, AÇIK BAKİYEDEN hesaplanır: böylece
        // faturaların toplamı sözleşme tutarına birebir oturur ve geriye 0.01
        // bile kalmaz. Aradaki fark sipariş toplamı sonradan değiştiği için
        // büyümüşse de kapanış faturası onu kapatır — açık bakiye 0'dır.
        const closesTarget = percent >= remaining - 0.005;
        const amount = closesTarget
            ? Math.max(0, round2(baseAmount - billed.amount))
            : round2((baseAmount * percent) / 100);
        // MINDERUNG (16.09.2026): trägt ein Auftrag Minderungen, schliesst die
        // Schlussrechnung JEDE Quelle für sich ab — Auftrag und jede Minderung
        // mit dem, was von ihr noch nicht auf früheren Rechnungen stand. Eine
        // Minderung nach einer Akontorechnung erscheint so mit ihrem vollen
        // Betrag, statt auf den Prozentsatz der Schlussrechnung geschrumpft.
        const hasMinderung = Boolean(salesOrderId) && sources.length > 1;
        const previousBySource = new Map();
        if (hasMinderung && closesTarget) {
            const previous = await prisma_client_1.default.invoiceLineItem.findMany({
                where: { invoice: { salesOrderId, tenantId, ...invoiceDrafts_1.billedInvoiceWhere } },
                select: { sourceId: true, lineTotal: true },
            });
            for (const row of previous) {
                if (!row.sourceId)
                    continue;
                previousBySource.set(row.sourceId, round2((previousBySource.get(row.sourceId) ?? 0) + Number(row.lineTotal || 0)));
            }
        }
        // Scale line items by percent
        const lineItems = sources.map((source, index) => {
            const isOrderLine = index === 0;
            const lineTotal = hasMinderung && closesTarget
                ? round2(source.lineTotal - (previousBySource.get(source.sourceId ?? '') ?? 0))
                : round2((source.lineTotal * percent) / 100);
            const scaledLabel = percent < 100 && (!hasMinderung || !closesTarget || isOrderLine);
            return {
                description: scaledLabel ? `${source.description} (%${percent})` : source.description,
                sourceType: source.sourceType,
                sourceId: source.sourceId ?? null,
                quantity: source.quantity,
                unitAmount: lineTotal,
                lineTotal,
                sortOrder: index,
            };
        });
        // Kalemler faturanın tutarını AYNEN toplamalı: kapanışta oluşan yuvarlama
        // farkı son kaleme yazılır (tek kalemli sipariş faturasında bu, kalemi
        // doğrudan kalan bakiyeye eşitler). Mit Minderungen trägt ihn die
        // Auftragszeile — die Minderungszeilen bleiben ihre eigenen Beträge.
        const lastItem = hasMinderung ? lineItems[0] : lineItems[lineItems.length - 1];
        if (lastItem) {
            const drift = round2(amount - lineItems.reduce((sum, item) => sum + item.lineTotal, 0));
            if (drift !== 0) {
                lastItem.lineTotal = round2(lastItem.lineTotal + drift);
                lastItem.unitAmount = lastItem.lineTotal;
            }
        }
        const invoiceData = {
            tenantId,
            customerId,
            projectId: resolvedProjectId,
            salesOrderId,
            // billingType, kind'dan türetilir ki ikisi asla çelişmesin.
            billingType: (kind === "RECHNUNG" || kind === "SCHLUSS" ? "FULL" : "PARTIAL"),
            kind,
            invoiceDate: parseIsoDate(input.invoiceDate) ?? new Date(),
            // Fälligkeit gönderilmezse Rechnungsdatum'a eşitlenir — iki tarih
            // çoğunlukla aynı gündür (kullanıcı isteği), belge boş satır basmaz.
            dueDate: parseIsoDate(input.dueDate) ?? parseIsoDate(input.invoiceDate) ?? new Date(),
            salespersonName: input.salespersonName?.trim() || tenderSalesperson,
            commissionNumber: input.commissionNumber?.trim() || tenderCommission,
            billedPercent: percent,
            baseAmount: round2(baseAmount),
            amount,
            status: "ISSUED",
            notes: input.notes?.trim() || null,
            issuedByEmployeeId,
        };
        return { data: invoiceData, lineItems };
    }
}
exports.CreateInvoiceUseCase = CreateInvoiceUseCase;
//# sourceMappingURL=CreateInvoiceUseCase.js.map