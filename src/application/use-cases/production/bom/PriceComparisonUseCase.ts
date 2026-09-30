import type { IBomProcurementRepository, IBomProductionDirectory } from '../../../../domain/repositories/IProductionBomRepository';
import type { IPriceComparisonStore, StoredPriceComparison } from '../../../../domain/repositories/IPriceComparisonStore';
import type { IProcurementJournal } from '../../../../domain/repositories/IProcurementJournal';
import { bomError } from '../../../../domain/services/productionBom';
import {
    COMPARE_MAX_SUPPLIERS,
    settleComparison,
    type ComparisonResult,
    type ComparisonRowInput,
    type ComparisonSupplierInput,
} from '../../../../domain/services/priceComparison';
import type { PriceCompareAiPort } from '../../../../infrastructure/services/priceCompareAi';
import type { BomDocumentStore } from './BomPurchasesUseCase';
import type { BomProcurementUseCase } from './BomProcurementUseCase';
import type { BomActor } from './BomTemplatesUseCase';
import type { DeviceBomsUseCase } from './DeviceBomsUseCase';

export interface PriceComparisonDto {
    id: string;
    createdAt: string;
    createdByName: string | null;
    model: string;
    request: {
        id: string;
        requestNumber: string;
        status: string;
        project: { number: string; name: string } | null;
        device: { name: string; position: string | null } | null;
    };
    result: ComparisonResult;
}

/** Eine Zeile der Liste «Karşılaştırmalar» auf der Seite des Talep. */
export interface PriceComparisonSummaryDto {
    id: string;
    createdAt: string;
    createdByName: string | null;
    suppliers: Array<{ supplierName: string; code: string; total: number; currency: string; complete: boolean }>;
    bestSupplier: number | null;
    lineCount: number;
}

