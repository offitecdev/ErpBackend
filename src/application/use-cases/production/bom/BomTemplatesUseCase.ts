import type {
    BomLineDraft,
    BomStockProduct,
    BomTemplateInput,
} from '../../../../domain/entities/ProductionBom';
import type {
    IBomRepository,
    IBomStockReader,
    IBomTemplateRepository,
} from '../../../../domain/repositories/IProductionBomRepository';
import type {
    IWarehouseDirectory,
    IWarehouseGroupRepository,
    IWarehouseProductRepository,
} from '../../../../domain/repositories/IWarehouseRepository';
import type { WarehouseProductFields } from '../../../../domain/entities/Warehouse';
import {
    bomError,
    lineDraftsFrom,
    templateHeadFrom,
} from '../../../../domain/services/productionBom';
import type { BomReservationService } from './BomReservationService';
import {
    EXAMPLE_CATEGORIES,
    EXAMPLE_GROUPS,
    EXAMPLE_PRODUCTS,
    EXAMPLE_TEMPLATES,
} from './bomExamples';
import {
    productDto,
    templateDto,
    templateSummaryDto,
    type BomProductDto,
    type BomTemplateDto,
    type BomTemplateSummaryDto,
} from './bomReadModel';

export interface BomActor {
    id: string;
    name: string | null;
    /** Administratorrolle (`Role.isSystemAdmin`). */
    isAdmin: boolean;
    /** `production.manage` — Depo-Karten und Vorlagen pflegen. */
    canManage: boolean;
    /** `inventory.transfer` — Lieferantenbestellungen bearbeiten. */
    canPurchase: boolean;
    /** Seite «Satın alma» Stufe ≥ 1 — den Einkauf (Lieferanten, Preise, Ausgaben) sehen. */
    canSeeProcurement: boolean;
    /** Seite «Satın alma» Stufe 2 — Preisanfragen und Bestellungen machen, Ware annehmen. */
    canProcure: boolean;
    /** Seite «Kalkülasyon» — geplante und tatsächliche Materialkosten sehen. */
    canSeeCosting: boolean;
}

/**
 * ── BOM · DIE VORLAGEN (27.09.2026, Vorgabe Samet) ──────────────────────────
 *
 * «BOM şablonu şu şekilde olabilir: erp kodu, model numarası, ürün adına
 *  göre aratma olabilir; bu aratma olduğunda direkt ürünün tüm satırı eklenir
 *  … depodaki satırın aynısı … eğer yoksa hemen küçük modal yanında ürün
 *  kartı oluştur olmalıdır.»
 *
 * Eine Vorlage speichert Karte + Menge + Einheit; Namen und Codes schreibt
 * der Server aus der Depo-Karte ab (nie aus der Anfrage). Lesen darf, wer die
 * Produktion sieht; schreiben die Administratorrolle und `production.manage`.
 */
export class BomTemplatesUseCase {
    constructor(
        private templates: IBomTemplateRepository,
        private boms: IBomRepository,
        private stock: IBomStockReader,
        private reservations: BomReservationService,
        private warehouse: {
            groups: IWarehouseGroupRepository;
            products: IWarehouseProductRepository;
            directory: IWarehouseDirectory;
        },
    ) {}

    private assertCanWrite(actor: BomActor): void {
        if (!actor.isAdmin && !actor.canManage) {
            throw bomError('FORBIDDEN', 'Vorlagen pflegen die Administratorrolle und «Produktion verwalten».', { status: 403 });
        }
    }

    async list(tenantId: string): Promise<{ items: BomTemplateSummaryDto[] }> {
        const items = await this.templates.list(tenantId);
        return { items: items.map(templateSummaryDto) };
    }

    async get(tenantId: string, id: string): Promise<BomTemplateDto> {
        const template = await this.templates.get(tenantId, id);
        if (!template) throw bomError('TEMPLATE_NOT_FOUND', 'BOM-Vorlage nicht gefunden.', { status: 404 });
        const productIds = template.lines.map((line) => line.productId);
        const [facts, usage] = await Promise.all([
            this.reservations.facts(tenantId, productIds),
            this.boms.usageByTemplate(tenantId),
        ]);
        return templateDto(template, facts.products, facts.coverage.free, usage.get(template.id) ?? 0);
    }

    async create(tenantId: string, actor: BomActor, body: unknown): Promise<BomTemplateDto> {
        this.assertCanWrite(actor);
        const input = await this.inputFrom(tenantId, body);
        const created = await this.templates.create(tenantId, input, actor.id);
        return this.get(tenantId, created.id);
    }

