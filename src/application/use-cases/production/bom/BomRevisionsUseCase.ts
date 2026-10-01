import type {
    Bom,
    BomLine,
    BomLineChange,
    BomOrderAction,
    BomOrderActionLine,
    BomRevision,
    BomRevisionLine,
} from '../../../../domain/entities/ProductionBom';
import type {
    IBomProductionDirectory,
    IBomRepository,
    IBomRevisionRepository,
    IBomRevisionWriter,
    BomRevisionOrderWrite,
} from '../../../../domain/repositories/IProductionBomRepository';
import {
    bomError,
    computeCoverage,
    demandsWithRevision,
    revisionChanges,
    revisionOrderPlan,
    round3,
    type RevisionPlanOrder,
} from '../../../../domain/services/productionBom';
import type { IBomRevisionApprovals, IBomRevisionNotifier } from '../../../../domain/repositories/IBomRevisionApprovals';
import { assertErpCodes } from '../../../../domain/services/productionBom';
import type { BomDocumentStore } from './BomPurchasesUseCase';
import type { BomReservationService } from './BomReservationService';
import type { BomActor } from './BomTemplatesUseCase';
import type { DeviceBomsUseCase } from './DeviceBomsUseCase';
import type { BomDto } from './bomReadModel';

const EPS = 1e-9;
const REASON_MAX = 1000;
const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/** Was die Freigabe einer Revision vorher zeigt — und genau so schreibt. */
export interface BomRevisionPreviewDto {
    bomId: string;
    bomNumber: string;
    fromRevision: number;
    toRevision: number;
    reason: string | null;
    changes: BomLineChange[];
    /** Was mit jeder betroffenen Bestellung geschieht. */
    orders: BomOrderAction[];
    /** Preisanfragen der bisherigen Revision — sie gelten danach als «eski revizyona ait». */
    staleRequests: Array<{ purchaseOrderId: string; referenceNumber: string; supplierName: string }>;
    /** Was danach noch fehlt und neu bestellt wird («Sipariş oluştur»). */
    toOrder: Array<{ lineId: string; erpCode: string | null; name: string; unit: string; missing: number }>;
    /** Abgeschlossenes, das wieder aufgeht: die BOM selbst, die Haupt-BOM darüber (ihre Nummer). */
    reopens: { bom: boolean; main: string | null };
}

export interface BomRevisionDetailDto {
    bomId: string;
    bomNumber: string;
    revision: number;
    status: 'DRAFT' | 'APPROVED';
    reason: string | null;
    createdAt: string | null;
    createdByName: string | null;
    approvedAt: string | null;
    approvedByName: string | null;
    lines: BomRevisionLine[];
    changes: BomLineChange[];
    orderActions: BomOrderAction[];
}

/** Die alte Fassung einer Bestellung — zum Anzeigen ihres PDF. */
export interface BomPurchaseRevisionDetailDto {
    purchaseOrderId: string;
    number: number;
    bomRevision: number;
    createdAt: string;
    previousStatus: string;
    changes: BomOrderActionLine[];
    /** Die Bestellung, wie sie VOR dieser Revision war (Form der Auftragsseite). */
    order: Record<string, unknown>;
    /** Die Revision, die das alte PDF trägt (number − 1), mit ihren Änderungen. */
    pdfRevision: { number: number; createdAt: string | null; changes: BomOrderActionLine[] } | null;
    quoteFile: { name: string; type: string | null; size: number | null; uploadedAt: string | null } | null;
}

const toRevisionLine = (line: BomLine): BomRevisionLine => ({
    id: line.id,
    productId: line.productId,
    erpCode: line.erpCode,
    name: line.name,
    brand: line.brand,
    modelNumber: line.modelNumber,
    unit: line.unit,
    quantity: line.quantity,
    note: line.note,
});

const toBomLine = (bomId: string) => (line: BomRevisionLine, index: number): BomLine => ({
    ...line,
    bomId,
    consumedQuantity: 0,
    sortOrder: index,
});

