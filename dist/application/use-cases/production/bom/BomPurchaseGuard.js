"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendBomRuleError = exports.BomPurchaseGuard = void 0;
const productionBom_1 = require("../../../../domain/services/productionBom");
/* Die Tabellen kommen mit der Migration 20261103090000_production_bom. Bis
   dahin ist KEIN Beleg ein BOM-Beleg — die Lieferantenbestellung darf an
   ihrem Fehlen nie scheitern. */
const isMissingTable = (error) => {
    const e = error;
    return e?.code === 'P2021'
        || e?.meta?.code === '1146'
        || String(e?.meta?.driverAdapterError?.cause?.code ?? '') === '1146'
        || /doesn't exist|does not exist/i.test(String(error?.message ?? ''));
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
class BomPurchaseGuard {
    purchases;
    boms;
    directory;
    documents;
    available;
    revisions;
    constructor(purchases, boms, directory, documents, available, revisions) {
        this.purchases = purchases;
        this.boms = boms;
        this.directory = directory;
        this.documents = documents;
        this.available = available;
        this.revisions = revisions;
    }
    /** Die Verknüpfung — oder null, wenn der Beleg keiner BOM gehört (oder die Regeln hier nicht gelten). */
    async linkOf(tenantId, purchaseOrderId) {
        try {
            const link = await this.purchases.linkForOrder(tenantId, purchaseOrderId);
            if (!link)
                return null;
            return (await this.available(tenantId)) ? link : null;
        }
        catch (error) {
            if (isMissingTable(error))
                return null;
            throw error;
        }
    }
    /** Herkunft für die Auftragsseite (null = gewöhnlicher Beleg). */
    async originOf(tenantId, purchaseOrderId, order) {
        const link = await this.linkOf(tenantId, purchaseOrderId);
        if (!link)
            return null;
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
            confirmProblems: link.kind === 'ORDER' ? (0, productionBom_1.confirmProblems)(order, link) : [],
            bomRevision: bom ? bom.revision : null,
            linkBomRevision: link.bomRevision,
            orderRevision: link.orderRevision,
            revision: latest ? { number: latest.number, createdAt: latest.createdAt.toISOString(), changes: latest.changes } : null,
            revisionPending: link.kind === 'ORDER' && link.orderRevision > 0
                && !productionBom_1.CONFIRMED_ORDER_STATUSES.has(String(order.status ?? '').toUpperCase()),
        };
    }
    /** Kurzform für Listen: welche dieser Belege gehören einer BOM? */
    async kindsOf(tenantId, purchaseOrderIds) {
        const result = new Map();
        if (!purchaseOrderIds.length)
            return result;
        try {
            if (!(await this.available(tenantId)))
                return result;
            for (const id of purchaseOrderIds) {
                const link = await this.purchases.linkForOrder(tenantId, id);
                if (link)
                    result.set(id, link.kind);
            }
        }
        catch (error) {
            if (!isMissingTable(error))
                throw error;
        }
        return result;
    }
    assertRowsKept(link, before, after) {
        if (!link)
            return;
        if (!(0, productionBom_1.sameLockedRows)(before, after)) {
            throw (0, productionBom_1.bomError)('ROWS_LOCKED', 'Diese Bestellung kommt aus einer BOM: Zeilen, Codes, Namen und Mengen bleiben fest — nur Preise und eigene Spalten ändern sich.', { status: 409 });
        }
    }
    assertStatusChange(link, order, nextStatus) {
        if (!link || link.kind !== 'ORDER')
            return;
        if (!productionBom_1.CONFIRMING_STATUSES.has(String(nextStatus).toUpperCase()))
            return;
        const problems = (0, productionBom_1.confirmProblems)(order, link);
        if (problems.length) {
            throw (0, productionBom_1.bomError)('CONFIRM_REQUIREMENTS', 'Ohne Angebotsnummer des Lieferanten und sein Angebot (PDF) wird die Bestellung nicht bestätigt.', {
                status: 409,
                details: problems,
            });
        }
    }
    assertSendable(link, order) {
        if (!link || link.kind !== 'ORDER')
            return;
        if (!String(order.quoteNumber ?? '').trim()) {
            throw (0, productionBom_1.bomError)('QUOTE_NUMBER_REQUIRED', 'Ohne die Angebotsnummer des Lieferanten geht diese Bestellung nicht hinaus.', { status: 409 });
        }
    }
    assertConvertToOrder(link) {
        if (link?.kind === 'REQUEST') {
            throw (0, productionBom_1.bomError)('REQUEST_NO_CONVERT', 'Eine Preisanfrage aus einer BOM wird nie zur Bestellung — bestellt wird aus der BOM.', { status: 409 });
        }
    }
    /** Bestellung → Anfrage an Ort und Stelle, Wareneingang ins Artikellager, Zusammenführen. */
    assertOrderOnlyPath(link) {
        if (link) {
            throw (0, productionBom_1.bomError)('ORDER_ONLY', 'Für eine BOM-Bestellung gibt es diesen Weg nicht (Preisanfragen entstehen aus der BOM im Entwurf, Ware = BOM-Wareneingang).', { status: 409 });
        }
    }
    /** Die Bestellung ist gelöscht: Verknüpfung und Angebot gehen mit. */
    async onDeleted(tenantId, purchaseOrderId) {
        try {
            const link = await this.purchases.removeLink(tenantId, purchaseOrderId);
            if (link?.quoteFileRef)
                await this.documents.remove(link.quoteFileRef).catch(() => undefined);
            // Die alten Fassungen (Revisionen) gehen mit — samt ihren Bestätigungen.
            if (link) {
                for (const entry of await this.revisions.removePurchaseRevisions(tenantId, purchaseOrderId)) {
                    if (entry.quoteFileRef)
                        await this.documents.remove(entry.quoteFileRef).catch(() => undefined);
                }
            }
        }
        catch (error) {
            if (!isMissingTable(error))
                throw error;
        }
    }
}
exports.BomPurchaseGuard = BomPurchaseGuard;
/** Schreibt einen Regelverstoss als Antwort — `true`, wenn es einer war. */
const sendBomRuleError = (res, error) => {
    if (!(0, productionBom_1.isBomError)(error))
        return false;
    res.status(error.status).json((0, productionBom_1.bomErrorBody)(error));
    return true;
};
exports.sendBomRuleError = sendBomRuleError;
//# sourceMappingURL=BomPurchaseGuard.js.map