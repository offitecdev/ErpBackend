"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PrismaBomRevisionWriter = void 0;
const nanoid_1 = require("nanoid");
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const productionBom_1 = require("../../domain/services/productionBom");
const WarehouseCodeIssuer_1 = require("../repositories/WarehouseCodeIssuer");
const ProductionBomRevisionRepository_1 = require("../repositories/ProductionBomRevisionRepository");
/* Dieselbe Rechenstelle wie jede Lieferantenbestellung (wie im BOM-Writer:
   zur Laufzeit gerufen, inventory.routes importiert diese Datei nicht). */
const inventory_routes_1 = require("../../presentation/routes/inventory.routes");
const productionModule_1 = require("../../presentation/composition/productionModule");
/**
 * ── EINE REVISION FREIGEBEN · IN EINEM VORGANG (27.09.2026) ──────────────────
 *
 * «Sistem tedarikçiye gitmiş siparişi sessizce değiştirmez … satınalmacı
 *  onaylar» — was hier geschrieben wird, hat die Freigabe vorher gezeigt und
 * der Einkauf bestätigt. Alles oder nichts: die BOM (Revision, Stand), ihre
 * Zeilen, der Datensatz der Revision, die Haupt-BOM darüber und die
 * Bestellungen. Hat sich die BOM inzwischen geändert (eine andere Freigabe
 * war schneller), geschieht nichts.
 *
 * Eine Bestellung beim Lieferanten (REVISE) behält ihre Nummer: die Fassung
 * davor geht samt Bestätigung des Lieferanten ins Archiv
 * (uretim_bom_siparis_revizyonlari), `PurchaseOrder.revision` zählt hoch (die
 * nächste Mail trägt «aktualisiert»), die Bestätigung ist neu nötig — ein
 * bestätigter Stand geht zurück auf «bestellt».
 */