/**
 * ── DIE REVISIONEN EINER BOM (27.09.2026, Vorgabe Samet) ────────────────────
 *
 * «Bom onaylandıktan sonra artık sipariş verilirse eski bom artık kayıt
 *  edilmeli ve yeni revizyon oluşturulmalı … en kolay ve en doğru yolu …
 *  bom onaylanırsa geri dönüş yok, revize olması lazım.»
 *
 *   «Revize et»       Grund Pflicht; Rev.0 wird (falls noch nicht) als Abzug
 *                     gesichert, die neue Revision beginnt als Kopie der
 *                     geltenden Zeilen — die BOM gilt unverändert weiter.
 *   Zeilen            speichert DeviceBomsUseCase.saveLines in die Arbeitskopie.
 *   Vorschau          der Unterschied, was mit jeder Bestellung geschieht, was
 *                     danach noch zu bestellen ist — gerechnet wie die Freigabe.
 *   «Revizyonu onayla» BOM, Zeilen, Revision und Bestellungen in EINEM Vorgang
 *                     (IBomRevisionWriter); danach die Seriennummern neu verteilt.
 *   Verwerfen         die Arbeitskopie fällt weg, nichts sonst ändert sich.
 */
export class BomRevisionsUseCase {
    constructor(
        private boms: IBomRepository,
        private revisions: IBomRevisionRepository,
        private directory: IBomProductionDirectory,
        private reservations: BomReservationService,
        private devices: DeviceBomsUseCase,
        private writer: IBomRevisionWriter,
        private documents: BomDocumentStore,
        /** Freigaben durch die Administratorrolle (30.09.2026) und die Glocke dazu. */
        private approvals: IBomRevisionApprovals | null = null,
        private notifier: IBomRevisionNotifier | null = null,
    ) {}

    /** Der Weg zur BOM (Geräteseite, Reiter BOM) — für die Glocke. */
    private linkOf(bom: Bom): string {
        const query = new URLSearchParams();
        if (bom.area === 'ELECTRICAL') query.set('area', 'electrical');
        query.set('stage', 'bom');
        query.set('bom', bom.id);
        return `/production/orders/${encodeURIComponent(bom.productionProjectId)}/devices/${encodeURIComponent(bom.productionItemId)}?${query.toString()}`;
    }

    /** Jede Zeile der neuen Fassung braucht einen ERP-Code («ERP kodları olmadan BOM onaylanamasın»). */
    private async assertDraftErpCodes(tenantId: string, draft: BomRevision): Promise<void> {
        const products = await this.devices.productsOf(tenantId, draft.lines.map((line) => line.productId));
        assertErpCodes(draft.lines, products);
    }

    /**
     * «Onaya gönder» (30.09.2026): wer die Revision bearbeitet, reicht sie bei der
     * Administratorrolle ein — die Glocke meldet es ihr. Bis zur Freigabe gilt die
     * BOM unverändert, keine Bestellung ändert sich.
     */
    async submit(tenantId: string, actor: BomActor, bomId: string): Promise<{ bom: BomDto }> {
        const bom = await this.devices.requireBom(tenantId, bomId);
        await this.devices.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        this.assertRevisable(bom);
        const draft = await this.requireDraft(tenantId, bom);
        const plan = await this.plan(tenantId, bom, draft, new Set());
        if (!plan.changes.length) {
            throw bomError('REVISION_NO_CHANGES', 'Die Revision ändert nichts — verwerfen oder erst Zeilen ändern.', { status: 409 });
        }
        await this.assertDraftErpCodes(tenantId, draft);
        if (this.approvals) {
            await this.approvals.record(tenantId, {
                revisionId: draft.id,
                bomId: bom.id,
                bomNumber: bom.bomNumber,
                revision: draft.revision,
                action: 'SUBMITTED',
                actorId: actor.id,
                actorName: actor.name,
                note: draft.reason,
            });
        }
        await this.notifier?.submitted({
            tenantId,
            bomId: bom.id,
            bomNumber: bom.bomNumber,
            revision: draft.revision,
            link: this.linkOf(bom),
            actorId: actor.id,
            actorName: actor.name,
            reason: draft.reason,
        });
        return { bom: await this.devices.get(tenantId, bomId, true) };
    }