const summaryOf = (entry: StoredPriceComparison): PriceComparisonSummaryDto => ({
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
export class PriceComparisonUseCase {
    constructor(
        private requests: IBomProcurementRepository,
        private devices: DeviceBomsUseCase,
        private procurement: BomProcurementUseCase,
        private documents: BomDocumentStore,
        private compare: PriceCompareAiPort,
        private store: IPriceComparisonStore,
        private journal: IProcurementJournal,
        private directory: IBomProductionDirectory,
    ) {}

    async create(tenantId: string, actor: BomActor, requestId: string, body: unknown): Promise<PriceComparisonDto> {
        this.procurement.assertCanProcure(actor);
        const request = await this.requests.get(tenantId, requestId);
        if (!request) throw bomError('REQUEST_NOT_FOUND', 'Talep nicht gefunden.', { status: 404 });
        if (request.kind !== 'PRICE') throw bomError('KIND_INVALID', 'Verglichen werden die Angebote eines Preistalep.', { status: 409 });
        if (request.status === 'CANCELLED') throw bomError('STATUS_INVALID', 'Der Talep ist verworfen.', { status: 409 });

        const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
        const wanted = [...new Set((Array.isArray(input.purchaseOrderIds) ? input.purchaseOrderIds : []).map(String).filter(Boolean))];
        if (!wanted.length || wanted.length > COMPARE_MAX_SUPPLIERS) {
            throw bomError('COMPARE_COUNT', 'Ein bis vier Angebote vergleichen.', { params: { max: COMPARE_MAX_SUPPLIERS } });
        }
        const mine = new Map((await this.devices.purchasesOf(tenantId, [request.bomId]))
            .filter(({ link, order }) => link.kind === 'REQUEST' && request.purchaseOrderIds.includes(order.id))
            .map((entry) => [entry.order.id, entry] as const));
        const chosen = wanted.map((id) => mine.get(id));
        if (chosen.some((entry) => !entry)) throw bomError('REQUEST_MISMATCH', 'Diese Preisanfrage gehört nicht zum Talep.', { status: 409 });

        const sources: Array<ComparisonSupplierInput & { body: Buffer }> = [];
        for (const entry of chosen) {
            const { link, order } = entry!;
            // «PDF olmazsa yapılamaz» — ein Bild oder nichts ist kein Angebot für den Vergleich.
            if (!link.quoteFileRef || String(link.quoteFileType ?? '').toLowerCase() !== 'application/pdf') {
                throw bomError('COMPARE_PDF_REQUIRED', 'Zu dieser Preisanfrage liegt kein Angebot als PDF.', {
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
                body: await this.documents.read(link.quoteFileRef),
            });
        }

        const rows: ComparisonRowInput[] = request.lines.map((line) => ({
            bomLineId: line.bomLineId,
            erpCode: line.erpCode,
            name: line.name,
            brand: line.brand,
            modelNumber: line.modelNumber,
            unit: line.unit,
            quantity: line.quantity,
        }));
        const language = input.language === 'de' || input.language === 'en' ? input.language : 'tr';
        let read: Awaited<ReturnType<PriceCompareAiPort>>;
        try {
            read = await this.compare({
                rows,
                sources: sources.map((source) => ({ supplierName: source.supplierName, fileName: source.fileName, body: source.body })),
                language,
            });
        } catch (error) {
            const code = String((error as { code?: string })?.code ?? '');
            if (code === 'AI_NOT_CONFIGURED' || code === 'GPT_NOT_CONFIGURED') {
                throw bomError('AI_NOT_CONFIGURED', 'Die KI ist nicht eingerichtet.', { status: 503 });
            }
            if (code === 'COMPARE_PDF_UNREADABLE') {
                const supplier = String((error as { params?: { supplier?: unknown } })?.params?.supplier ?? '');
                throw bomError('COMPARE_PDF_UNREADABLE', (error as Error).message, { status: 422, params: { supplier } });
            }
            throw bomError('AI_FAILED', (error as Error)?.message || 'Die KI hat nicht geantwortet.', {
                status: Number((error as { status?: number })?.status) || 502,
                ...(code ? { params: { reason: code } } : {}),
            });
        }

        const result = settleComparison(rows, sources.map(({ body: _body, ...supplier }) => supplier), read.raw);
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

    async list(tenantId: string, actor: BomActor, requestId: string): Promise<{ items: PriceComparisonSummaryDto[] }> {
        this.procurement.assertCanSee(actor);
        const request = await this.requests.get(tenantId, requestId);
        if (!request) throw bomError('REQUEST_NOT_FOUND', 'Talep nicht gefunden.', { status: 404 });
        return { items: (await this.store.forRequest(tenantId, request.id)).map(summaryOf) };
    }

    async get(tenantId: string, actor: BomActor, comparisonId: string): Promise<PriceComparisonDto & { others: PriceComparisonSummaryDto[] }> {
        this.procurement.assertCanSee(actor);
        const entry = await this.store.get(tenantId, comparisonId);
        if (!entry) throw bomError('COMPARISON_NOT_FOUND', 'Vergleich nicht gefunden.', { status: 404 });
        const request = await this.requests.get(tenantId, entry.requestId);
        if (!request) throw bomError('REQUEST_NOT_FOUND', 'Talep nicht gefunden.', { status: 404 });
        const [dto, all] = await Promise.all([this.dtoOf(tenantId, entry, request), this.store.forRequest(tenantId, request.id)]);
        return { ...dto, others: all.map(summaryOf) };
    }

    private async dtoOf(
        tenantId: string,
        entry: StoredPriceComparison,
        request: { id: string; requestNumber: string; status: string; productionProjectId: string; productionItemId: string },
    ): Promise<PriceComparisonDto> {
        const [projects, devices] = await Promise.all([
            this.directory.projects(tenantId, [request.productionProjectId]),
            this.directory.devices(tenantId, [request.productionItemId]),
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
            result: entry.result,
        };
    }
}