class RevisionConflict extends Error {
}
const parseItems = (raw) => {
    try {
        const parsed = JSON.parse(String(raw ?? '[]'));
        return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
    }
    catch {
        return [];
    }
};
const EPS = 1e-9;
/** Die geplante Änderung an der Stelle `index` einer Bestellung. */
const byIndexOf = (write, index) => write.items.find((entry) => entry.index === index);
/** Die Zeilen der Verknüpfung (wie bestellt wurde) auf die neuen Mengen nachziehen. */
const linkLinesAfter = (raw, items) => {
    const ordered = new Map();
    for (const item of items) {
        const bomLineId = typeof item.bomLineId === 'string' ? item.bomLineId : null;
        if (bomLineId)
            ordered.set(bomLineId, (0, productionBom_1.round3)((ordered.get(bomLineId) ?? 0) + (Number(item.quantity) || 0)));
    }
    const records = (Array.isArray(raw) ? raw : []).filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
    return records
        .filter((record) => ordered.has(String(record.bomLineId ?? '')))
        .map((record) => ({ ...record, ordered: ordered.get(String(record.bomLineId)) }));
};
class PrismaBomRevisionWriter {
    async apply(input) {
        const { tenantId, userId } = input;
        const result = { updated: [], deleted: [] };
        try {
            await prisma_client_1.default.$transaction(async (tx) => {
                // 1) Die BOM beanspruchen — nur, wenn sie noch die Revision trägt, von der die Freigabe ausging.
                const claimed = await tx.productionBom.updateMany({
                    where: {
                        id: input.bom.id,
                        tenantId,
                        revision: input.bom.revision,
                        status: { in: ['APPROVED', 'COMPLETED'] },
                        consumedAt: null,
                    },
                    data: {
                        revision: input.newRevision,
                        // Eine abgeschlossene BOM ist nach der Revision wieder nur freigegeben:
                        // Bestellung, Bestätigung und Reservierung gelten neu.
                        status: 'APPROVED',
                        completedAt: null,
                        completedById: null,
                        updatedById: userId,
                    },
                });
                if (!claimed.count)
                    throw new RevisionConflict();
                // 2) Die Zeilen der neuen Revision — mit ihren Kennungen (je Karte dieselbe wie bisher).
                await tx.productionBomLine.deleteMany({ where: { bomId: input.bom.id, tenantId } });
                if (input.lines.length) {
                    await tx.productionBomLine.createMany({
                        data: input.lines.map((line, index) => ({
                            id: line.id,
                            tenantId,
                            bomId: input.bom.id,
                            productId: line.productId,
                            erpCode: line.erpCode,
                            name: line.name.slice(0, 255),
                            brand: line.brand,
                            modelNumber: line.modelNumber,
                            unit: line.unit,
                            quantity: new client_1.Prisma.Decimal((0, productionBom_1.round3)(line.quantity)),
                            consumedQuantity: new client_1.Prisma.Decimal(0),
                            note: line.note,
                            sortOrder: index,
                        })),
                    });
                }
                // 3) Die Revision freigeben (der Abzug ihrer Zeilen, der Unterschied, was mit den Bestellungen geschah).
                const approved = await tx.productionBomRevision.updateMany({
                    where: { id: input.draftId, tenantId, bomId: input.bom.id, status: 'DRAFT', revision: input.newRevision },
                    data: {
                        status: 'APPROVED',
                        lines: (0, ProductionBomRevisionRepository_1.revisionLinesJson)(input.lines),
                        changes: input.changes,
                        orderActions: input.orderActions,
                        approvedById: userId,
                        approvedAt: new Date(),
                    },
                });
                if (!approved.count)
                    throw new RevisionConflict();
                // 4) Die Haupt-BOM darüber war abgeschlossen: jetzt ist eine Alt-BOM wieder offen.
                if (input.bom.kind === 'SUB' && input.bom.parentBomId) {
                    await tx.productionBom.updateMany({
                        where: { id: input.bom.parentBomId, tenantId, status: 'COMPLETED', consumedAt: null },
                        data: { status: 'APPROVED', completedAt: null, completedById: null, updatedById: userId },
                    });
                }
                // 5) Die Bestellungen.
                for (const write of input.orders) {
                    const row = await tx.purchaseOrder.findFirst({ where: { id: write.purchaseOrderId, tenantId } });
                    if (!row)
                        continue;
                    const link = await tx.productionBomPurchase.findFirst({ where: { tenantId, purchaseOrderId: row.id } });
                    // Was die Vorschau an jeder geplanten Position sah (Menge davor).
                    const beforeByIndex = new Map(write.changes.map((line) => [line.index, (0, productionBom_1.round3)(line.before)]));
                    const seen = new Set();
                    if (write.mode === 'DELETE') {
                        // Ein Entwurf, der nie beim Lieferanten war und dessen Zeilen alle wegfallen —
                        // aber nur, wenn er noch genau diese Zeilen trägt («Sipariş oluştur» legt
                        // inzwischen vielleicht neue in denselben Entwurf).
                        const current = parseItems(row.items);
                        const unchanged = current.length === write.items.length && current.every((item, index) => byIndexOf(write, index)?.bomLineId === item.bomLineId
                            && Math.abs((0, productionBom_1.round3)(Number(item.quantity) || 0) - (beforeByIndex.get(index) ?? Number.NaN)) <= EPS);
                        if (!unchanged)
                            throw new RevisionConflict();
                        await productionModule_1.productionModule.purchaseLink.removeForPurchaseOrder(tenantId, row.id, tx);
                        await tx.purchaseOrder.delete({ where: { id: row.id } });
                        await tx.productionBomPurchase.deleteMany({ where: { tenantId, purchaseOrderId: row.id } });
                        result.deleted.push({ id: row.id, quoteFileRef: link?.quoteFileRef ?? null });
                        continue;
                    }
                    const byIndex = new Map(write.items.map((entry) => [entry.index, entry]));
                    const next = [];
                    parseItems(row.items).forEach((item, index) => {
                        const change = byIndex.get(index);
                        if (!change) {
                            next.push(item);
                            return;
                        }
                        // Die Position muss noch die sein, die die Vorschau sah — dieselbe BOM-Zeile,
                        // dieselbe Menge. Hat «Sipariş oluştur» inzwischen Menge dazugelegt (oder jemand
                        // die Bestellung geändert), schriebe die Freigabe darüber: lieber neu laden.
                        if (item.bomLineId !== change.bomLineId || Math.abs((0, productionBom_1.round3)(Number(item.quantity) || 0) - (beforeByIndex.get(index) ?? Number.NaN)) > EPS) {
                            throw new RevisionConflict();
                        }
                        seen.add(index);
                        // Sicherheitsnetz: nie unter das inzwischen Gelieferte.
                        const quantity = Math.max((0, productionBom_1.round3)(change.quantity), (0, productionBom_1.round3)(Number(item.receivedQuantity) || 0));
                        if (quantity <= EPS)
                            return;
                        const copy = { ...item, quantity, ...(change.unit ? { unit: change.unit } : {}) };
                        // Eine übernommene Zeile (DIRECT) trägt ihren Betrag fest — neu: Menge × Nettopreis.
                        if (String(copy.calcMode ?? '').toUpperCase() === 'DIRECT' || copy.directCopy === true)
                            delete copy.lineTotal;
                        next.push(copy);
                    });
                    // Eine geplante Position fehlt (die Bestellung wurde inzwischen umgebaut).
                    if (write.items.some((entry) => !seen.has(entry.index)))
                        throw new RevisionConflict();
                    if (!next.length)
                        continue;
                    const normalized = (0, inventory_routes_1.normalizePurchaseOrderItems)(next);
                    const vat = { vatMode: String(row.vatMode || 'LINE'), orderVatRate: Number(row.orderVatRate) || 0 };
                    const data = {
                        items: JSON.stringify(normalized.items),
                        totalNet: normalized.totalNet,
                        totalGross: normalized.totalGross,
                        totalVat: (0, inventory_routes_1.purchaseOrderTotalVat)(vat, normalized.totalNet, Number(row.totalFees) || 0, normalized.totalVat, normalized.items.map((item) => item.lineTotal)),
                    };
                    const linkData = {
                        bomRevision: input.newRevision,
                        lines: linkLinesAfter(link?.lines ?? null, normalized.items),
                    };
                    if (write.mode === 'REVISE' && write.orderRevision !== null) {
                        // Die Fassung davor — samt Bestätigung des Lieferanten — ins Archiv.
                        await tx.productionBomPurchaseRevision.create({
                            data: {
                                id: (0, nanoid_1.nanoid)(12),
                                tenantId,
                                purchaseOrderId: row.id,
                                bomId: input.bom.id,
                                number: write.orderRevision,
                                bomRevision: input.newRevision,
                                changes: write.changes,
                                previousOrder: JSON.parse(JSON.stringify((0, inventory_routes_1.parsePurchaseOrderRow)(row))),
                                previousStatus: String(row.status),
                                quoteFileRef: link?.quoteFileRef ?? null,
                                quoteFileName: link?.quoteFileName ?? null,
                                quoteFileType: link?.quoteFileType ?? null,
                                quoteFileSize: link?.quoteFileSize ?? null,
                                quoteUploadedAt: link?.quoteUploadedAt ?? null,
                                createdById: userId,
                            },
                        });
                        data.revision = (Number(row.revision) || 0) + 1;
                        data.status = write.statusAfter;
                        Object.assign(linkData, {
                            orderRevision: write.orderRevision,
                            // Die Bestätigung galt der alten Fassung — sie liegt jetzt im Archiv.
                            quoteFileRef: null,
                            quoteFileName: null,
                            quoteFileType: null,
                            quoteFileSize: null,
                            quoteUploadedAt: null,
                            quoteUploadedById: null,
                        });
                    }
                    const updated = await tx.purchaseOrder.update({
                        where: { id: row.id },
                        data,
                        select: { id: true, tenantId: true, referenceNumber: true, status: true, supplierName: true, currency: true, items: true },
                    });
                    await tx.productionBomPurchase.updateMany({ where: { tenantId, purchaseOrderId: row.id }, data: linkData });
                    result.updated.push(updated);
                }
            }, WarehouseCodeIssuer_1.CARD_TX_OPTIONS);
        }
        catch (error) {
            if (error instanceof RevisionConflict)
                return null;
            throw error;
        }
        // Danach, ausserhalb des Vorgangs: die Produktion kennt nur BESTÄTIGTE Zeilen —
        // eine revidierte Bestellung verschwindet dort, bis der Lieferant neu bestätigt.
        if (result.updated.length && await productionModule_1.productionModule.purchaseLink.isEnabled(tenantId).catch(() => false)) {
            for (const row of result.updated) {
                await productionModule_1.productionModule.purchaseLink.syncConfirmedLines(tenantId, row, userId).catch(() => undefined);
            }
        }
        if (result.deleted.length) {
            await prisma_client_1.default.purchaseOrderMailDraft
                .deleteMany({ where: { tenantId, orderId: { in: result.deleted.map((entry) => entry.id) } } })
                .catch(() => undefined);
        }
        return result;
    }
}
exports.PrismaBomRevisionWriter = PrismaBomRevisionWriter;
//# sourceMappingURL=productionBomRevisionWriter.js.map