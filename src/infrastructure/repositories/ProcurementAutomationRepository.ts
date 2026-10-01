import { Prisma } from '@prisma/client';

import prisma from '../database/prisma.client';
import { productionModule } from '../../presentation/composition/productionModule';

/**
 * ── DIE HANDGRIFFE DER AUTOMATIK AM BELEG (30.09.2026) ─────────────────────
 *
 * Was die Automatik der Produktion an einer Preisanfrage / Bestellung selbst
 * schreibt: Sprache und Ansprechpartner aus dem Angebot (an der Verknüpfung
 * `uretim_bom_siparisleri`), Empfänger-E-Mail und «z. Hd.» (am Beleg) und den
 * Stempel einer Sendung (emailSentAt, Stand). Ein Stand, der die Bestellung
 * bestätigt, zieht die Zeilen der Produktion nach — wie jeder andere Weg.
 */

export interface SupplierContact {
    name: string | null;
    email: string | null;
}

export interface LinkMeta {
    documentLanguage: 'de' | 'tr' | 'en' | null;
    supplierContact: SupplierContact | null;
}

const langOf = (value: unknown): LinkMeta['documentLanguage'] => (value === 'de' || value === 'tr' || value === 'en' ? value : null);

const contactOf = (value: unknown): SupplierContact | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const name = String(raw.name ?? '').trim() || null;
    const email = String(raw.email ?? '').trim() || null;
    return name || email ? { name, email } : null;
};

export class PrismaProcurementAutomationRepository {
    async linkMeta(tenantId: string, purchaseOrderIds: string[]): Promise<Map<string, LinkMeta>> {
        const ids = [...new Set(purchaseOrderIds.filter(Boolean))];
        const map = new Map<string, LinkMeta>();
        if (!ids.length) return map;
        const rows = await prisma.productionBomPurchase.findMany({
            where: { tenantId, purchaseOrderId: { in: ids } },
            select: { purchaseOrderId: true, documentLanguage: true, supplierContact: true },
        }).catch(() => []);
        for (const row of rows) {
            map.set(row.purchaseOrderId, { documentLanguage: langOf(row.documentLanguage), supplierContact: contactOf(row.supplierContact) });
        }
        return map;
    }

    async setLinkMeta(tenantId: string, purchaseOrderId: string, patch: Partial<LinkMeta>): Promise<void> {
        await prisma.productionBomPurchase.updateMany({
            where: { tenantId, purchaseOrderId },
            data: {
                ...(patch.documentLanguage !== undefined ? { documentLanguage: patch.documentLanguage } : {}),
                ...(patch.supplierContact !== undefined
                    ? { supplierContact: (patch.supplierContact ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue }
                    : {}),
            },
        });
    }

    async order(tenantId: string, purchaseOrderId: string) {
        return prisma.purchaseOrder.findFirst({ where: { id: purchaseOrderId, tenantId } });
    }

    /**
     * Die Empfänger-Adresse einer Preisanfrage/Bestellung (aus der Karte bzw.
     * dem Angebot) — auch im Eintrag des einen Lieferanten der Anfrage.
     */
    async setSupplierEmail(tenantId: string, purchaseOrderId: string, email: string): Promise<void> {
        const order = await this.order(tenantId, purchaseOrderId);
        if (!order) return;
        let suppliers: unknown = null;
        try { suppliers = JSON.parse(String(order.requestSuppliers ?? 'null')); } catch { suppliers = null; }
        const list = Array.isArray(suppliers)
            ? suppliers.map((entry, index) => (index === 0 && entry && typeof entry === 'object' ? { ...entry, supplierEmail: email } : entry))
            : null;
        await prisma.purchaseOrder.update({
            where: { id: order.id },
            data: { supplierEmail: email, ...(list ? { requestSuppliers: JSON.stringify(list) } : {}) },
        });
    }

    /** «z. Hd.» — der Ansprechpartner aus dem Angebot (nur, solange keiner eingetragen ist). */
    async setRecipientNameIfEmpty(tenantId: string, purchaseOrderId: string, name: string): Promise<void> {
        await prisma.purchaseOrder.updateMany({
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
    async markSent(tenantId: string, purchaseOrderId: string, input: { to: string; statusAfter: string | null; userId: string | null }): Promise<void> {
        const order = await this.order(tenantId, purchaseOrderId);
        if (!order) return;
        let suppliers: unknown = null;
        try { suppliers = JSON.parse(String(order.requestSuppliers ?? 'null')); } catch { suppliers = null; }
        const sentAt = new Date();
        const list = Array.isArray(suppliers) && suppliers.length === 1
            ? [{ ...(suppliers[0] as Record<string, unknown>), emailSentAt: sentAt.toISOString(), emailRecipient: input.to }]
            : null;
        const updated = await prisma.purchaseOrder.update({
            where: { id: order.id },
            data: {
                emailSentAt: sentAt,
                emailRecipient: input.to.slice(0, 180),
                ...(input.statusAfter && input.statusAfter !== order.status ? { status: input.statusAfter } : {}),
                ...(list ? { requestSuppliers: JSON.stringify(list) } : {}),
            },
        });
        if (input.statusAfter && input.statusAfter !== order.status
            && await productionModule.purchaseLink.isEnabled(tenantId).catch(() => false)) {
            await productionModule.purchaseLink.syncConfirmedLines(tenantId, {
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
