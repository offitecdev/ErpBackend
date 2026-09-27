import type { BomOrderActionLine, BomPurchaseLink } from '../../../../domain/entities/ProductionBom';
import type {
    IBomProductionDirectory,
    IBomPurchaseRepository,
    IBomRepository,
    IBomRevisionRepository,
} from '../../../../domain/repositories/IProductionBomRepository';
import {
    bomError,
    bomErrorBody,
    CONFIRMED_ORDER_STATUSES,
    CONFIRMING_STATUSES,
    confirmProblems,
    isBomError,
    sameLockedRows,
} from '../../../../domain/services/productionBom';
import type { BomDocumentStore } from './BomPurchasesUseCase';

/** Was die Auftragsseite über die Herkunft eines Belegs wissen muss. */
export interface BomOriginDto {
    kind: 'ORDER' | 'REQUEST';
    bomId: string;
    bomNumber: string | null;
    bomStatus: string | null;
    area: string | null;
    productionProjectId: string;
    productionItemId: string;
    projectNumber: string | null;
    projectName: string | null;
    deviceName: string | null;
    sourcePurchaseOrderId: string | null;
    quoteFile: { name: string; type: string | null; size: number | null; uploadedAt: string | null } | null;
    /** Was fehlt, bevor die Bestellung bestätigt werden darf. */
    confirmProblems: Array<'QUOTE_NUMBER' | 'QUOTE_FILE'>;
    /** Die geltende Revision der BOM (null = BOM nicht lesbar). */
    bomRevision: number | null;
    /** Die BOM-Revision, für die der Beleg gilt. */
    linkBomRevision: number;
    /** Wie oft eine BOM-Revision die Bestellung beim Lieferanten geändert hat. */
    orderRevision: number;
    /** Die jüngste Revision der Bestellung (fürs PDF: Nummer, Tag, geänderte Zeilen). */
    revision: { number: number; createdAt: string; changes: BomOrderActionLine[] } | null;
    /** Revidiert und noch nicht wieder bestätigt: neu senden, neue Bestätigung hochladen. */
    revisionPending: boolean;
}

/* Die Tabellen kommen mit der Migration 20261103090000_production_bom. Bis
   dahin ist KEIN Beleg ein BOM-Beleg — die Lieferantenbestellung darf an
   ihrem Fehlen nie scheitern. */
const isMissingTable = (error: unknown): boolean => {
    const e = error as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { code?: string | number } } } };
    return e?.code === 'P2021'
        || e?.meta?.code === '1146'
        || String(e?.meta?.driverAdapterError?.cause?.code ?? '') === '1146'
        || /doesn't exist|does not exist/i.test(String((error as Error)?.message ?? ''));
};

/**
 * ── DER WÄCHTER DER BOM-BELEGE (27.09.2026, Vorgabe Samet) ──────────────────
 *
 * «BU SADECE ÜRETİM OLAN TÜRÜ ÜRETİM OLAN VE SADECE İKİNCİ KOŞUL DA PROJEDEN
 *  ÜRETİM PROJESİNDEN AKTARILMIŞ SİPARİŞ/FİYAT TALEPLERİNDE GEÇERLİDİR!!»
 *
 * Die Regeln gelten NUR für Belege, die eine BOM angelegt hat, und nur in
 * einer Produktionsfirma. inventory.routes.ts fragt hier an genau den
 * Stellen, an denen ein Beleg sich ändert:
 *   · Zeilen: keine neuen, keine gelöschten; Code, Name, Menge fest
 *     («sütun ekleyebiliyoruz, ancak satır ekleyemiyoruz»)
 *   · Bestätigen: Angebotsnummer des Lieferanten UND sein Angebots-PDF
 *   · PDF/Mail: nie ohne die Angebotsnummer des Lieferanten
 *   · eine BOM-Preisanfrage wird nie zur Bestellung; eine BOM-Bestellung wird
 *     nie zur Anfrage — Preisanfragen entstehen nur aus der BOM im ENTWURF
 *     (27.09.2026: «bom onaylandıktan sonra fiyat talebi alınamaz»)
 *   · Wareneingang ins Artikellager/Zusammenführen gibt es für sie nicht —
 *     die Ware geht über die BOM ins Depo.
 */
export class BomPurchaseGuard {
    constructor(
        private purchases: IBomPurchaseRepository,
        private boms: IBomRepository,
        private directory: IBomProductionDirectory,
        private documents: BomDocumentStore,
        private available: (tenantId: string) => Promise<boolean>,
        private revisions: IBomRevisionRepository,
    ) {}

    /** Die Verknüpfung — oder null, wenn der Beleg keiner BOM gehört (oder die Regeln hier nicht gelten). */
    async linkOf(tenantId: string, purchaseOrderId: string): Promise<BomPurchaseLink | null> {
        try {
            const link = await this.purchases.linkForOrder(tenantId, purchaseOrderId);
            if (!link) return null;
            return (await this.available(tenantId)) ? link : null;
        } catch (error) {
            if (isMissingTable(error)) return null;
            throw error;
        }
    }