    async update(tenantId: string, actor: BomActor, id: string, body: unknown): Promise<BomTemplateDto> {
        this.assertCanWrite(actor);
        const input = await this.inputFrom(tenantId, body);
        const updated = await this.templates.update(tenantId, id, input, actor.id);
        if (!updated) throw bomError('TEMPLATE_NOT_FOUND', 'BOM-Vorlage nicht gefunden.', { status: 404 });
        return this.get(tenantId, id);
    }

    async remove(tenantId: string, actor: BomActor, id: string): Promise<{ removed: true }> {
        this.assertCanWrite(actor);
        const removed = await this.templates.remove(tenantId, id, actor.id);
        if (!removed) throw bomError('TEMPLATE_NOT_FOUND', 'BOM-Vorlage nicht gefunden.', { status: 404 });
        return { removed: true };
    }

    /** «erp kodu, model numarası, ürün adına göre aratma» — auch Marke und Barcode. */
    async searchProducts(tenantId: string, query: unknown): Promise<{ items: BomProductDto[] }> {
        const needle = String(query ?? '').trim();
        if (needle.length < 1) return { items: [] };
        const found = await this.stock.search(tenantId, needle, 20);
        if (!found.length) return { items: [] };
        const facts = await this.reservations.facts(tenantId, found.map((product) => product.productId));
        return { items: found.map((product) => productDto(product, facts.coverage.free.get(product.productId))) };
    }

    /** Die Zeilen einer Eingabe mit dem Abzug ihrer Depo-Karten. */
    async linesFrom(tenantId: string, raw: unknown): Promise<BomLineDraft[]> {
        const drafts = lineDraftsFrom(raw);
        if (!drafts.length) return [];
        const products = await this.stock.products(tenantId, drafts.map((draft) => draft.productId));
        return drafts.map((draft, index) => {
            const product = products.get(draft.productId);
            if (!product) {
                throw bomError('PRODUCT_NOT_FOUND', `Zeile ${index + 1}: die Depo-Karte gibt es nicht mehr.`, {
                    status: 404,
                    params: { row: index + 1 },
                    details: [{ row: index + 1, productId: draft.productId }],
                });
            }
            return snapshotLine(product, draft);
        });
    }

    private async inputFrom(tenantId: string, body: unknown): Promise<BomTemplateInput> {
        const head = templateHeadFrom(body);
        const lines = await this.linesFrom(tenantId, (body as Record<string, unknown> | null)?.lines);
        return { ...head, lines };
    }

    /* ── Das Beispiel «CHILLER» ────────────────────────────────────────── */

