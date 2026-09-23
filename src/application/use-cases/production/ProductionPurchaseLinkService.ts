import type {
    IProductionProjectRepository,
    IProductionPurchaseRepository,
    ProductionWriteClient,
} from '../../../domain/repositories/IProductionRepository';
import type { ProductionAssignment } from '../../../domain/entities/Production';
import {
    APPROVED_PURCHASE_STATUSES,
    assignPurchaseLines,
    effectiveNetPrice,
    parsePurchaseLines,
} from '../../../domain/services/production';
import { productionError } from './productionErrors';

/** Die Auswahl, wie sie aus einer Anfrage kommt. */
export interface ProductionSelectionInput {
    /** `null` = noch kein Projekt gewaehlt — erlaubt (Vorgabe Samet, 21.09.2026). */
    productionProjectId: string | null;
    productionItemIds: string[];
}

export interface PurchaseOrderForProduction {
    id: string;
    referenceNumber: string;
    status: string;
    supplierName: string | null;
    currency: string | null;
    /** Die JSON-Spalte (oder schon gelesen). */
    items: unknown;
}

const MAX_ITEMS = 200;

/* Die Tabellen des Moduls kommen mit einer Migration. Aufräumarbeiten
   (Bestellung gelöscht, zurück in den Entwurf) dürfen daran nicht scheitern,
   solange sie noch fehlen: dann gibt es auch nichts aufzuräumen. */
const isMissingTable = (error: unknown): boolean => {
    const e = error as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { code?: string | number } } } };
    return e?.code === 'P2021'
        || e?.meta?.code === '1146'
        || String(e?.meta?.driverAdapterError?.cause?.code ?? '') === '1146';
};

const tolerant = async (work: () => Promise<void>): Promise<void> => {
    try {
        await work();
    } catch (error) {
        if (!isMissingTable(error)) throw error;
    }
};

/**
 * ── LIEFERANTENBESTELLUNG ↔ PRODUKTION ──────────────────────────────────────
 *
 * Die eine Stelle, an der das Lager die Produktion berührt:
 *
 *   • FREIWILLIGE AUSWAHL (Vorgabe Samet, 21.09.2026: «proje ve hizmet
 *     seçmek zorunlu olmasın … sonradan seçilebilsin») — Preisanfrage,
 *     Bestellung und Wareneingang laufen AUCH OHNE Projekt; es lässt sich
 *     jederzeit nachtragen (Auftragsseite › Produktion › Wählen). Geräte
 *     waren schon vorher freiwillig (20.09.2026), und NICHTS wird ihnen
 *     automatisch zugeschlagen: eine Zeile zählt beim Projekt, solange sie
 *     nicht selbst ein Gerät trägt (`productionItemId` in `items`).
 *     Ohne Projekt steht die Bestellung einfach NICHT bei der Produktion —
 *     `syncConfirmedLines` räumt ihre Zeilen dort weg.
 *   • BESTÄTIGTE ZEILEN — sobald die Bestellung bestätigt ist, stehen ihre
 *     Zeilen mit Projekt und Gerät in `uretim_siparisleri`; geht sie zurück in
 *     den Entwurf oder wird gelöscht, verschwinden sie wieder. Jede spätere
 *     Änderung (Wareneingang) schreibt sie neu, die Bestätigungszeit bleibt.
 */
export class ProductionPurchaseLinkService {
    constructor(
        private projects: IProductionProjectRepository,
        private purchase: IProductionPurchaseRepository,
        private moduleGate: (tenantId: string) => Promise<boolean>,
    ) {}

    isEnabled(tenantId: string): Promise<boolean> {
        return this.moduleGate(tenantId);
    }

    /**
     * Die Auswahl aus einem Anfragekörper. `undefined` = nicht mitgeschickt
     * (nichts ändern); sonst die bereinigte Auswahl.
     */
    static readInput(body: any): ProductionSelectionInput | undefined {
        const raw = body?.production;
        if (raw === undefined) return undefined;
        const projectId = String(raw?.productionProjectId ?? '').trim();
        /* Ein Gerät kommt als Id — eine Bestellung betrifft es ganz. (Ältere
           Oberflächen schickten kurz `{ id, quantity }`; die Menge entfällt.) */
        const entries: unknown[] = Array.isArray(raw?.productionItemIds) ? raw.productionItemIds : [];
        const itemIds: string[] = [];
        for (const entry of entries) {
            const id = (typeof entry === 'string' ? entry : String((entry as any)?.id ?? '')).trim();
            if (!id || itemIds.includes(id) || itemIds.length >= MAX_ITEMS) continue;
            itemIds.push(id);
        }
        // Ohne Projekt gibt es auch kein Gerät — ein Gerät lebt in seinem Projekt.
        return projectId
            ? { productionProjectId: projectId, productionItemIds: itemIds }
            : { productionProjectId: null, productionItemIds: [] };
    }