    /** «Reddet» — nur die Administratorrolle; die Revision bleibt im Entwurf, die Glocke sagt es der einreichenden Person. */
    async reject(tenantId: string, actor: BomActor, bomId: string, body: unknown): Promise<{ bom: BomDto }> {
        if (!actor.isAdmin) throw bomError('REVISION_NEEDS_ADMIN', 'Eine Revision gibt die Administratorrolle frei.', { status: 403 });
        const bom = await this.devices.requireBom(tenantId, bomId);
        const draft = await this.requireDraft(tenantId, bom);
        const note = String((body as Record<string, unknown> | null)?.note ?? '').replace(/\r\n?/g, '\n').trim().slice(0, REASON_MAX) || null;
        const submitter = this.approvals ? await this.approvals.submitter(tenantId, draft.id) : null;
        if (this.approvals) {
            await this.approvals.record(tenantId, {
                revisionId: draft.id,
                bomId: bom.id,
                bomNumber: bom.bomNumber,
                revision: draft.revision,
                action: 'REJECTED',
                actorId: actor.id,
                actorName: actor.name,
                note,
            });
        }
        await this.notifier?.decided({
            tenantId,
            bomNumber: bom.bomNumber,
            revision: draft.revision,
            link: this.linkOf(bom),
            recipientId: submitter?.actorId ?? draft.createdById ?? null,
            approved: false,
            actorId: actor.id,
            actorName: actor.name,
            note,
        });
        return { bom: await this.devices.get(tenantId, bomId, true) };
    }

    /* ── Beginnen, Verwerfen ─────────────────────────────────────────────── */

    async start(tenantId: string, actor: BomActor, bomId: string, body: unknown): Promise<{ bom: BomDto }> {
        const bom = await this.devices.requireBom(tenantId, bomId);
        await this.devices.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        this.assertRevisable(bom);
        const reason = String((body as Record<string, unknown> | null)?.reason ?? '').replace(/\r\n?/g, '\n').trim().slice(0, REASON_MAX);
        if (!reason) throw bomError('REASON_REQUIRED', 'Warum wird die BOM revidiert? Der Grund ist Pflicht.');
        await this.revisions.ensureBaseline(tenantId, bom);
        const draft = await this.revisions.createDraft(tenantId, {
            bomId: bom.id,
            revision: bom.revision + 1,
            reason,
            lines: bom.lines.map(toRevisionLine),
        }, actor.id);
        if (!draft) {
            throw bomError('REVISION_OPEN', 'Für diese BOM ist schon eine Revision im Entwurf.', {
                status: 409,
                params: { number: bom.bomNumber, revision: bom.revision + 1 },
            });
        }
        return { bom: await this.devices.get(tenantId, bomId, true) };
    }

    async discard(tenantId: string, actor: BomActor, bomId: string): Promise<{ bom: BomDto }> {
        const bom = await this.devices.requireBom(tenantId, bomId);
        await this.devices.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        const removed = await this.revisions.deleteDraft(tenantId, bom.id);
        if (!removed) throw bomError('REVISION_NONE', 'Es gibt keine Revision im Entwurf.', { status: 409 });
        return { bom: await this.devices.get(tenantId, bomId, true) };
    }

    /* ── Vorschau und Freigabe ───────────────────────────────────────────── */

    async preview(tenantId: string, actor: BomActor, bomId: string, rawKeep: unknown): Promise<BomRevisionPreviewDto> {
        const bom = await this.devices.requireBom(tenantId, bomId);
        if (!actor.isAdmin) await this.devices.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        this.assertRevisable(bom);
        const draft = await this.requireDraft(tenantId, bom);
        return this.plan(tenantId, bom, draft, keepFrom(rawKeep));
    }

