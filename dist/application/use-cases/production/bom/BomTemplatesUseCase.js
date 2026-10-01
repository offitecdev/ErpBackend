"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.snapshotLine = exports.BomTemplatesUseCase = void 0;
const productionBom_1 = require("../../../../domain/services/productionBom");
const bomExamples_1 = require("./bomExamples");
const bomReadModel_1 = require("./bomReadModel");
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
class BomTemplatesUseCase {
    templates;
    boms;
    stock;
    reservations;
    warehouse;
    constructor(templates, boms, stock, reservations, warehouse) {
        this.templates = templates;
        this.boms = boms;
        this.stock = stock;
        this.reservations = reservations;
        this.warehouse = warehouse;
    }
    assertCanWrite(actor) {
        if (!actor.isAdmin && !actor.canManage) {
            throw (0, productionBom_1.bomError)('FORBIDDEN', 'Vorlagen pflegen die Administratorrolle und «Produktion verwalten».', { status: 403 });
        }
    }
    async list(tenantId) {
        const items = await this.templates.list(tenantId);
        return { items: items.map(bomReadModel_1.templateSummaryDto) };
    }
    async get(tenantId, id) {
        const template = await this.templates.get(tenantId, id);
        if (!template)
            throw (0, productionBom_1.bomError)('TEMPLATE_NOT_FOUND', 'BOM-Vorlage nicht gefunden.', { status: 404 });
        const productIds = template.lines.map((line) => line.productId);
        const [facts, usage] = await Promise.all([
            this.reservations.facts(tenantId, productIds),
            this.boms.usageByTemplate(tenantId),
        ]);
        return (0, bomReadModel_1.templateDto)(template, facts.products, facts.coverage.free, usage.get(template.id) ?? 0);
    }
    async create(tenantId, actor, body) {
        this.assertCanWrite(actor);
        const input = await this.inputFrom(tenantId, body);
        const created = await this.templates.create(tenantId, input, actor.id);
        return this.get(tenantId, created.id);
    }
    async update(tenantId, actor, id, body) {
        this.assertCanWrite(actor);
        const input = await this.inputFrom(tenantId, body);
        const updated = await this.templates.update(tenantId, id, input, actor.id);
        if (!updated)
            throw (0, productionBom_1.bomError)('TEMPLATE_NOT_FOUND', 'BOM-Vorlage nicht gefunden.', { status: 404 });
        return this.get(tenantId, id);
    }
    async remove(tenantId, actor, id) {
        this.assertCanWrite(actor);
        const removed = await this.templates.remove(tenantId, id, actor.id);
        if (!removed)
            throw (0, productionBom_1.bomError)('TEMPLATE_NOT_FOUND', 'BOM-Vorlage nicht gefunden.', { status: 404 });
        return { removed: true };
    }
    /**
     * «erp kodu, model numarası, ürün adına göre aratma» — auch Marke und Barcode.
     * `area` (01.10.2026): nur Karten der Kod türleri dieses Bereichs (Depo › Ayarlar).
     */
    async searchProducts(tenantId, query, area) {
        const needle = String(query ?? '').trim();
        if (needle.length < 1)
            return { items: [] };
        const found = await this.stock.search(tenantId, needle, 20, (0, productionBom_1.areaFrom)(area));
        if (!found.length)
            return { items: [] };
        const facts = await this.reservations.facts(tenantId, found.map((product) => product.productId));
        return { items: found.map((product) => (0, bomReadModel_1.productDto)(product, facts.coverage.free.get(product.productId))) };
    }
    /** Die Zeilen einer Eingabe mit dem Abzug ihrer Depo-Karten. */
    async linesFrom(tenantId, raw) {
        const drafts = (0, productionBom_1.lineDraftsFrom)(raw);
        if (!drafts.length)
            return [];
        const products = await this.stock.products(tenantId, drafts.map((draft) => draft.productId));
        return drafts.map((draft, index) => {
            const product = products.get(draft.productId);
            if (!product) {
                throw (0, productionBom_1.bomError)('PRODUCT_NOT_FOUND', `Zeile ${index + 1}: die Depo-Karte gibt es nicht mehr.`, {
                    status: 404,
                    params: { row: index + 1 },
                    details: [{ row: index + 1, productId: draft.productId }],
                });
            }
            return (0, exports.snapshotLine)(product, draft);
        });
    }
    async inputFrom(tenantId, body) {
        const head = (0, productionBom_1.templateHeadFrom)(body);
        const lines = await this.linesFrom(tenantId, body?.lines);
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
    async seedExamples(tenantId, actor) {
        if (!actor.isAdmin && !actor.canManage) {
            throw (0, productionBom_1.bomError)('FORBIDDEN', 'Beispiele legt die Administratorrolle an.', { status: 403 });
        }
        const done = await this.templates.exampleKeys(tenantId);
        const pending = bomExamples_1.EXAMPLE_TEMPLATES.filter((template) => !done.has(template.key));
        if (!pending.length)
            return { templates: 0, products: 0, groups: 0 };
        // 1) Kategorien und Gruppen
        const tree = await this.warehouse.groups.tree(tenantId);
        const categoryIds = new Map();
        for (const category of tree.categories)
            categoryIds.set(category.code, category.id);
        for (const category of bomExamples_1.EXAMPLE_CATEGORIES) {
            if (categoryIds.has(category.code))
                continue;
            const byName = await this.warehouse.groups.findCategory(tenantId, { name: category.name });
            const created = byName ?? await this.warehouse.groups.createCategory(tenantId, { name: category.name, code: category.code });
            categoryIds.set(category.code, created.id);
        }
        const groupIds = new Map();
        for (const category of tree.categories) {
            for (const group of category.groups)
                if (group.code)
                    groupIds.set(`${category.code}-${group.code}`, group.id);
        }
        let groupsCreated = 0;
        const neededGroups = new Set(bomExamples_1.EXAMPLE_PRODUCTS.map((product) => product.group));
        for (const group of bomExamples_1.EXAMPLE_GROUPS.filter((entry) => neededGroups.has(entry.code))) {
            const key = `${group.category}-${group.code}`;
            if (groupIds.has(key))
                continue;
            const categoryId = categoryIds.get(group.category);
            if (!categoryId)
                continue;
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
        const suppliers = await this.warehouse.directory.suppliersByName(tenantId, bomExamples_1.EXAMPLE_PRODUCTS.flatMap((product) => (product.supplier ? [product.supplier] : [])));
        const productIds = new Map();
        let productsCreated = 0;
        for (const example of bomExamples_1.EXAMPLE_PRODUCTS.filter((product) => neededProducts.has(product.key))) {
            const existing = await this.stock.search(tenantId, example.modelNumber, 10);
            const same = existing.find((product) => (product.modelNumber ?? '').trim().toLowerCase() === example.modelNumber.toLowerCase()
                && (product.brand ?? '').trim().toLowerCase() === (example.brand ?? '').toLowerCase());
            if (same) {
                productIds.set(example.key, same.productId);
                continue;
            }
            const category = bomExamples_1.EXAMPLE_GROUPS.find((group) => group.code === example.group)?.category ?? 'MAK';
            const groupId = groupIds.get(`${category}-${example.group}`) ?? null;
            const supplier = example.supplier ? suppliers.get(example.supplier.trim().toLocaleLowerCase('tr-TR')) : undefined;
            const fields = {
                erpCode: null,
                materialGroupId: groupId,
                name: example.name,
                brand: example.brand,
                modelNumber: example.modelNumber,
                suppliers: supplier ? [{ supplierId: supplier.id, name: supplier.name, barcode: null, email: null }] : [],
                productCode: null,
                unit: 'PCS',
                // Ein Beispiel ohne E-Mail des Lieferanten ist noch keine fertige Karte (30.09.2026).
                isDraft: true,
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
            const lines = template.lines.flatMap((line) => {
                const id = productIds.get(line.product);
                const product = id ? products.get(id) : undefined;
                return product ? [(0, exports.snapshotLine)(product, { quantity: line.quantity, unit: line.unit ?? 'PCS', note: line.note ?? null })] : [];
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
            }
            catch (error) {
                // Gleichzeitig zweimal geöffnet: das Beispiel steht schon (exampleKey eindeutig).
                if (error?.code !== 'P2002')
                    throw error;
            }
        }
        return { templates: templatesCreated, products: productsCreated, groups: groupsCreated };
    }
}
exports.BomTemplatesUseCase = BomTemplatesUseCase;
/** Der Abzug einer Karte in einer Zeile — «ürünün tüm satırı». */
const snapshotLine = (product, draft) => ({
    productId: product.productId,
    erpCode: product.erpCode,
    name: product.name,
    brand: product.brand,
    modelNumber: product.modelNumber,
    quantity: draft.quantity,
    unit: draft.unit,
    note: draft.note,
});
exports.snapshotLine = snapshotLine;
//# sourceMappingURL=BomTemplatesUseCase.js.map