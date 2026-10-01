import type {
    IBomProcurementRepository,
    IBomProductionDirectory,
    IBomPurchaseRepository,
    IBomStockReader,
} from '../../../../domain/repositories/IProductionBomRepository';
import type { IPriceComparisonStore } from '../../../../domain/repositories/IPriceComparisonStore';
import type { ComparisonLine, ComparisonSupplier } from '../../../../domain/services/priceComparison';
import { bomError, round3 } from '../../../../domain/services/productionBom';
import { cardSupplierNumbersOf } from '../../../../domain/services/supplierEmails';
import type { PrismaProcurementAutomationRepository } from '../../../../infrastructure/repositories/ProcurementAutomationRepository';
import type { BomOrderDraftLine, BomPurchaseOrderWriter } from '../../../../infrastructure/services/productionBomPurchaseWriter';
import type { BomProcurementUseCase } from './BomProcurementUseCase';
import type { BomDocumentStore } from './BomPurchasesUseCase';
import type { BomActor } from './BomTemplatesUseCase';
import type { DeviceBomsUseCase } from './DeviceBomsUseCase';
import { systemActorOf } from './ProcurementDispatchUseCase';

/**
 * ── AUS DEM VERGLEICH BESTELLEN (30.09.2026, Vorgabe Samet) ────────────────
 *
 * «Yapay zekâ karşılaştırıyor ve bize bir şablon sunuyor … fiyat listesi
 *  çıkıyor, oradan seçim yapabiliyoruz — seçili olarak geliyor en uygun
 *  teklif — sonra tedarikçi özelinde sipariş oluştur butonuna basınca her
 *  birine ayrı sipariş PDF'i gidiyor.»
 *
 * Die Auswahl (je Zeile EIN Lieferant) wird je Lieferant EINE Bestellung:
 *   · Menge: was der Zeile jetzt fehlt (nie unter der Mindestbestellmenge) —
 *     derselbe Vorschlag wie «Sipariş oluştur»; was da ist oder schon bestellt
 *     ist, wird nicht noch einmal bestellt (die Antwort nennt es);
 *   · Preis, Rabatt, Währung, Angebotsnummer aus dem Angebot, das Angebots-PDF
 *     als Beleg der Bestellung (Kopie in R2), «z. Hd.», Sprache und Empfänger
 *     aus dem Angebot;
 *   · der Lieferant wird der erste der Karte, sein Preis der Alışpreis.
 * Gesendet wird danach Beleg für Beleg (ProcurementDispatchUseCase) — die
 * Seite zeigt jeden Schritt.
 */

export interface ComparisonOrderDto {
    purchaseOrderId: string;
    code: string;
    supplierName: string;
    lineCount: number;
    total: number;
    currency: string;
    /** Die Angebotsnummer fehlt — senden geht erst, wenn sie eingetragen ist. */
    needsQuoteNumber: boolean;
    email: string | null;
}

export interface ComparisonSkipDto {
    bomLineId: string;
    name: string;
    reason: 'IN_STOCK' | 'OPEN_ORDER' | 'NO_PRODUCT' | 'NO_ERP_CODE' | 'NO_PRICE';
}

const locks = new Map<string, Promise<unknown>>();
const withLock = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    locks.set(key, next.catch(() => undefined));
    try {
        return await next;
    } finally {
        if (locks.get(key) === next) locks.delete(key);
    }
};

/** `quoteNumbers: { "<Stelle>": "A-123" }` — die eingetippten Angebotsnummern je Lieferant. */
const quoteNumbersFrom = (body: unknown): Map<number, string> => {
    const raw = (body && typeof body === 'object' ? (body as Record<string, unknown>).quoteNumbers : null);
    const map = new Map<number, string>();
    if (!raw || typeof raw !== 'object') return map;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const index = Number(key);
        const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (Number.isInteger(index) && index >= 0 && text) map.set(index, text);
    }
    return map;
};