    async approve(tenantId: string, actor: BomActor, bomId: string, body: unknown): Promise<{ bom: BomDto; preview: BomRevisionPreviewDto }> {
        /* «Admin onaylayabilsin — sadece onaylarsa sipariş direkt otomatik revize gitsin»
           (Samet, 30.09.2026): freigeben darf nur die Administratorrolle; die anderen
           reichen ein («Onaya gönder»). */
        if (!actor.isAdmin) throw bomError('REVISION_NEEDS_ADMIN', 'Eine Revision gibt die Administratorrolle frei.', { status: 403 });
        const bom = await this.devices.requireBom(tenantId, bomId);
        this.assertRevisable(bom);
        const draft = await this.requireDraft(tenantId, bom);
        const plan = await this.plan(tenantId, bom, draft, keepFrom((body as Record<string, unknown> | null)?.keep));
        if (!plan.changes.length) {
            throw bomError('REVISION_NO_CHANGES', 'Die Revision ändert nichts — verwerfen oder erst Zeilen ändern.', { status: 409 });
        }
        await this.assertDraftErpCodes(tenantId, draft);
        const submitter = this.approvals ? await this.approvals.submitter(tenantId, draft.id).catch(() => null) : null;
        const writes: BomRevisionOrderWrite[] = plan.orders.flatMap((action): BomRevisionOrderWrite[] => {
            if (action.action !== 'UPDATE' && action.action !== 'REVISE' && action.action !== 'DELETE') return [];
            return [{
                purchaseOrderId: action.purchaseOrderId,
                mode: action.action,
                items: action.lines.map((line) => ({
                    index: line.index,
                    bomLineId: line.bomLineId,
                    quantity: line.after,
                    unit: line.unitAfter,
                })),
                orderRevision: action.orderRevision,
                statusAfter: action.statusAfter,
                changes: action.lines,
            }];
        });
        const result = await this.writer.apply({
            tenantId,
            userId: actor.id,
            bom: { id: bom.id, kind: bom.kind, parentBomId: bom.parentBomId, revision: bom.revision },
            draftId: draft.id,
            newRevision: draft.revision,
            lines: draft.lines,
            changes: plan.changes,
            orderActions: plan.orders,
            orders: writes,
        });
        if (!result) {
            throw bomError('REVISION_CONFLICT', 'Die BOM hat sich inzwischen geändert — bitte neu laden.', { status: 409 });
        }
        // Die Angebote gelöschter Entwürfe liegen noch in der Ablage.
        for (const entry of result.deleted) {
            if (entry.quoteFileRef) await this.documents.remove(entry.quoteFileRef).catch(() => undefined);
        }
        // Seriennummern: was das Gerät nicht mehr braucht, wird frei — und geht an die nächste wartende Zeile.
        await this.reservations.releaseForDevice(tenantId, {
            productionItemId: bom.productionItemId,
            lines: [...bom.lines, ...draft.lines.map(toBomLine(bom.id))],
        }).catch((error: unknown) => {
            console.warn('[production-bom] serial release after revision failed', bom.id, (error as Error)?.message);
        });
        /* «Revize edilince de otomatik» (30.09.2026): jede Bestellung, die schon beim
           Lieferanten war und sich geändert hat, geht mit dem geänderten PDF hinaus —
           im Hintergrund; ein Entwurf ändert sich still. */
        const revised = plan.orders.filter((action) => action.action === 'REVISE').map((action) => action.purchaseOrderId);
        if (revised.length && this.onRevised) {
            const listener = this.onRevised;
            setImmediate(() => { void Promise.resolve(listener(tenantId, actor, revised)).catch(() => undefined); });
        }
        if (this.approvals) {
            await this.approvals.record(tenantId, {
                revisionId: draft.id,
                bomId: bom.id,
                bomNumber: bom.bomNumber,
                revision: draft.revision,
                action: 'APPROVED',
                actorId: actor.id,
                actorName: actor.name,
                note: null,
            }).catch(() => undefined);
        }
        await this.notifier?.decided({
            tenantId,
            bomNumber: bom.bomNumber,
            revision: draft.revision,
            link: this.linkOf(bom),
            recipientId: submitter?.actorId ?? draft.createdById ?? null,
            approved: true,
            actorId: actor.id,
            actorName: actor.name,
            note: null,
        });
        return { bom: await this.devices.get(tenantId, bomId, true), preview: plan };
    }