    /** Herkunft für die Auftragsseite (null = gewöhnlicher Beleg). */
    async originOf(tenantId: string, purchaseOrderId: string, order: { quoteNumber?: string | null; status?: string | null }): Promise<BomOriginDto | null> {
        const link = await this.linkOf(tenantId, purchaseOrderId);
        if (!link) return null;
        const [bom, project, device, archive] = await Promise.all([
            this.boms.get(tenantId, link.bomId).catch(() => null),
            this.directory.project(tenantId, link.productionProjectId).catch(() => null),
            this.directory.device(tenantId, link.productionItemId).catch(() => null),
            link.orderRevision > 0 ? this.revisions.purchaseRevisions(tenantId, [purchaseOrderId]).catch(() => []) : Promise.resolve([]),
        ]);
        const latest = archive.filter((entry) => entry.number === link.orderRevision)[0] ?? null;
        return {
            kind: link.kind,
            bomId: link.bomId,
            bomNumber: bom?.bomNumber ?? null,
            bomStatus: bom?.status ?? null,
            area: bom?.area ?? null,
            productionProjectId: link.productionProjectId,
            productionItemId: link.productionItemId,
            projectNumber: project?.projectNumber ?? null,
            projectName: project?.projectName ?? null,
            deviceName: device?.name ?? null,
            sourcePurchaseOrderId: link.sourcePurchaseOrderId,
            quoteFile: link.quoteFileRef
                ? {
                    name: link.quoteFileName ?? 'angebot.pdf',
                    type: link.quoteFileType,
                    size: link.quoteFileSize,
                    uploadedAt: link.quoteUploadedAt ? link.quoteUploadedAt.toISOString() : null,
                }
                : null,
            confirmProblems: link.kind === 'ORDER' ? confirmProblems(order, link) : [],
            bomRevision: bom ? bom.revision : null,
            linkBomRevision: link.bomRevision,
            orderRevision: link.orderRevision,
            revision: latest ? { number: latest.number, createdAt: latest.createdAt.toISOString(), changes: latest.changes } : null,
            revisionPending: link.kind === 'ORDER' && link.orderRevision > 0
                && !CONFIRMED_ORDER_STATUSES.has(String(order.status ?? '').toUpperCase()),
        };
    }

    /** Kurzform für Listen: welche dieser Belege gehören einer BOM? */
    async kindsOf(tenantId: string, purchaseOrderIds: string[]): Promise<Map<string, 'ORDER' | 'REQUEST'>> {
        const result = new Map<string, 'ORDER' | 'REQUEST'>();
        if (!purchaseOrderIds.length) return result;
        try {
            if (!(await this.available(tenantId))) return result;
            for (const id of purchaseOrderIds) {
                const link = await this.purchases.linkForOrder(tenantId, id);
                if (link) result.set(id, link.kind);
            }
        } catch (error) {
            if (!isMissingTable(error)) throw error;
        }
        return result;
    }

    assertRowsKept(link: BomPurchaseLink | null, before: unknown, after: unknown): void {
        if (!link) return;
        if (!sameLockedRows(before, after)) {
            throw bomError('ROWS_LOCKED', 'Diese Bestellung kommt aus einer BOM: Zeilen, Codes, Namen und Mengen bleiben fest — nur Preise und eigene Spalten ändern sich.', { status: 409 });
        }
    }

    assertStatusChange(link: BomPurchaseLink | null, order: { quoteNumber?: string | null }, nextStatus: string): void {
        if (!link || link.kind !== 'ORDER') return;
        if (!CONFIRMING_STATUSES.has(String(nextStatus).toUpperCase())) return;
        const problems = confirmProblems(order, link);
        if (problems.length) {
            throw bomError('CONFIRM_REQUIREMENTS', 'Ohne Angebotsnummer des Lieferanten und sein Angebot (PDF) wird die Bestellung nicht bestätigt.', {
                status: 409,
                details: problems,
            });
        }
    }

    assertSendable(link: BomPurchaseLink | null, order: { quoteNumber?: string | null }): void {
        if (!link || link.kind !== 'ORDER') return;
        if (!String(order.quoteNumber ?? '').trim()) {
            throw bomError('QUOTE_NUMBER_REQUIRED', 'Ohne die Angebotsnummer des Lieferanten geht diese Bestellung nicht hinaus.', { status: 409 });
        }
    }

    assertConvertToOrder(link: BomPurchaseLink | null): void {
        if (link?.kind === 'REQUEST') {
            throw bomError('REQUEST_NO_CONVERT', 'Eine Preisanfrage aus einer BOM wird nie zur Bestellung — bestellt wird aus der BOM.', { status: 409 });
        }
    }

    /** Bestellung → Anfrage an Ort und Stelle, Wareneingang ins Artikellager, Zusammenführen. */
    assertOrderOnlyPath(link: BomPurchaseLink | null): void {
        if (link) {
            throw bomError('ORDER_ONLY', 'Für eine BOM-Bestellung gibt es diesen Weg nicht (Preisanfragen entstehen aus der BOM im Entwurf, Ware = BOM-Wareneingang).', { status: 409 });
        }
    }

    /** Die Bestellung ist gelöscht: Verknüpfung und Angebot gehen mit. */
    async onDeleted(tenantId: string, purchaseOrderId: string): Promise<void> {
        try {
            const link = await this.purchases.removeLink(tenantId, purchaseOrderId);
            if (link?.quoteFileRef) await this.documents.remove(link.quoteFileRef).catch(() => undefined);
            // Die alten Fassungen (Revisionen) gehen mit — samt ihren Bestätigungen.
            if (link) {
                for (const entry of await this.revisions.removePurchaseRevisions(tenantId, purchaseOrderId)) {
                    if (entry.quoteFileRef) await this.documents.remove(entry.quoteFileRef).catch(() => undefined);
                }
            }
        } catch (error) {
            if (!isMissingTable(error)) throw error;
        }
    }
}

/** Schreibt einen Regelverstoss als Antwort — `true`, wenn es einer war. */
export const sendBomRuleError = (res: { status: (code: number) => { json: (body: unknown) => unknown } }, error: unknown): boolean => {
    if (!isBomError(error)) return false;
    res.status(error.status).json(bomErrorBody(error));
    return true;
};