/** Preis vor Rabatt und Rabatt — wo das Angebot beides druckt, sonst der Nettopreis ohne Rabatt. */
const priceOf = (offer: ComparisonLine['offers'][number]): { unitPrice: number; discount: number } => {
    const net = offer.unitPrice ?? 0;
    if (offer.listPrice && offer.listPrice > net + 1e-9) {
        const discount = offer.discount && offer.discount > 0 ? offer.discount : round3((1 - net / offer.listPrice) * 100);
        return { unitPrice: offer.listPrice, discount: Math.min(100, Math.max(0, discount)) };
    }
    return { unitPrice: net, discount: 0 };
};

export class ProcurementOrderingUseCase {
    constructor(
        private deps: {
            requests: IBomProcurementRepository;
            purchases: IBomPurchaseRepository;
            devices: DeviceBomsUseCase;
            procurement: BomProcurementUseCase;
            stock: IBomStockReader;
            directory: IBomProductionDirectory;
            comparisons: IPriceComparisonStore;
            writer: BomPurchaseOrderWriter;
            documents: BomDocumentStore;
            automation: PrismaProcurementAutomationRepository;
        },
    ) {}

    /** `lines: [{ bomLineId, supplier }]` — `supplier` = Stelle des Angebots im Vergleich. */
    async createFromComparison(tenantId: string, actor: BomActor, comparisonId: string, body: unknown): Promise<{
        orders: ComparisonOrderDto[];
        skipped: ComparisonSkipDto[];
    }> {
        const { deps } = this;
        deps.procurement.assertCanProcure(actor);
        const entry = await deps.comparisons.get(tenantId, comparisonId);
        if (!entry) throw bomError('COMPARISON_NOT_FOUND', 'Vergleich nicht gefunden.', { status: 404 });
        return withLock(`${tenantId}:${entry.requestId}`, async () => {
            const request = await deps.requests.get(tenantId, entry.requestId);
            if (!request) throw bomError('REQUEST_NOT_FOUND', 'Talep nicht gefunden.', { status: 404 });
            if (request.kind !== 'PRICE') throw bomError('KIND_INVALID', 'Bestellt wird aus dem Vergleich eines Preistalep.', { status: 409 });
            if (request.status === 'CANCELLED') throw bomError('STATUS_INVALID', 'Der Talep ist verworfen.', { status: 409 });
            const bom = await deps.devices.requireBom(tenantId, request.bomId);
            if (bom.consumedAt) throw bomError('STATUS_INVALID', 'Die BOM ist abgebucht.', { status: 409 });
            /* Angefragt und verglichen wird schon im Entwurf; bestellt erst, wenn die BOM
               freigegeben ist — die Mengen folgen der endgültigen BOM (Reservierung, Revision).
               Sagt es beim Namen statt «Bu durumda bu işlem yapılamaz» (30.09.2026). */
            if (bom.status !== 'APPROVED') {
                throw bomError('BOM_NOT_APPROVED', 'Die BOM ist noch nicht freigegeben — bestellt wird aus einer freigegebenen BOM.', {
                    status: 409,
                    params: { bom: bom.bomNumber ?? '' },
                });
            }
            // Bestellt wird aus der freigegebenen BOM (dieselbe Regel wie «Sipariş oluştur»).
            const proposal = await deps.devices.proposal(tenantId, systemActorOf(actor), bom.id);

            const { result } = entry;
            const picks = this.selectionOf(body, result.lines, result.suppliers);
            /* «Sipariş numarası yoksa orada manuel ekleme yeri olsun» (30.09.2026): die Angebotsnummer
               je Lieferant (Stelle im Vergleich), eingetippt im Fenster «Siparişleri oluştur». */
            const typedQuotes = quoteNumbersFrom(body);
            const proposed = new Map(proposal.lines.map((line) => [line.lineId, line]));
            const byLine = new Map(bom.lines.map((line) => [line.id, line]));
            // Die Depo-Karten der Zeilen — für die Artikel-/Bestellnummer je Lieferant (01.10.2026).
            const cards = await deps.stock.products(tenantId, bom.lines.map((line) => line.productId));
            const skipped: ComparisonSkipDto[] = [];
            const groups = new Map<number, Array<{ line: ComparisonLine; quantity: number; missing: number; minimum: number | null }>>();
            for (const { line, supplier } of picks) {
                const facts = proposed.get(line.bomLineId);
                if (!facts) {
                    skipped.push({ bomLineId: line.bomLineId, name: line.name, reason: 'IN_STOCK' });
                    continue;
                }
                /* Ohne ERP-Code (Karte ohne Materialgruppe) wird trotzdem bestellt (30.09.2026): der
                   Code steht in keinem Bestell-PDF mehr, und der Wareneingang bucht über die Karte. */
                if (facts.block && facts.block !== 'NO_ERP_CODE') {
                    skipped.push({ bomLineId: line.bomLineId, name: line.name, reason: facts.block as ComparisonSkipDto['reason'] });
                    continue;
                }
                const list = groups.get(supplier) ?? [];
                list.push({ line, quantity: facts.floor, missing: facts.missing, minimum: facts.minimum });
                groups.set(supplier, list);
            }

            const project = await deps.directory.project(tenantId, bom.productionProjectId);
            const projectLabel = (project?.projectName || project?.projectNumber || '').trim();
            const orders: ComparisonOrderDto[] = [];
            for (const [index, lines] of groups) {
                const supplier = result.suppliers[index]!;
                const [pa] = await deps.purchases.orders(tenantId, [supplier.purchaseOrderId]);
                const link = await deps.purchases.linkForOrder(tenantId, supplier.purchaseOrderId);
                if (!pa || !link) continue;
                const meta = (await deps.automation.linkMeta(tenantId, [pa.id])).get(pa.id) ?? null;
                const contact = {
                    name: meta?.supplierContact?.name || supplier.contactName || null,
                    email: meta?.supplierContact?.email || supplier.contactEmail || null,
                };
                const draftLines: BomOrderDraftLine[] = lines.map(({ line, quantity }) => {
                    const bomLine = byLine.get(line.bomLineId);
                    const product = proposal.lines.find((entry) => entry.lineId === line.bomLineId)?.product ?? null;
                    const price = priceOf(line.offers[index]!);
                    return {
                        bomLineId: line.bomLineId,
                        erpCode: product?.erpCode ?? bomLine?.erpCode ?? line.erpCode,
                        name: product?.name ?? bomLine?.name ?? line.name,
                        brand: product?.brand ?? bomLine?.brand ?? line.brand,
                        modelNumber: product?.modelNumber ?? bomLine?.modelNumber ?? line.modelNumber,
                        unit: bomLine?.unit ?? 'PCS',
                        quantity,
                        materialGroup: product?.materialGroupName ?? null,
                        // Seine Artikel-/Bestellnummer von der Karte (01.10.2026).
                        ...cardSupplierNumbersOf(
                            { supplierId: pa.supplierId, supplierName: pa.supplierName },
                            bomLine ? cards.get(bomLine.productId) : null,
                        ),
                        unitPrice: price.unitPrice,
                        discount: price.discount,
                    };
                });
                const quoteNumber = (typedQuotes.get(index) || pa.quoteNumber || supplier.offerNumber || '').trim() || null;
                const order = await deps.writer.createOrder({
                    tenantId,
                    userId: actor.id,
                    supplier: { supplierId: pa.supplierId, supplierName: pa.supplierName },
                    projectLabel,
                    productionProjectId: bom.productionProjectId,
                    productionItemId: bom.productionItemId,
                    lines: draftLines,
                    currency: supplier.currency || pa.currency,
                    quoteNumber,
                    recipientName: contact.name,
                    vatRate: supplier.vatRate ?? null,
                });
                await deps.purchases.createLink(tenantId, {
                    purchaseOrderId: order.id,
                    bomId: bom.id,
                    productionProjectId: bom.productionProjectId,
                    productionItemId: bom.productionItemId,
                    kind: 'ORDER',
                    // Die Preisanfrage, aus deren Angebot bestellt wurde — «geri fiyat talebine gidilebilsin».
                    sourcePurchaseOrderId: pa.id,
                    bomRevision: bom.revision,
                    lines: lines.map(({ line, quantity, missing, minimum }) => ({
                        bomLineId: line.bomLineId,
                        missing,
                        minimum,
                        ordered: quantity,
                        note: null,
                    })),
                }, actor.id);
                // Das Angebot ist der Beleg der Bestellung — eine eigene Kopie (ersetzt jemand das der Anfrage, bleibt diese).
                if (link.quoteFileRef) {
                    try {
                        const body = await deps.documents.read(link.quoteFileRef);
                        const ref = await deps.documents.store(tenantId, body, link.quoteFileType || 'application/pdf');
                        await deps.purchases.setQuoteFile(tenantId, order.id, {
                            ref,
                            name: link.quoteFileName || `${pa.referenceNumber}.pdf`,
                            type: link.quoteFileType || 'application/pdf',
                            size: body.length,
                        }, actor.id);
                    } catch (error) {
                        console.warn('[satın alma] Angebot nicht kopiert:', pa.referenceNumber, (error as Error)?.message);
                    }
                }
                const language = meta?.documentLanguage ?? (supplier.language === 'de' || supplier.language === 'tr' || supplier.language === 'en' ? supplier.language : null);
                await deps.automation.setLinkMeta(tenantId, order.id, {
                    documentLanguage: language,
                    supplierContact: contact.name || contact.email ? contact : null,
                });
                const paRow = await deps.automation.order(tenantId, pa.id);
                const email = contact.email || paRow?.supplierEmail || null;
                if (email) await deps.automation.setSupplierEmail(tenantId, order.id, email).catch(() => undefined);
                // Der gewählte Lieferant wird der erste der Karte, sein Preis der Alışpreis.
                for (const draft of draftLines) {
                    const bomLine = byLine.get(draft.bomLineId);
                    if (!bomLine) continue;
                    const net = draft.unitPrice ? draft.unitPrice * (1 - (draft.discount ?? 0) / 100) : null;
                    await deps.stock.preferSupplier(tenantId, bomLine.productId, { supplierId: pa.supplierId, name: pa.supplierName }, net, supplier.currency || pa.currency).catch(() => undefined);
                }
                const [written] = await deps.purchases.orders(tenantId, [order.id]);
                orders.push({
                    purchaseOrderId: order.id,
                    code: order.referenceNumber,
                    supplierName: order.supplierName,
                    lineCount: draftLines.length,
                    total: written ? written.totalNet : 0,
                    currency: written?.currency ?? (supplier.currency || pa.currency),
                    needsQuoteNumber: !quoteNumber,
                    email,
                });
            }
            if (orders.length) {
                await deps.procurement.attachDocuments(tenantId, request.id, bom.id, orders.map((entry) => entry.purchaseOrderId), actor, 'ORDER');
            }
            return { orders, skipped };
        });
    }