    /** Die Automatik des Einkaufs (ProcurementDispatchUseCase) — nach dem Bau angeschlossen. */
    private onRevised: ((tenantId: string, actor: BomActor, purchaseOrderIds: string[]) => unknown) | null = null;

    attachRevisionDispatch(listener: (tenantId: string, actor: BomActor, purchaseOrderIds: string[]) => unknown): void {
        this.onRevised = listener;
    }

    /**
     * Der Plan — Vorschau und Freigabe rechnen ihn gleich. Was nach der
     * Revision fehlt, rechnet die Reservierung mit den Zeilen der NEUEN
     * Fassung (Priorität und Termin der BOM bleiben).
     */
    private async plan(tenantId: string, bom: Bom, draft: BomRevision, keep: Set<string>): Promise<BomRevisionPreviewDto> {
        const lines = draft.lines;
        if (!lines.length && bom.kind !== 'MAIN') throw bomError('LINES_REQUIRED', 'Eine leere BOM lässt sich nicht freigeben.');
        const changes = revisionChanges(bom.lines, lines);
        const productIds = [...new Set([...bom.lines, ...lines].map((line) => line.productId))];
        const [facts, purchases, deliveryDates, parent] = await Promise.all([
            this.reservations.facts(tenantId, productIds),
            this.devices.purchasesOf(tenantId, [bom.id]),
            this.directory.deliveryDates(tenantId, [bom.productionProjectId]),
            bom.kind === 'SUB' && bom.parentBomId ? this.boms.get(tenantId, bom.parentBomId) : Promise.resolve(null),
        ]);
        const missingCard = lines.findIndex((line) => !facts.products.has(line.productId));
        if (missingCard >= 0) {
            throw bomError('PRODUCT_NOT_FOUND', `Zeile ${missingCard + 1}: die Depo-Karte gibt es nicht mehr.`, {
                status: 409,
                params: { row: missingCard + 1 },
            });
        }
        const coverage = computeCoverage({
            demands: demandsWithRevision(facts.demands, bom, lines, deliveryDates.get(bom.productionProjectId) ?? null),
            products: facts.products,
            serials: facts.serials,
            incoming: facts.incoming,
        });
        const missingAfter = new Map(lines.map((line) => [line.id, round3(coverage.lines.get(line.id)?.missing ?? line.quantity)]));
        const minimums = new Map(lines.map((line) => [line.id, facts.products.get(line.productId)?.minimumOrderQuantity ?? null]));
        const orders: RevisionPlanOrder[] = purchases
            .filter(({ link }) => link.kind === 'ORDER')
            .map(({ link, order }) => ({
                purchaseOrderId: order.id,
                referenceNumber: order.referenceNumber,
                supplierName: order.supplierName,
                status: String(order.status).toUpperCase(),
                emailSentAt: order.emailSentAt,
                createdAt: order.createdAt,
                orderRevision: link.orderRevision,
                items: order.items.map((item, index) => ({
                    index,
                    bomLineId: typeof item.bomLineId === 'string' ? item.bomLineId : null,
                    code: typeof item.code === 'string' ? item.code : null,
                    name: String(item.name ?? ''),
                    unit: typeof item.unit === 'string' ? item.unit : null,
                    quantity: round3(Number(item.quantity) || 0),
                    received: round3(Number(item.receivedQuantity) || 0),
                })),
            }));
        const actions = revisionOrderPlan({ changes, orders, missingAfter, minimums, keep });

        // Was die Bestellungen nach dem Plan NICHT decken — das bestellt man danach über «Sipariş oluştur».
        const added = new Map<string, number>();
        for (const action of actions) {
            if (action.action !== 'UPDATE' && action.action !== 'REVISE') continue;
            for (const line of action.lines) {
                if (line.after > line.before + EPS) added.set(line.bomLineId, round3((added.get(line.bomLineId) ?? 0) + line.after - line.before));
            }
        }
        const toOrder = lines.flatMap((line) => {
            const missing = round3((missingAfter.get(line.id) ?? 0) - (added.get(line.id) ?? 0));
            return missing > EPS
                ? [{ lineId: line.id, erpCode: facts.products.get(line.productId)?.erpCode ?? line.erpCode, name: line.name, unit: line.unit, missing }]
                : [];
        });
        const staleRequests = purchases
            .filter(({ link }) => link.kind === 'REQUEST' && link.bomRevision !== draft.revision)
            .map(({ order }) => ({ purchaseOrderId: order.id, referenceNumber: order.referenceNumber, supplierName: order.supplierName }));

        return {
            bomId: bom.id,
            bomNumber: bom.bomNumber,
            fromRevision: bom.revision,
            toRevision: draft.revision,
            reason: draft.reason,
            changes,
            orders: actions,
            staleRequests,
            toOrder,
            reopens: {
                bom: bom.status === 'COMPLETED',
                main: parent && parent.status === 'COMPLETED' && !parent.consumedAt ? parent.bomNumber : null,
            },
        };
    }