    /**
     * «Veritabanına gönder o örnekleri» — legt die Beispiel-Vorlagen an, und
     * mit ihnen die Depo-Gruppen und -Karten, die ihre Zeilen brauchen. Jede
     * Vorlage nur einmal je Firma (`exampleKey`, auch nach dem Löschen nicht
     * wieder); eine Karte, die es mit derselben Marke und Typennummer schon
     * gibt, wird verwendet statt neu angelegt.
     */
    async seedExamples(tenantId: string, actor: BomActor): Promise<{ templates: number; products: number; groups: number }> {
        if (!actor.isAdmin && !actor.canManage) {
            throw bomError('FORBIDDEN', 'Beispiele legt die Administratorrolle an.', { status: 403 });
        }
        const done = await this.templates.exampleKeys(tenantId);
        const pending = EXAMPLE_TEMPLATES.filter((template) => !done.has(template.key));
        if (!pending.length) return { templates: 0, products: 0, groups: 0 };

        // 1) Kategorien und Gruppen
        const tree = await this.warehouse.groups.tree(tenantId);
        const categoryIds = new Map<string, string>();
        for (const category of tree.categories) categoryIds.set(category.code, category.id);
        for (const category of EXAMPLE_CATEGORIES) {
            if (categoryIds.has(category.code)) continue;
            const byName = await this.warehouse.groups.findCategory(tenantId, { name: category.name });
            const created = byName ?? await this.warehouse.groups.createCategory(tenantId, { name: category.name, code: category.code });
            categoryIds.set(category.code, created.id);
        }
        const groupIds = new Map<string, string>();
        for (const category of tree.categories) {
            for (const group of category.groups) if (group.code) groupIds.set(`${category.code}-${group.code}`, group.id);
        }
        let groupsCreated = 0;
        const neededGroups = new Set(EXAMPLE_PRODUCTS.map((product) => product.group));
        for (const group of EXAMPLE_GROUPS.filter((entry) => neededGroups.has(entry.code))) {
            const key = `${group.category}-${group.code}`;
            if (groupIds.has(key)) continue;
            const categoryId = categoryIds.get(group.category);
            if (!categoryId) continue;
            const byName = await this.warehouse.groups.findGroup(tenantId, categoryId, { name: group.name });
            if (byName) {
                groupIds.set(key, byName.id);
                continue;
            }
            const created = await this.warehouse.groups.createGroup(tenantId, { categoryId, name: group.name, code: group.code });
            groupIds.set(key, created.id);
            groupsCreated += 1;
        }

        // 2) Karten (gleiche Marke + Typennummer = dieselbe Karte)
        const neededProducts = new Set(pending.flatMap((template) => template.lines.map((line) => line.product)));
        const suppliers = await this.warehouse.directory.suppliersByName(
            tenantId,
            EXAMPLE_PRODUCTS.flatMap((product) => (product.supplier ? [product.supplier] : [])),
        );
        const productIds = new Map<string, string>();
        let productsCreated = 0;
        for (const example of EXAMPLE_PRODUCTS.filter((product) => neededProducts.has(product.key))) {
            const existing = await this.stock.search(tenantId, example.modelNumber, 10);
            const same = existing.find((product) =>
                (product.modelNumber ?? '').trim().toLowerCase() === example.modelNumber.toLowerCase()
                && (product.brand ?? '').trim().toLowerCase() === (example.brand ?? '').toLowerCase());
            if (same) {
                productIds.set(example.key, same.productId);
                continue;
            }
            const category = EXAMPLE_GROUPS.find((group) => group.code === example.group)?.category ?? 'MAK';
            const groupId = groupIds.get(`${category}-${example.group}`) ?? null;
            const supplier = example.supplier ? suppliers.get(example.supplier.trim().toLocaleLowerCase('tr-TR')) : undefined;
            const fields: WarehouseProductFields = {
                erpCode: null,
                materialGroupId: groupId,
                name: example.name,
                brand: example.brand,
                modelNumber: example.modelNumber,
                suppliers: supplier ? [{ supplierId: supplier.id, name: supplier.name, barcode: null }] : [],
                description: example.description ?? null,
                quantity: 0,
                purchasePrice: null,
                minimumOrderQuantity: example.minimumOrderQuantity ?? null,
                currency: null,
                barcode: null,
                manufacturerBarcode: null,
                serialRequired: Boolean(example.serialRequired),
            };
            const created = await this.warehouse.products.create(tenantId, fields, [], actor.id, { issueCode: Boolean(groupId) });
            productIds.set(example.key, created.id);
            productsCreated += 1;
        }

        // 3) Vorlagen
        const products = await this.stock.products(tenantId, [...productIds.values()]);
        let templatesCreated = 0;
        for (const template of pending) {
            const lines = template.lines.flatMap((line): BomLineDraft[] => {
                const id = productIds.get(line.product);
                const product = id ? products.get(id) : undefined;
                return product ? [snapshotLine(product, { quantity: line.quantity, unit: line.unit ?? 'PCS', note: line.note ?? null })] : [];
            });
            try {
                await this.templates.create(tenantId, {
                    name: template.name,
                    category: template.category,
                    mainCard: template.mainCard,
                    codePrefix: template.codePrefix,
                    description: template.description,
                    lines,
                }, actor.id, template.key);
                templatesCreated += 1;
            } catch (error) {
                // Gleichzeitig zweimal geöffnet: das Beispiel steht schon (exampleKey eindeutig).
                if ((error as { code?: string })?.code !== 'P2002') throw error;
            }
        }
        return { templates: templatesCreated, products: productsCreated, groups: groupsCreated };
    }
}

/** Der Abzug einer Karte in einer Zeile — «ürünün tüm satırı». */
export const snapshotLine = (
    product: BomStockProduct,
    draft: { quantity: number; unit: BomLineDraft['unit']; note: string | null },
): BomLineDraft => ({
    productId: product.productId,
    erpCode: product.erpCode,
    name: product.name,
    brand: product.brand,
    modelNumber: product.modelNumber,
    quantity: draft.quantity,
    unit: draft.unit,
    note: draft.note,
});