    /**
     * Prüft eine Auswahl gegen die Tabellen des Moduls. Ein stillgelegtes
     * Projekt oder Gerät ist nur erlaubt, wenn die Bestellung es schon trug —
     * eine alte Bestellung soll sich weiter bearbeiten lassen.
     */
    async validate(
        tenantId: string,
        input: ProductionSelectionInput,
        current?: ProductionAssignment | null,
    ): Promise<{ selection: ProductionSelectionInput; label: string }> {
        // KEIN PROJEKT IST EINE ANTWORT: der Vorgang läuft ohne Produktion
        // weiter, und wer will, trägt es später nach.
        if (!input.productionProjectId) {
            return { selection: { productionProjectId: null, productionItemIds: [] }, label: '' };
        }
        const project = await this.projects.getProject(tenantId, input.productionProjectId);
        if (!project) throw productionError('PROJECT_NOT_FOUND', 'Produktionsprojekt nicht gefunden.', { status: 404 });
        const sameProject = current?.productionProjectId === project.id;
        if (!project.isActive && !sameProject) {
            throw productionError('PROJECT_INACTIVE', 'Dieses Produktionsprojekt ist nicht mehr aktiv.');
        }
        /* Geräte sind freiwillig; die gewählten müssen aber zum Projekt
           gehören und leben (Vorgabe Samet, 20.09.2026). */
        const items = input.productionItemIds.length
            ? await this.projects.listItems(tenantId, { itemIds: input.productionItemIds })
            : [];
        const byId = new Map(items.map((item) => [item.id, item]));
        const previous = new Set(sameProject ? current?.productionItemIds ?? [] : []);
        for (const id of input.productionItemIds) {
            const item = byId.get(id);
            if (!item || item.productionProjectId !== project.id) {
                throw productionError('ITEM_NOT_IN_PROJECT', 'Ein gewähltes Gerät gehört nicht zu diesem Projekt.', { details: [id] });
            }
            if (!item.isActive && !previous.has(id)) {
                throw productionError('ITEM_INACTIVE', 'Ein gewähltes Gerät ist nicht mehr aktiv.', { params: { name: item.name } });
            }
        }
        // Die Zeile «Projekt» der Bestellung (PDF-Deckblatt), falls sie leer ist.
        const label = project.projectName && project.projectName !== project.projectNumber
            ? `${project.projectNumber} · ${project.projectName}`
            : project.projectNumber;
        return { selection: input, label: label.slice(0, 191) };
    }

    /**
     * Setzt jeder Zeile ihr Gerät: das, was sie selbst trägt und was zur
     * Auswahl gehört — sonst keines (dann zählt sie beim Projekt). Niemand
     * muss etikettieren, darum wirft das hier nichts mehr.
     */
    assignLines<T extends { productionItemId?: string | null }>(items: T[], selection: ProductionSelectionInput): T[] {
        const result = assignPurchaseLines(items, selection.productionItemIds);
        return items.map((item, index) => ({ ...item, productionItemId: result.itemIds[index] }));
    }

    getAssignment(tenantId: string, purchaseOrderId: string): Promise<ProductionAssignment | null> {
        return this.purchase.getAssignment(tenantId, purchaseOrderId);
    }

    /**
     * Die Auswahl sichern — oder, wenn KEIN Projekt mehr dasteht, die
     * Zuordnung samt ihrer Produktionszeilen wegräumen. Sonst bliebe eine
     * Bestellung bei der Produktion stehen, die dort niemand mehr will.
     */
    async saveAssignment(tenantId: string, purchaseOrderId: string, selection: ProductionSelectionInput, userId: string): Promise<void> {
        const projectId = selection.productionProjectId;
        if (!projectId) {
            await this.purchase.removeForPurchaseOrder(tenantId, purchaseOrderId);
            return;
        }
        await this.purchase.saveAssignment(
            tenantId,
            { purchaseOrderId, productionProjectId: projectId, productionItemIds: selection.productionItemIds },
            userId,
        );
    }

    /**
     * Schreibt die Zeilen einer BESTÄTIGTEN Bestellung in die Tabelle der
     * Produktionsaufträge — oder räumt sie weg, wenn die Bestellung (noch
     * oder wieder) nicht bestätigt ist.
     */
    async syncConfirmedLines(tenantId: string, order: PurchaseOrderForProduction, actorId?: string | null): Promise<void> {
        await tolerant(async () => {
            if (!APPROVED_PURCHASE_STATUSES.has(order.status)) {
                await this.purchase.deleteLines(tenantId, order.id);
                return;
            }
            const assignment = await this.purchase.getAssignment(tenantId, order.id);
            if (!assignment) {
                await this.purchase.deleteLines(tenantId, order.id);
                return;
            }
            const lines = parsePurchaseLines(order.items);
            const resolved = assignPurchaseLines(lines, assignment.productionItemIds);
            // Die Bestätigung bleibt, wann sie war — auch wenn der Wareneingang
            // die Zeilen später neu schreibt.
            const previous = await this.purchase.listLines(tenantId, { purchaseOrderIds: [order.id] });
            const approvedAt = previous[0]?.approvedAt ?? new Date();
            const approvedById = previous[0]?.approvedById ?? actorId ?? null;
            await this.purchase.replaceLines(tenantId, order.id, lines.map((line, index) => ({
                purchaseOrderId: order.id,
                purchaseOrderNumber: order.referenceNumber,
                supplierName: order.supplierName,
                currency: order.currency || 'CHF',
                productionProjectId: assignment.productionProjectId,
                productionItemId: resolved.itemIds[index] ?? null,
                lineIndex: index,
                articleId: line.articleId,
                code: line.code,
                name: (line.name || line.code || '—').slice(0, 500),
                unit: line.unit,
                quantity: line.quantity,
                grossPrice: line.grossPrice,
                discount: line.discount,
                discount2: line.discount2,
                netPrice: effectiveNetPrice(line),
                lineTotal: line.lineTotal,
                receivedQuantity: Math.min(line.quantity, line.receivedQuantity),
                approvedAt,
                approvedById,
            })));
        });
    }

    /**
     * Die Bestellung ist gelöscht: Zuordnung und Zeilen gehen mit. Wer `tx`
     * mitgibt, räumt im SELBEN Vorgang — dann kann die Bestellung nicht
     * verschwinden und ihre Produktionszeilen stehen bleiben.
     */
    async removeForPurchaseOrder(tenantId: string, purchaseOrderId: string, tx?: ProductionWriteClient): Promise<void> {
        await tolerant(() => this.purchase.removeForPurchaseOrder(tenantId, purchaseOrderId, tx));
    }
}
