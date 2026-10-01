"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaProcurementAutomationRepository = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const productionModule_1 = require("../../presentation/composition/productionModule");
const langOf = (value) => (value === 'de' || value === 'tr' || value === 'en' ? value : null);
const contactOf = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const raw = value;
    const name = String(raw.name ?? '').trim() || null;
    const email = String(raw.email ?? '').trim() || null;
    return name || email ? { name, email } : null;
};
class PrismaProcurementAutomationRepository {
    async linkMeta(tenantId, purchaseOrderIds) {
        const ids = [...new Set(purchaseOrderIds.filter(Boolean))];
        const map = new Map();
        if (!ids.length)
            return map;
        const rows = await prisma_client_1.default.productionBomPurchase.findMany({
            where: { tenantId, purchaseOrderId: { in: ids } },
            select: { purchaseOrderId: true, documentLanguage: true, supplierContact: true },
        }).catch(() => []);
        for (const row of rows) {
            map.set(row.purchaseOrderId, { documentLanguage: langOf(row.documentLanguage), supplierContact: contactOf(row.supplierContact) });
        }
        return map;
    }
    async setLinkMeta(tenantId, purchaseOrderId, patch) {
        await prisma_client_1.default.productionBomPurchase.updateMany({
            where: { tenantId, purchaseOrderId },
            data: {
                ...(patch.documentLanguage !== undefined ? { documentLanguage: patch.documentLanguage } : {}),
                ...(patch.supplierContact !== undefined
                    ? { supplierContact: (patch.supplierContact ?? client_1.Prisma.JsonNull) }
                    : {}),
            },
        });
    }
    async order(tenantId, purchaseOrderId) {
        return prisma_client_1.default.purchaseOrder.findFirst({ where: { id: purchaseOrderId, tenantId } });
    }
    /**
     * Die Empfänger-Adresse einer Preisanfrage/Bestellung (aus der Karte bzw.
     * dem Angebot) — auch im Eintrag des einen Lieferanten der Anfrage.
     */
    async setSupplierEmail(tenantId, purchaseOrderId, email) {
        const order = await this.order(tenantId, purchaseOrderId);
        if (!order)
            return;
        let suppliers = null;
        try {
            suppliers = JSON.parse(String(order.requestSuppliers ?? 'null'));
        }
        catch {
            suppliers = null;
        }
        const list = Array.isArray(suppliers)
            ? suppliers.map((entry, index) => (index === 0 && entry && typeof entry === 'object' ? { ...entry, supplierEmail: email } : entry))
            : null;
        await prisma_client_1.default.purchaseOrder.update({
            where: { id: order.id },
            data: { supplierEmail: email, ...(list ? { requestSuppliers: JSON.stringify(list) } : {}) },
        });
    }
    /** «z. Hd.» — der Ansprechpartner aus dem Angebot (nur, solange keiner eingetragen ist). */
    async setRecipientNameIfEmpty(tenantId, purchaseOrderId, name) {
        await prisma_client_1.default.purchaseOrder.updateMany({
            where: { id: purchaseOrderId, tenantId, OR: [{ recipientName: null }, { recipientName: '' }] },
            data: { recipientName: name.slice(0, 120) },
        });
    }
    /**
     * Die Sendung stempeln: wann, an wen, und — wo die Sendung den Stand
     * weiterbringt — der neue Stand (Anfrage → PRICE_REQUEST, Bestellung →
     * ORDERED = «Onay bekliyor»). Eine bestätigende Änderung zieht die Zeilen
     * der Produktion nach.
     */
    async markSent(tenantId, purchaseOrderId, input) {
        const order = await this.order(tenantId, purchaseOrderId);
        if (!order)
            return;
        let suppliers = null;
        try {
            suppliers = JSON.parse(String(order.requestSuppliers ?? 'null'));
        }
        catch {
            suppliers = null;
        }
        const sentAt = new Date();
        const list = Array.isArray(suppliers) && suppliers.length === 1
            ? [{ ...suppliers[0], emailSentAt: sentAt.toISOString(), emailRecipient: input.to }]
            : null;
        const updated = await prisma_client_1.default.purchaseOrder.update({
            where: { id: order.id },
            data: {
                emailSentAt: sentAt,
                emailRecipient: input.to.slice(0, 180),
                ...(input.statusAfter && input.statusAfter !== order.status ? { status: input.statusAfter } : {}),
                ...(list ? { requestSuppliers: JSON.stringify(list) } : {}),
            },
        });
        if (input.statusAfter && input.statusAfter !== order.status
            && await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId).catch(() => false)) {
            await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, {
                id: updated.id,
                referenceNumber: updated.referenceNumber,
                status: updated.status,
                supplierName: updated.supplierName,
                currency: updated.currency,
                items: updated.items,
            }, input.userId).catch(() => undefined);
        }
    }
}
exports.PrismaProcurementAutomationRepository = PrismaProcurementAutomationRepository;
//# sourceMappingURL=ProcurementAutomationRepository.js.map