    /* ── Geschichte ──────────────────────────────────────────────────────── */

    /** Eine Revision mit ihren Zeilen, dem Unterschied und was mit den Bestellungen geschah. */
    async detail(tenantId: string, bomId: string, rawNumber: unknown): Promise<BomRevisionDetailDto> {
        const bom = await this.devices.requireBom(tenantId, bomId);
        const number = Math.trunc(Number(rawNumber));
        if (!Number.isFinite(number) || number < 0) throw bomError('REVISION_NOT_FOUND', 'Diese Revision gibt es nicht.', { status: 404 });
        const found = await this.revisions.get(tenantId, bom.id, number);
        // Vor den Revisionen freigegeben: Rev.0 sind die geltenden Zeilen (sie haben sich nie geändert).
        const revision: BomRevision | null = found ?? (number === 0 && bom.revision === 0 && bom.status !== 'DRAFT'
            ? {
                id: '',
                tenantId,
                bomId: bom.id,
                revision: 0,
                status: 'APPROVED',
                reason: null,
                lines: bom.lines.map(toRevisionLine),
                changes: [],
                orderActions: [],
                createdById: bom.approvedById,
                createdAt: bom.approvedAt ?? bom.createdAt,
                approvedById: bom.approvedById,
                approvedAt: bom.approvedAt,
                updatedAt: bom.updatedAt,
            }
            : null);
        if (!revision) throw bomError('REVISION_NOT_FOUND', 'Diese Revision gibt es nicht.', { status: 404 });
        const names = await this.directory.personNames([revision.createdById, revision.approvedById].filter((id): id is string => Boolean(id)));
        return {
            bomId: bom.id,
            bomNumber: bom.bomNumber,
            revision: revision.revision,
            status: revision.status,
            reason: revision.reason,
            createdAt: iso(revision.createdAt),
            createdByName: revision.createdById ? names.get(revision.createdById) ?? null : null,
            approvedAt: iso(revision.approvedAt),
            approvedByName: revision.approvedById ? names.get(revision.approvedById) ?? null : null,
            lines: revision.lines,
            changes: revision.changes,
            orderActions: revision.orderActions,
        };
    }

