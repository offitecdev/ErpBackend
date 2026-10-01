"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PriceComparisonUseCase = void 0;
const productionBom_1 = require("../../../../domain/services/productionBom");
const priceComparison_1 = require("../../../../domain/services/priceComparison");
const ProcurementDispatchUseCase_1 = require("./ProcurementDispatchUseCase");
const summaryOf = (entry) => ({
    id: entry.id,
    createdAt: entry.createdAt.toISOString(),
    createdByName: entry.actorName,
    suppliers: entry.result.suppliers.map((supplier) => ({
        supplierName: supplier.supplierName,
        code: supplier.code,
        total: supplier.total,
        currency: supplier.currency,
        complete: supplier.complete,
    })),
    bestSupplier: entry.result.bestSupplier,
    lineCount: entry.result.lines.length,
});
/**
 * ── FİYAT KARŞILAŞTIRMASI (29.09.2026, Vorgabe Samet) ───────────────────────
 *
 * «İstediğimiz max 4 tedarikçinin 4 PDF'ini (PDF olmazsa yapılamaz) yapay
 *  zekâya vererek karşılaştıracağız … karşılaştırmalar kayıt edilecek …
 *  karşılaştırma yeni bir sayfa olacak.»
 *
 * Gewählt werden Preisanfragen DIESES Talep, an denen das Angebot des
 * Lieferanten als PDF hängt (hochgeladen auf der Seite des Talep). Die KI
 * liest sie, `settleComparison` markiert die günstigsten, und der Vergleich
 * wird gespeichert — er ist danach eine eigene Seite.
 */