    /** Die Auswahl prüfen: jede Zeile höchstens einmal, nur Angebote mit Preis. */
    private selectionOf(body: unknown, lines: ComparisonLine[], suppliers: ComparisonSupplier[]): Array<{ line: ComparisonLine; supplier: number }> {
        const raw = (body && typeof body === 'object' ? (body as Record<string, unknown>).lines : null);
        if (!Array.isArray(raw) || !raw.length) throw bomError('SELECTION_INVALID', 'Keine Zeile gewählt.');
        const byId = new Map(lines.map((line) => [line.bomLineId, line]));
        const seen = new Set<string>();
        const picks: Array<{ line: ComparisonLine; supplier: number }> = [];
        for (const entry of raw) {
            const value = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
            const line = byId.get(String(value.bomLineId ?? ''));
            const supplier = Number(value.supplier);
            if (!line || seen.has(line.bomLineId) || !Number.isInteger(supplier) || supplier < 0 || supplier >= suppliers.length) {
                throw bomError('SELECTION_INVALID', 'Diese Auswahl gehört nicht zum Vergleich.');
            }
            const offer = line.offers[supplier];
            if (!offer || offer.unitPrice === null) {
                throw bomError('PRICE_MISSING', 'Für diese Zeile hat der Lieferant keinen Preis genannt.', {
                    params: { code: suppliers[supplier]!.code, supplier: suppliers[supplier]!.supplierName },
                });
            }
            seen.add(line.bomLineId);
            picks.push({ line, supplier });
        }
        return picks;
    }
}