    /** Die Fassung einer Bestellung VOR ihrer Revision `number` (altes PDF). */
    async purchaseRevision(tenantId: string, purchaseOrderId: string, rawNumber: unknown): Promise<BomPurchaseRevisionDetailDto> {
        const number = Math.trunc(Number(rawNumber));
        const entry = Number.isFinite(number) && number > 0 ? await this.revisions.purchaseRevision(tenantId, purchaseOrderId, number) : null;
        if (!entry) throw bomError('REVISION_NOT_FOUND', 'Diese Fassung der Bestellung gibt es nicht.', { status: 404 });
        const before = number > 1 ? (await this.revisions.purchaseRevisions(tenantId, [purchaseOrderId])).find((row) => row.number === number - 1) ?? null : null;
        return {
            purchaseOrderId,
            number: entry.number,
            bomRevision: entry.bomRevision,
            createdAt: entry.createdAt.toISOString(),
            previousStatus: entry.previousStatus,
            changes: entry.changes,
            order: entry.previousOrder,
            pdfRevision: number > 1 ? { number: number - 1, createdAt: iso(before?.createdAt), changes: before?.changes ?? [] } : null,
            quoteFile: entry.quoteFileRef
                ? { name: entry.quoteFileName ?? 'angebot.pdf', type: entry.quoteFileType, size: entry.quoteFileSize, uploadedAt: iso(entry.quoteUploadedAt) }
                : null,
        };
    }

    /** Die Bestätigung des Lieferanten zur Fassung VOR der Revision `number`. */
    async purchaseRevisionQuote(tenantId: string, purchaseOrderId: string, rawNumber: unknown): Promise<{ body: Buffer; contentType: string; fileName: string }> {
        const number = Math.trunc(Number(rawNumber));
        const entry = Number.isFinite(number) && number > 0 ? await this.revisions.purchaseRevision(tenantId, purchaseOrderId, number) : null;
        if (!entry?.quoteFileRef) throw bomError('FILE_REQUIRED', 'Zu dieser Fassung liegt keine Bestätigung.', { status: 404 });
        const body = await this.documents.read(entry.quoteFileRef);
        return { body, contentType: entry.quoteFileType || 'application/pdf', fileName: entry.quoteFileName || 'angebot.pdf' };
    }

    /* ── Hilfen ──────────────────────────────────────────────────────────── */

    /**
     * Revidiert wird eine freigegebene (oder abgeschlossene), nicht abgebuchte
     * BOM mit eigenen Zeilen — ein Entwurf wird direkt geändert, die leere
     * Haupt-BOM ist nur die Klammer ihrer Alt-BOMs.
     */
    private assertRevisable(bom: Bom): void {
        if (bom.consumedAt) throw bomError('ALREADY_CONSUMED', 'Diese BOM ist schon vom Bestand abgebucht.', { status: 409 });
        if (bom.status === 'DRAFT') {
            throw bomError('REVISION_NOT_ALLOWED', 'Ein Entwurf wird direkt geändert — revidiert wird erst nach der Freigabe.', { status: 409 });
        }
        if (bom.kind === 'MAIN' && !bom.lines.length) {
            throw bomError('REVISION_NOT_ALLOWED', 'Die Haupt-BOM ohne eigene Zeilen: revidiert werden ihre Alt-BOMs.', { status: 409 });
        }
    }

    private async requireDraft(tenantId: string, bom: Bom): Promise<BomRevision> {
        const draft = await this.revisions.draftOf(tenantId, bom.id);
        if (!draft) throw bomError('REVISION_NONE', 'Es gibt keine Revision im Entwurf.', { status: 409 });
        if (draft.revision !== bom.revision + 1) {
            throw bomError('REVISION_CONFLICT', 'Die BOM hat sich inzwischen geändert — bitte neu laden.', { status: 409 });
        }
        return draft;
    }
}

/** Die Bestellungen, die der Einkauf trotz Minderung so lassen will. */
const keepFrom = (raw: unknown): Set<string> =>
    new Set((Array.isArray(raw) ? raw : String(raw ?? '').split(','))
        .map((entry) => String(entry ?? '').trim())
        .filter((entry) => entry && entry.length <= 64));