class PriceComparisonUseCase {
    requests;
    devices;
    procurement;
    documents;
    compare;
    store;
    journal;
    directory;
    constructor(requests, devices, procurement, documents, compare, store, journal, directory) {
        this.requests = requests;
        this.devices = devices;
        this.procurement = procurement;
        this.documents = documents;
        this.compare = compare;
        this.store = store;
        this.journal = journal;
        this.directory = directory;
    }
    async create(tenantId, actor, requestId, body) {
        this.procurement.assertCanProcure(actor);
        const request = await this.requests.get(tenantId, requestId);
        if (!request)
            throw (0, productionBom_1.bomError)('REQUEST_NOT_FOUND', 'Talep nicht gefunden.', { status: 404 });
        if (request.kind !== 'PRICE')
            throw (0, productionBom_1.bomError)('KIND_INVALID', 'Verglichen werden die Angebote eines Preistalep.', { status: 409 });
        if (request.status === 'CANCELLED')
            throw (0, productionBom_1.bomError)('STATUS_INVALID', 'Der Talep ist verworfen.', { status: 409 });
        const input = (body && typeof body === 'object' ? body : {});
        const wanted = [...new Set((Array.isArray(input.purchaseOrderIds) ? input.purchaseOrderIds : []).map(String).filter(Boolean))];
        if (!wanted.length || wanted.length > priceComparison_1.COMPARE_MAX_SUPPLIERS) {
            throw (0, productionBom_1.bomError)('COMPARE_COUNT', 'Ein bis acht Angebote vergleichen.', { params: { max: priceComparison_1.COMPARE_MAX_SUPPLIERS } });
        }
        const mine = new Map((await this.devices.purchasesOf(tenantId, [request.bomId]))
            .filter(({ link, order }) => link.kind === 'REQUEST' && request.purchaseOrderIds.includes(order.id))
            .map((entry) => [entry.order.id, entry]));
        const chosen = wanted.map((id) => mine.get(id));
        if (chosen.some((entry) => !entry))
            throw (0, productionBom_1.bomError)('REQUEST_MISMATCH', 'Diese Preisanfrage gehört nicht zum Talep.', { status: 409 });
        const sources = [];
        for (const entry of chosen) {
            const { link, order } = entry;
            // «PDF olmazsa yapılamaz» — ein Bild oder nichts ist kein Angebot für den Vergleich.
            if (!link.quoteFileRef || String(link.quoteFileType ?? '').toLowerCase() !== 'application/pdf') {
                throw (0, productionBom_1.bomError)('COMPARE_PDF_REQUIRED', 'Zu dieser Preisanfrage liegt kein Angebot als PDF.', {
                    status: 409,
                    params: { code: order.referenceNumber, supplier: order.supplierName },
                });
            }
            sources.push({
                purchaseOrderId: order.id,
                code: order.referenceNumber,
                supplierName: order.supplierName,
                fileName: link.quoteFileName || `${order.referenceNumber}.pdf`,
                currency: order.currency,
                // Die Automatik fragt jeden Lieferanten nur nach SEINEN Zeilen (30.09.2026).
                askedLineIds: [...new Set(order.items.flatMap((item) => (typeof item.bomLineId === 'string' ? [item.bomLineId] : [])))],
                body: await this.readQuote(link.quoteFileRef, order),
            });
        }
        const rows = request.lines.map((line) => ({
            bomLineId: line.bomLineId,
            erpCode: line.erpCode,
            name: line.name,
            brand: line.brand,
            modelNumber: line.modelNumber,
            unit: line.unit,
            quantity: line.quantity,
        }));
        const language = input.language === 'de' || input.language === 'en' ? input.language : 'tr';
        let read;
        try {
            read = await this.compare({
                rows,
                sources: sources.map((source) => ({
                    supplierName: source.supplierName,
                    fileName: source.fileName,
                    body: source.body,
                    askedIndexes: rows.flatMap((row, index) => (source.askedLineIds?.includes(row.bomLineId) ? [index] : [])),
                })),
                language,
            });
        }
        catch (error) {
            const code = String(error?.code ?? '');
            if (code === 'AI_NOT_CONFIGURED' || code === 'GPT_NOT_CONFIGURED') {
                throw (0, productionBom_1.bomError)('AI_NOT_CONFIGURED', 'Die KI ist nicht eingerichtet.', { status: 503 });
            }
            if (code === 'COMPARE_PDF_UNREADABLE') {
                const supplier = String(error?.params?.supplier ?? '');
                throw (0, productionBom_1.bomError)('COMPARE_PDF_UNREADABLE', error.message, { status: 422, params: { supplier } });
            }
            throw (0, productionBom_1.bomError)('AI_FAILED', error?.message || 'Die KI hat nicht geantwortet.', {
                status: Number(error?.status) || 502,
                ...(code ? { params: { reason: code } } : {}),
            });
        }
        const result = (0, priceComparison_1.settleComparison)(rows, sources.map(({ body: _body, ...supplier }) => supplier), read.raw);
        const saved = await this.store.save(tenantId, {
            requestId: request.id,
            requestNumber: request.requestNumber,
            actorId: actor.id,
            actorName: actor.name,
            model: read.model,
            result,
        });
        await this.journal.record(tenantId, {
            requestId: request.id,
            requestNumber: request.requestNumber,
            action: 'COMPARISON_SAVED',
            actorId: actor.id,
            actorName: actor.name,
            data: { suppliers: result.suppliers.map((supplier) => supplier.supplierName), count: result.suppliers.length },
        }).catch(() => undefined);
        return this.dtoOf(tenantId, saved, request);
    }
    async list(tenantId, actor, requestId) {
        this.procurement.assertCanSee(actor);
        const request = await this.requests.get(tenantId, requestId);
        if (!request)
            throw (0, productionBom_1.bomError)('REQUEST_NOT_FOUND', 'Talep nicht gefunden.', { status: 404 });
        return { items: (await this.store.forRequest(tenantId, request.id)).map(summaryOf) };
    }
    async get(tenantId, actor, comparisonId) {
        this.procurement.assertCanSee(actor);
        const entry = await this.store.get(tenantId, comparisonId);
        if (!entry)
            throw (0, productionBom_1.bomError)('COMPARISON_NOT_FOUND', 'Vergleich nicht gefunden.', { status: 404 });
        const request = await this.requests.get(tenantId, entry.requestId);
        if (!request)
            throw (0, productionBom_1.bomError)('REQUEST_NOT_FOUND', 'Talep nicht gefunden.', { status: 404 });
        const [dto, all] = await Promise.all([this.dtoOf(tenantId, entry, request), this.store.forRequest(tenantId, request.id)]);
        return { ...dto, others: all.map(summaryOf) };
    }
    /**
     * Das Angebots-PDF lesen (01.10.2026). Steht der Verweis in der Datenbank, die Datei aber
     * nicht mehr in der Ablage (auf der Platte eines anderen Rechners hochgeladen, nie in R2),
     * war das ein 500 «Sunucu hatası» — jetzt sagt es, welches Angebot neu hochzuladen ist.
     */
    async readQuote(reference, order) {
        try {
            return await this.documents.read(reference);
        }
        catch (error) {
            const failure = error;
            const code = String(failure?.code ?? failure?.name ?? '');
            if (code === 'ENOENT' || code === 'NoSuchKey' || code === 'NotFound') {
                console.warn('[satın alma] Angebots-PDF fehlt in der Ablage:', order.referenceNumber, reference);
                throw (0, productionBom_1.bomError)('COMPARE_PDF_MISSING', 'Die Datei des Angebots-PDF fehlt — neu hochladen.', {
                    status: 409,
                    params: { code: order.referenceNumber, supplier: order.supplierName },
                });
            }
            throw error;
        }
    }
    /** Je Zeile des Vergleichs: bestellt würde … / nicht, weil … — derselbe Vorschlag wie beim Bestellen. */
    async orderableOf(tenantId, bomId, lineIds) {
        try {
            const proposal = await this.devices.proposal(tenantId, (0, ProcurementDispatchUseCase_1.systemActorOf)(null), bomId);
            const byLine = new Map(proposal.lines.map((line) => [line.lineId, line]));
            return Object.fromEntries(lineIds.map((lineId) => {
                const facts = byLine.get(lineId);
                if (!facts)
                    return [lineId, { quantity: 0, reason: 'IN_STOCK' }];
                const reason = facts.block === 'OPEN_ORDER' || facts.block === 'NO_PRODUCT' ? facts.block : null;
                return [lineId, { quantity: facts.floor, reason }];
            }));
        }
        catch (error) {
            console.warn('[satın alma] Bestellvorschlag zum Vergleich nicht gelesen:', bomId, error?.message);
            return null;
        }
    }
    async dtoOf(tenantId, entry, request) {
        const [projects, devices, bom] = await Promise.all([
            this.directory.projects(tenantId, [request.productionProjectId]),
            this.directory.devices(tenantId, [request.productionItemId]),
            this.devices.requireBom(tenantId, request.bomId).catch(() => null),
        ]);
        const project = projects.get(request.productionProjectId) ?? null;
        const device = devices.get(request.productionItemId) ?? null;
        return {
            id: entry.id,
            createdAt: entry.createdAt.toISOString(),
            createdByName: entry.actorName,
            model: entry.model,
            request: {
                id: request.id,
                requestNumber: request.requestNumber,
                status: request.status,
                project: project ? { number: project.projectNumber, name: project.projectName } : null,
                device: device ? { name: device.name, position: device.positionNumber } : null,
            },
            orderable: bom && bom.status === 'APPROVED' && !bom.consumedAt
                ? await this.orderableOf(tenantId, bom.id, entry.result.lines.map((line) => line.bomLineId))
                : null,
            bom: bom
                ? {
                    id: bom.id,
                    number: bom.bomNumber ?? null,
                    status: bom.status,
                    approved: bom.status === 'APPROVED',
                    consumed: Boolean(bom.consumedAt),
                    area: bom.area ?? null,
                    productionProjectId: bom.productionProjectId,
                    productionItemId: bom.productionItemId,
                }
                : null,
            result: entry.result,
        };
    }
}
exports.PriceComparisonUseCase = PriceComparisonUseCase;
//# sourceMappingURL=PriceComparisonUseCase.js.map