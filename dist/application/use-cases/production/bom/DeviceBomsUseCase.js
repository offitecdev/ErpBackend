"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeviceBomsUseCase = void 0;
const nanoid_1 = require("nanoid");
const ProductionBom_1 = require("../../../../domain/entities/ProductionBom");
const productionBom_1 = require("../../../../domain/services/productionBom");
const bomReadModel_1 = require("./bomReadModel");
const EPS = 1e-9;
/** `procurementRequestId` im Körper — der Talep, aus dem der Einkauf gerade Belege macht. */
const procurementRequestIdOf = (body) => {
    const raw = (body && typeof body === 'object' ? body.procurementRequestId : null);
    const value = typeof raw === 'string' ? raw.trim() : '';
    return value ? value.slice(0, 64) : null;
};
/**
 * «Sipariş oluştur» einer BOM läuft nacheinander (Sperre im Prozess): zwei
 * gleichzeitige Durchgänge sähen sonst dieselbe Lage und legten je eine
 * Bestellung für denselben Lieferanten an — oder bestellten eine Zeile zweimal.
 */
const orderLocks = new Map();
const withOrderLock = async (key, run) => {
    const previous = orderLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    orderLocks.set(key, next);
    try {
        return await next;
    }
    finally {
        if (orderLocks.get(key) === next)
            orderLocks.delete(key);
    }
};
/**
 * ── DIE BOMs EINES GERÄTS (27.09.2026, Vorgabe Samet) ───────────────────────
 *
 * «Chiller altına MAKİNE olarak seçildiyse bu şablonlar girildiğinde direkt
 *  eklenebilecek, ancak max 2'ye ayarlı olsun … kart kart olabilir … BOM
 *  onaylanınca stoktan düşülmeli, rezerve olmalı … stokta olmayan kadarı
 *  sipariş edilecek … BOM TAMAMLA.»
 *
 * Wer bearbeitet: die Administratorrolle, `production.manage` und wer am
 * Gerät eine Aufgabe der Stufe BOM im Bereich hat («zaten burada genelde tek
 * görev şu: BOM doldur»). Lesen darf, wer die Produktion sieht.
 */
class DeviceBomsUseCase {
    boms;
    templates;
    stock;
    purchases;
    directory;
    settings;
    reservations;
    templateUseCase;
    writer;
    nextOrderNumber;
    nextRequestNumber;
    revisions;
    constructor(boms, templates, stock, purchases, directory, settings, reservations, templateUseCase, writer, nextOrderNumber, nextRequestNumber, revisions) {
        this.boms = boms;
        this.templates = templates;
        this.stock = stock;
        this.purchases = purchases;
        this.directory = directory;
        this.settings = settings;
        this.reservations = reservations;
        this.templateUseCase = templateUseCase;
        this.writer = writer;
        this.nextOrderNumber = nextOrderNumber;
        this.nextRequestNumber = nextRequestNumber;
        this.revisions = revisions;
    }
    /* ── Lesen ─────────────────────────────────────────────────────────── */
    /**
     * «BOM listede kart kart olmamalı, direkt boş liste açılmalı … her zaman bir
     * ana BOM olmak zorundadır.» Wer bearbeiten darf, bekommt die Haupt-BOM des
     * Bereichs beim ersten Öffnen angelegt (BOM-MEK-00001); Lesende sehen sie,
     * sobald es sie gibt.
     */
    async view(tenantId, actor, itemId, rawArea) {
        const area = (0, productionBom_1.areaFrom)(rawArea) ?? 'MECHANICAL';
        const device = await this.requireDevice(tenantId, itemId);
        const [project, settings, listed, templates, assignees, deliveryDates] = await Promise.all([
            this.directory.project(tenantId, device.productionProjectId),
            this.settings.get(tenantId),
            this.boms.listForDevice(tenantId, itemId),
            this.templates.list(tenantId),
            this.directory.bomStageAssignees(tenantId, itemId, area),
            this.directory.deliveryDates(tenantId, [device.productionProjectId]),
        ]);
        if (!project)
            throw (0, productionBom_1.bomError)('DEVICE_NOT_FOUND', 'Das Projekt des Geräts gibt es nicht mehr.', { status: 404 });
        const canEdit = this.canEdit(actor, assignees);
        let all = listed;
        let main = all.find((bom) => bom.kind === 'MAIN' && bom.area === area) ?? null;
        if (!main && canEdit) {
            main = await this.ensureMain(tenantId, actor, device, area);
            all = [...all.filter((bom) => bom.id !== main.id), main];
        }
        const subs = main ? this.subsOf(main, all) : [];
        const shown = main ? [main, ...subs] : [];
        const dtos = await this.dtos(tenantId, shown, all);
        const category = ProductionBom_1.CATEGORY_OF_AREA[area];
        return {
            settings: { maxPerArea: settings.maxPerArea },
            area,
            device: { id: device.id, name: device.name, quantity: device.quantity, positionNumber: device.positionNumber, isActive: device.isActive },
            project: {
                id: project.id,
                projectNumber: project.projectNumber,
                projectName: project.projectName,
                customerName: project.customerName,
                deliveryDate: deliveryDates.get(project.id)?.toISOString() ?? null,
            },
            canEdit,
            counts: {
                MECHANICAL: all.filter((bom) => bom.area === 'MECHANICAL').length,
                ELECTRICAL: all.filter((bom) => bom.area === 'ELECTRICAL').length,
            },
            main: dtos[0] ?? null,
            subs: dtos.slice(1),
            boms: dtos,
            codes: settings.codes[area],
            templates: templates.filter((template) => template.category === category).map(bomReadModel_1.templateSummaryDto),
        };
    }
    async get(tenantId, bomId) {
        const bom = await this.requireBom(tenantId, bomId);
        const [dto] = await this.dtos(tenantId, [bom]);
        return dto;
    }
    /**
     * Die Alt-BOMs einer Haupt-BOM, in ihrer Reihenfolge. Eine alte BOM ohne
     * Haupt-BOM (vor der Hierarchie angelegt) im selben Bereich zählt mit.
     */
    subsOf(main, all) {
        return all
            .filter((bom) => bom.kind === 'SUB' && bom.area === main.area
            && bom.productionItemId === main.productionItemId
            && (bom.parentBomId === main.id || !bom.parentBomId))
            .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.getTime() - b.createdAt.getTime());
    }
    /**
     * Die DTOs mit Reservierung, Bestellungen und Stand von «BOM tamamla».
     * `deviceBoms` = alle BOMs der Geräte (für die Alt-BOMs einer Haupt-BOM);
     * fehlt es, liest die Funktion sie nach.
     */
    async dtos(tenantId, boms, deviceBoms) {
        if (!boms.length)
            return [];
        const productIds = boms.flatMap((bom) => bom.lines.map((line) => line.productId));
        const mains = boms.filter((bom) => bom.kind === 'MAIN');
        const loadDevices = async () => {
            if (deviceBoms)
                return deviceBoms;
            const items = [...new Set(mains.map((main) => main.productionItemId))];
            return (await Promise.all(items.map((itemId) => this.boms.listForDevice(tenantId, itemId)))).flat();
        };
        const bomIds = boms.map((bom) => bom.id);
        const [facts, purchases, pool, revisions, purchaseRevisions] = await Promise.all([
            this.reservations.facts(tenantId, productIds),
            this.purchasesOf(tenantId, bomIds),
            mains.length ? loadDevices() : Promise.resolve([]),
            this.revisions.listForBoms(tenantId, bomIds),
            this.revisions.purchaseRevisionsForBoms(tenantId, bomIds),
        ]);
        // Die Karten der Arbeitskopie, die (noch) keine Zeile der BOM sind — mit ihrem freien Bestand.
        const draftProducts = [...new Set(revisions
                .filter((entry) => entry.status === 'DRAFT')
                .flatMap((entry) => entry.lines.map((line) => line.productId))
                .filter((productId) => !facts.products.has(productId)))];
        const personIds = [
            ...revisions.flatMap((entry) => [entry.createdById, entry.approvedById]),
            ...boms.filter((bom) => bom.status !== 'DRAFT').map((bom) => bom.approvedById),
        ].filter((id) => Boolean(id));
        const [extra, names] = await Promise.all([
            draftProducts.length ? this.reservations.facts(tenantId, draftProducts) : Promise.resolve(null),
            personIds.length ? this.directory.personNames(personIds) : Promise.resolve(new Map()),
        ]);
        const products = extra ? new Map([...facts.products, ...extra.products]) : facts.products;
        const free = extra ? new Map([...facts.coverage.free, ...extra.coverage.free]) : facts.coverage.free;
        const procurement = this.procurement
            ? await this.procurement.forBoms(tenantId, bomIds, purchases.map(({ link, order }) => ({ kind: link.kind, order })))
            : null;
        return boms.map((bom) => (0, bomReadModel_1.bomDto)(bom, {
            procurement: procurement?.requests.get(bom.id) ?? [],
            goodsIn: procurement?.goodsIn.get(bom.id) ?? [],
            coverage: facts.coverage.lines,
            products,
            free,
            purchases: purchases.filter((entry) => entry.link.bomId === bom.id),
            ...(bom.kind === 'MAIN' ? { subs: this.subsOf(bom, pool) } : {}),
            revisions,
            purchaseRevisions,
            names,
        }));
    }
    /** Bestellungen/Anfragen der BOMs — verwaiste Verknüpfungen heilen beim Lesen. */
    async purchasesOf(tenantId, bomIds) {
        const links = await this.purchases.pruneOrphans(tenantId, await this.purchases.linksForBoms(tenantId, bomIds));
        if (!links.length)
            return [];
        const orders = await this.purchases.orders(tenantId, links.map((link) => link.purchaseOrderId));
        const byId = new Map(orders.map((order) => [order.id, order]));
        return links.flatMap((link) => {
            const order = byId.get(link.purchaseOrderId);
            return order ? [{ link, order }] : [];
        });
    }
    /* ── Anlegen, Zeilen, Löschen ──────────────────────────────────────── */
    /**
     * Die Haupt-BOM des Geräts im Bereich — angelegt, wenn es sie noch nicht
     * gibt (BOM-MEK-00001 / BOM-ELK-00001, leer). Zwei gleichzeitige Aufrufe
     * legen nie zwei an: der eindeutige Schlüssel lässt den zweiten scheitern,
     * und er liest dann die erste.
     */
    async ensureMain(tenantId, actor, device, area) {
        const existing = await this.boms.findMain(tenantId, device.id, area);
        if (existing)
            return existing;
        try {
            return await this.boms.create(tenantId, {
                productionProjectId: device.productionProjectId,
                productionItemId: device.id,
                area,
                kind: 'MAIN',
                parentBomId: null,
                templateId: null,
                templateName: '',
                mainCard: null,
                codePrefix: ProductionBom_1.MAIN_BOM_PREFIX[area],
                lines: [],
            }, actor.id);
        }
        catch (error) {
            if (error?.code === 'P2002') {
                const created = await this.boms.findMain(tenantId, device.id, area);
                if (created)
                    return created;
            }
            throw error;
        }
    }
    /**
     * «Alt BOM kodları ayarlardan Mekanik ve Elektrik için ayrı ayrı belirlenir …
     *  illa şablondan eklemek zorunda değiliz, boş BOM da olabilir.» Eine leere
     * Alt-BOM unter der Haupt-BOM; ihre Nummer zählt der gewählte Kod der
     * Einstellungen (MAK-COOL-00001). Die Zeilen kommen danach — gesucht oder aus
     * einer Vorlage eingefügt.
     */
    async addSub(tenantId, actor, itemId, body) {
        const input = (body && typeof body === 'object' ? body : {});
        const area = (0, productionBom_1.areaFrom)(input.area);
        if (!area)
            throw (0, productionBom_1.bomError)('CATEGORY_MISMATCH', 'Bereich fehlt (Mekanik / Elektrik).');
        const device = await this.requireDevice(tenantId, itemId);
        await this.assertCanEdit(tenantId, actor, itemId, area);
        const settings = await this.settings.get(tenantId);
        const prefix = (0, productionBom_1.prefixFrom)(input.prefix);
        const code = prefix ? settings.codes[area].find((entry) => entry.prefix === prefix) : undefined;
        if (!code) {
            throw (0, productionBom_1.bomError)('CODE_UNKNOWN', 'Diesen Alt-BOM-Kod gibt es in den Einstellungen nicht.', {
                params: { prefix: String(input.prefix ?? '').slice(0, 40) },
            });
        }
        const main = await this.ensureMain(tenantId, actor, device, area);
        if (main.status === 'COMPLETED' || main.consumedAt) {
            throw (0, productionBom_1.bomError)('PARENT_COMPLETED', 'Die Haupt-BOM ist abgeschlossen — erst wieder öffnen.', { status: 409, params: { number: main.bomNumber } });
        }
        const count = await this.boms.countChildren(tenantId, main.id);
        if (count >= settings.maxPerArea) {
            throw (0, productionBom_1.bomError)('MAX_REACHED', `Höchstens ${settings.maxPerArea} Alt-BOMs je Haupt-BOM.`, {
                status: 409,
                params: { max: settings.maxPerArea },
            });
        }
        const bom = await this.boms.create(tenantId, {
            productionProjectId: device.productionProjectId,
            productionItemId: device.id,
            area,
            kind: 'SUB',
            parentBomId: main.id,
            templateId: null,
            templateName: code.name,
            mainCard: null,
            codePrefix: code.prefix,
            lines: [],
        }, actor.id);
        return { bom: await this.get(tenantId, bom.id) };
    }
    async saveLines(tenantId, actor, bomId, body) {
        const bom = await this.requireBom(tenantId, bomId);
        await this.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        if (bom.status !== 'DRAFT') {
            // «Bom onaylanırsa geri dönüş yok, revize olması lazım» (27.09.2026):
            // eine freigegebene BOM ändert nur ihre Revision im Entwurf.
            await this.saveRevisionLines(tenantId, actor, bom, body);
            return { bom: await this.get(tenantId, bomId) };
        }
        const lines = await this.templateUseCase.linesFrom(tenantId, body?.lines);
        const saved = await this.boms.replaceLines(tenantId, bomId, lines, actor.id);
        if (!saved)
            throw (0, productionBom_1.bomError)('STATUS_INVALID', 'Die BOM ist nicht mehr im Entwurf.', { status: 409 });
        return { bom: await this.get(tenantId, bomId) };
    }
    /**
     * Die Zeilen der Revision im Entwurf speichern. Jede Zeile behält ihre
     * Kennung je Karte — zuerst die der geltenden BOM (so bleiben die
     * Bestellungen an ihrer Zeile), dann die der Arbeitskopie (Preisanfragen
     * der Revision), sonst eine neue.
     */
    async saveRevisionLines(tenantId, actor, bom, body) {
        const draft = bom.consumedAt ? null : await this.revisions.draftOf(tenantId, bom.id);
        if (!draft) {
            throw (0, productionBom_1.bomError)('REVISION_NONE', 'Eine freigegebene BOM ändert sich nur über eine Revision («Revize et»).', { status: 409 });
        }
        const drafts = await this.templateUseCase.linesFrom(tenantId, body?.lines);
        const ids = (0, productionBom_1.revisionLineIds)(drafts, [bom.lines, draft.lines], () => (0, nanoid_1.nanoid)(12));
        const lines = drafts.map((line, index) => ({
            id: ids[index],
            productId: line.productId,
            erpCode: line.erpCode,
            name: line.name,
            brand: line.brand,
            modelNumber: line.modelNumber,
            unit: line.unit,
            quantity: line.quantity,
            note: line.note,
        }));
        const saved = await this.revisions.saveDraftLines(tenantId, bom.id, lines, actor.id);
        if (!saved)
            throw (0, productionBom_1.bomError)('REVISION_NONE', 'Die Revision ist nicht mehr im Entwurf.', { status: 409 });
    }
    /**
     * Die Zeilen, an denen gerade gearbeitet wird: im Entwurf die der BOM, bei
     * einer freigegebenen BOM mit offener Revision die der Arbeitskopie.
     */
    async workingLinesOf(tenantId, bom) {
        if (bom.status === 'DRAFT' || bom.consumedAt)
            return { lines: bom.lines, revision: bom.revision, draft: bom.status === 'DRAFT' };
        const draft = await this.revisions.draftOf(tenantId, bom.id);
        if (!draft)
            return { lines: bom.lines, revision: bom.revision, draft: false };
        return {
            revision: draft.revision,
            draft: true,
            lines: draft.lines.map((line, index) => ({
                id: line.id,
                bomId: bom.id,
                productId: line.productId,
                erpCode: line.erpCode,
                name: line.name,
                brand: line.brand,
                modelNumber: line.modelNumber,
                unit: line.unit,
                quantity: line.quantity,
                consumedQuantity: 0,
                note: line.note,
                sortOrder: index,
            })),
        };
    }
    async remove(tenantId, actor, bomId) {
        const bom = await this.requireBom(tenantId, bomId);
        await this.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        // «Her zaman bir ana BOM olmak zorundadır» — sie wird geleert, nicht gelöscht.
        if (bom.kind === 'MAIN')
            throw (0, productionBom_1.bomError)('MAIN_LOCKED', 'Die Haupt-BOM bleibt immer stehen.', { status: 409 });
        if (bom.consumedAt)
            throw (0, productionBom_1.bomError)('ALREADY_CONSUMED', 'Diese BOM ist schon vom Bestand abgebucht.', { status: 409 });
        // «Bom onaylanırsa geri dönüş yok»: eine freigegebene BOM bleibt als Nachweis stehen.
        if (bom.status !== 'DRAFT') {
            throw (0, productionBom_1.bomError)('APPROVAL_FINAL', 'Eine freigegebene BOM wird nicht gelöscht — geändert wird sie über eine Revision.', { status: 409 });
        }
        // Auch ihre Preisanfragen gehören ihr — ohne BOM stünden sie verwaist da.
        await this.assertNoOrders(tenantId, bom, { requests: true });
        const removed = await this.boms.remove(tenantId, bomId);
        if (!removed)
            throw (0, productionBom_1.bomError)('BOM_NOT_FOUND', 'BOM nicht gefunden.', { status: 404 });
        if (bom.status !== 'DRAFT')
            await this.reservations.releaseForDevice(tenantId, bom).catch(() => undefined);
        return { removed: true };
    }
    /* ── Freigeben, Abschliessen, Verbrauchen ──────────────────────────── */
    /** «BOM onaylanınca stoktan düşülmeli, rezerve olmalı.» */
    async approve(tenantId, actor, bomId) {
        const bom = await this.requireBom(tenantId, bomId);
        await this.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        // Die Haupt-BOM darf leer freigegeben werden — ihre Alt-BOMs tragen dann alles.
        if (!bom.lines.length && bom.kind !== 'MAIN')
            throw (0, productionBom_1.bomError)('LINES_REQUIRED', 'Eine leere BOM lässt sich nicht freigeben.');
        const products = await this.stock.products(tenantId, bom.lines.map((line) => line.productId));
        const missingCard = bom.lines.findIndex((line) => !products.has(line.productId));
        if (missingCard >= 0) {
            throw (0, productionBom_1.bomError)('PRODUCT_NOT_FOUND', `Zeile ${missingCard + 1}: die Depo-Karte gibt es nicht mehr.`, {
                status: 409,
                params: { row: missingCard + 1 },
            });
        }
        const approved = await this.boms.setStatus(tenantId, bomId, ['DRAFT'], {
            status: 'APPROVED',
            approvedAt: new Date(),
            approvedById: actor.id,
        }, actor.id);
        if (!approved)
            throw (0, productionBom_1.bomError)('STATUS_INVALID', 'Die BOM ist nicht mehr im Entwurf.', { status: 409 });
        // Rev.0 — der Abzug der Freigabe («eski bom kayıt edilmeli»). Fehlt er hier,
        // entsteht er beim ersten «Revize et» (die Zeilen sind bis dahin dieselben).
        await this.revisions.ensureBaseline(tenantId, approved).catch((error) => {
            console.warn('[production-bom] baseline revision failed', bomId, error?.message);
        });
        await this.reservations.assignFreeSerials(tenantId, approved.lines.map((line) => line.productId));
        return { bom: await this.get(tenantId, bomId) };
    }
    /**
     * «Bom onaylanırsa geri dönüş yok, revize olması lazım» (Samet, 27.09.2026):
     * die Freigabe wird nicht mehr zurückgenommen — geändert wird über eine
     * Revision («Revize et»), die alte Fassung bleibt stehen.
     */
    async unapprove(tenantId, actor, bomId) {
        const bom = await this.requireBom(tenantId, bomId);
        await this.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        throw (0, productionBom_1.bomError)('APPROVAL_FINAL', 'Eine freigegebene BOM geht nicht in den Entwurf zurück — «Revize et».', { status: 409 });
    }
    /** «BOM TAMAMLA» — nur, wenn alles bestellt, bestätigt und reserviert ist. */
    async complete(tenantId, actor, bomId) {
        const bom = await this.requireBom(tenantId, bomId);
        await this.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        await this.assertNoOpenRevision(tenantId, [bom]);
        const [dto] = await this.dtos(tenantId, [bom]);
        if (!dto?.completion.ready) {
            throw (0, productionBom_1.bomError)('NOT_READY', 'Noch nicht alles bestellt, bestätigt und reserviert.', {
                status: 409,
                details: dto?.completion,
            });
        }
        // Die Haupt-BOM ohne eigene Zeilen schliesst auch aus dem Entwurf ab (keine Freigabe nötig).
        const from = bom.kind === 'MAIN' && !bom.lines.length ? ['DRAFT', 'APPROVED'] : ['APPROVED'];
        const completed = await this.boms.setStatus(tenantId, bomId, from, {
            status: 'COMPLETED',
            completedAt: new Date(),
            completedById: actor.id,
        }, actor.id);
        if (!completed)
            throw (0, productionBom_1.bomError)('STATUS_INVALID', 'Die BOM ist nicht freigegeben.', { status: 409 });
        return { bom: await this.get(tenantId, bomId) };
    }
    async reopen(tenantId, actor, bomId) {
        const bom = await this.requireBom(tenantId, bomId);
        await this.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        // Eine Alt-BOM unter einer abgeschlossenen Haupt-BOM bleibt zu — sonst stimmte «tamamlandı» oben nicht mehr.
        if (bom.kind === 'SUB' && bom.parentBomId) {
            const parent = await this.boms.get(tenantId, bom.parentBomId);
            if (parent && (parent.status === 'COMPLETED' || parent.consumedAt)) {
                throw (0, productionBom_1.bomError)('PARENT_COMPLETED', 'Erst die Haupt-BOM wieder öffnen.', { status: 409, params: { number: parent.bomNumber } });
            }
        }
        const reopened = await this.boms.setStatus(tenantId, bomId, ['COMPLETED'], {
            status: 'APPROVED',
            completedAt: null,
            completedById: null,
        }, actor.id);
        if (!reopened)
            throw (0, productionBom_1.bomError)('STATUS_INVALID', 'Die BOM ist nicht abgeschlossen.', { status: 409 });
        return { bom: await this.get(tenantId, bomId) };
    }
    /**
     * «Proje bitince de rezerveler stoktan düşmeli tamamen» — die Reservierung
     * einer abgeschlossenen BOM verlässt den Bestand: Mengen gehen ab, die
     * reservierten Seriennummern verlassen die Karte (sie stehen danach im
     * Verbrauch der BOM, mit Gerät).
     */
    async consume(tenantId, actor, bomId) {
        const bom = await this.requireBom(tenantId, bomId);
        await this.assertCanEdit(tenantId, actor, bom.productionItemId, bom.area);
        if (bom.consumedAt)
            throw (0, productionBom_1.bomError)('ALREADY_CONSUMED', 'Diese BOM ist schon abgebucht.', { status: 409 });
        if (bom.status !== 'COMPLETED') {
            throw (0, productionBom_1.bomError)('STATUS_INVALID', 'Abgebucht wird eine abgeschlossene BOM («BOM tamamla»).', { status: 409 });
        }
        const deviceBoms = bom.kind === 'MAIN' ? await this.boms.listForDevice(tenantId, bom.productionItemId) : [];
        await this.assertNoOpenRevision(tenantId, [bom, ...this.subsOf(bom, deviceBoms)]);
        // Die Haupt-BOM bucht alles ab: zuerst ihre (abgeschlossenen) Alt-BOMs, die noch stehen.
        if (bom.kind === 'MAIN') {
            const subs = this.subsOf(bom, deviceBoms);
            for (const sub of subs) {
                if (!sub.consumedAt && sub.status === 'COMPLETED')
                    await this.consumeOne(tenantId, actor, sub);
            }
        }
        const consumed = await this.consumeOne(tenantId, actor, bom);
        if (!consumed)
            throw (0, productionBom_1.bomError)('ALREADY_CONSUMED', 'Diese BOM ist schon abgebucht.', { status: 409 });
        return { bom: await this.get(tenantId, bomId) };
    }
    /** Eine BOM vom Bestand abbuchen (ihre Reservierungen, ihre Seriennummern). */
    async consumeOne(tenantId, actor, bom) {
        const facts = await this.reservations.facts(tenantId, bom.lines.map((line) => line.productId));
        const serialIdByNumber = new Map(facts.serials.map((serial) => [`${serial.productId}\u0001${serial.serialNumber}`, serial.id]));
        const plan = {
            lines: bom.lines.map((line) => {
                const entry = facts.coverage.lines.get(line.id);
                const product = facts.products.get(line.productId);
                const serialNumbers = product?.serialRequired ? entry?.serials ?? [] : [];
                return {
                    lineId: line.id,
                    productId: line.productId,
                    quantity: product?.serialRequired ? 0 : (0, productionBom_1.round3)(entry?.reserved ?? 0),
                    serialIds: serialNumbers.flatMap((number) => {
                        const id = serialIdByNumber.get(`${line.productId}\u0001${number}`);
                        return id ? [id] : [];
                    }),
                    serialNumbers,
                };
            }),
        };
        return this.boms.consume(tenantId, bom.id, plan, actor.id);
    }
    /* ── «Sipariş oluştur» ─────────────────────────────────────────────── */
    async proposal(tenantId, actor, bomId) {
        const bom = await this.requireBom(tenantId, bomId);
        this.assertCanProcure(actor);
        const { facts: _facts, openLines: _openLines, ...proposal } = await this.buildProposal(tenantId, bom);
        return proposal;
    }
    async buildProposal(tenantId, bom) {
        if (bom.status !== 'APPROVED') {
            throw (0, productionBom_1.bomError)('STATUS_INVALID', 'Bestellt wird aus einer freigegebenen BOM.', { status: 409 });
        }
        const [facts, purchases, nextNumber] = await Promise.all([
            this.reservations.facts(tenantId, bom.lines.map((line) => line.productId)),
            this.purchasesOf(tenantId, [bom.id]),
            this.nextOrderNumber(tenantId).catch(() => null),
        ]);
        // «Bir ürün için sadece bir listeyi seçebilirsin»: eine Zeile mit einer
        // noch offenen Bestellung kommt nicht in eine zweite.
        const openLines = new Set();
        for (const { link, order } of purchases) {
            if (link.kind !== 'ORDER' || productionBom_1.PRICE_REQUEST_STATUSES.has(order.status) || order.status === 'COMPLETED')
                continue;
            for (const item of order.items) {
                const lineId = typeof item.bomLineId === 'string' ? item.bomLineId : null;
                const quantity = Number(item.quantity) || 0;
                const received = Number(item.receivedQuantity) || 0;
                if (lineId && received + EPS < quantity)
                    openLines.add(lineId);
            }
        }
        const proposal = (0, productionBom_1.orderProposal)(bom.lines, facts.coverage.lines, facts.products, openLines);
        const byLine = new Map(bom.lines.map((line) => [line.id, line]));
        const supplierOrders = purchases
            .filter(({ link, order }) => link.kind === 'ORDER' && !productionBom_1.PRICE_REQUEST_STATUSES.has(order.status) && order.status !== 'COMPLETED')
            .map(({ order }) => ({
            purchaseOrderId: order.id,
            referenceNumber: order.referenceNumber,
            supplierId: order.supplierId,
            supplierName: order.supplierName,
            status: order.status,
            lineCount: order.items.length,
            acceptsLines: (0, productionBom_1.acceptsMoreLines)(order),
        }));
        return {
            bomId: bom.id,
            bomNumber: bom.bomNumber,
            nextOrderNumber: nextNumber,
            supplierOrders,
            facts,
            openLines,
            lines: proposal.map((entry) => {
                const line = byLine.get(entry.lineId);
                const product = facts.products.get(line.productId) ?? null;
                const coverage = facts.coverage.lines.get(line.id);
                return {
                    lineId: line.id,
                    erpCode: product?.erpCode ?? line.erpCode,
                    name: product?.name ?? line.name,
                    brand: product?.brand ?? line.brand,
                    modelNumber: product?.modelNumber ?? line.modelNumber,
                    unit: line.unit,
                    need: coverage?.open ?? line.quantity,
                    reserved: coverage?.reserved ?? 0,
                    incoming: coverage?.incoming ?? 0,
                    missing: entry.missing,
                    minimum: entry.minimum,
                    floor: entry.floor,
                    block: entry.block,
                    serialRequired: Boolean(product?.serialRequired),
                    suppliers: product ? product.suppliers.map((supplier) => ({ id: supplier.supplierId, name: supplier.name })) : [],
                    product: product ? (0, bomReadModel_1.productDto)(product, facts.coverage.free.get(product.productId)) : null,
                };
            }),
        };
    }
    /**
     * Legt die Bestellungen an — EINE je Lieferant («tedarikçilerine göre
     * ürünlerin kategorize olmuş ve farklı sipariş numaraları»), jede mit
     * Projekt, Gerät und unserer Nummer. Die Mengen prüft der Server gegen
     * einen FRISCHEN Vorschlag: nie unter der Untergrenze, mehr nur mit
     * Erklärung. Ein neu gewählter Lieferant kommt auch an die Depo-Karte.
     *
     * «Aynı tedarikçiye ait ise o tek sipariş altında birleştirilir, zaten olan
     * siparişe eklenir (aynı BOM altında)» (Samet, 27.09.2026): hat der
     * Lieferant in dieser BOM schon eine Bestellung im Entwurf, die nie beim
     * Lieferanten war, kommen die Zeilen DORT hinein (`merged`) — die älteste
     * zuerst. Nur für eine Bestellung beim Lieferanten entsteht eine neue.
     */
    async createOrders(tenantId, actor, bomId, body) {
        return withOrderLock(`${tenantId}:${bomId}`, async () => {
            const bom = await this.requireBom(tenantId, bomId);
            this.assertCanProcure(actor);
            const procurementRequestId = procurementRequestIdOf(body);
            if (procurementRequestId)
                await this.procurementOrFail().assertUsable(tenantId, procurementRequestId, bom.id, 'ORDER');
            const proposal = await this.buildProposal(tenantId, bom);
            const lines = (0, productionBom_1.orderLinesFrom)(body?.lines, proposal.lines.map((line) => ({
                lineId: line.lineId,
                missing: line.missing,
                minimum: line.minimum,
                floor: line.floor,
                block: line.block,
            })));
            const projectLabel = await this.projectLabelOf(tenantId, bom);
            // Je Lieferant EINE Gruppe — derselbe Lieferant mit und ohne Kennung ist einer.
            const groups = [];
            for (const line of lines) {
                const group = groups.find((entry) => (0, productionBom_1.sameSupplier)(entry.supplier, line));
                if (!group) {
                    groups.push({ supplier: { supplierId: line.supplierId, supplierName: line.supplierName }, lines: [line] });
                    continue;
                }
                group.lines.push(line);
                if (!group.supplier.supplierId && line.supplierId)
                    group.supplier = { supplierId: line.supplierId, supplierName: line.supplierName };
            }
            const byLine = new Map(bom.lines.map((line) => [line.id, line]));
            const proposed = new Map(proposal.lines.map((line) => [line.lineId, line]));
            // Die Entwürfe, die noch Zeilen aufnehmen — älteste zuerst.
            const drafts = proposal.supplierOrders.filter((order) => order.acceptsLines);
            const created = [];
            const failed = [];
            for (const group of groups) {
                const draftLines = group.lines.map((entry) => {
                    const line = byLine.get(entry.lineId);
                    const facts = proposed.get(entry.lineId);
                    return {
                        bomLineId: line.id,
                        erpCode: facts?.erpCode ?? line.erpCode,
                        name: facts?.name ?? line.name,
                        brand: facts?.brand ?? line.brand,
                        modelNumber: facts?.modelNumber ?? line.modelNumber,
                        unit: line.unit,
                        quantity: entry.quantity,
                    };
                });
                const records = group.lines.map((entry) => {
                    const facts = proposed.get(entry.lineId);
                    return {
                        bomLineId: entry.lineId,
                        missing: facts?.missing ?? 0,
                        minimum: facts?.minimum ?? null,
                        ordered: entry.quantity,
                        note: entry.note,
                    };
                });
                try {
                    const target = drafts.find((order) => (0, productionBom_1.sameSupplier)(order, group.supplier));
                    // Der Entwurf kann inzwischen hinausgegangen sein — dann eben eine neue Bestellung.
                    const appended = target
                        ? await this.writer.appendToOrder({
                            tenantId,
                            userId: actor.id,
                            purchaseOrderId: target.purchaseOrderId,
                            bomId: bom.id,
                            bomRevision: bom.revision,
                            productionItemId: bom.productionItemId,
                            lines: draftLines,
                            records,
                        })
                        : null;
                    let order = appended;
                    if (!order) {
                        order = await this.writer.createOrder({
                            tenantId,
                            userId: actor.id,
                            supplier: group.supplier,
                            projectLabel,
                            productionProjectId: bom.productionProjectId,
                            productionItemId: bom.productionItemId,
                            lines: draftLines,
                        });
                        await this.purchases.createLink(tenantId, {
                            purchaseOrderId: order.id,
                            bomId: bom.id,
                            productionProjectId: bom.productionProjectId,
                            productionItemId: bom.productionItemId,
                            kind: 'ORDER',
                            sourcePurchaseOrderId: null,
                            lines: records,
                            bomRevision: bom.revision,
                        }, actor.id);
                    }
                    // «Yeni tedarikçiyi küçük bir pop ile ekleyebilir» — er bleibt an der Karte.
                    for (const entry of group.lines) {
                        const line = byLine.get(entry.lineId);
                        if (line) {
                            await this.stock.addSupplierToProduct(tenantId, line.productId, {
                                supplierId: entry.supplierId,
                                name: entry.supplierName,
                            }).catch(() => undefined);
                        }
                    }
                    const done = order;
                    const earlier = created.find((entry) => entry.purchaseOrderId === done.id);
                    if (earlier)
                        earlier.lineCount += group.lines.length;
                    else
                        created.push({ purchaseOrderId: done.id, referenceNumber: done.referenceNumber, supplierName: done.supplierName, lineCount: group.lines.length, merged: Boolean(appended) });
                }
                catch (error) {
                    failed.push({ supplierName: group.supplier.supplierName, error: error?.message || 'Error' });
                }
            }
            if (procurementRequestId && created.length) {
                await this.procurementOrFail().attachDocuments(tenantId, procurementRequestId, bom.id, created.map((entry) => entry.purchaseOrderId), actor);
            }
            return { created, failed, bom: await this.get(tenantId, bomId) };
        });
    }
    /* ── «Fiyat talebi» ────────────────────────────────────────────────── */
    /**
     * «Fiyat talebi alacağımız zaman bom onaylanmamış olması gerekir, bom
     * onaylandıktan sonra fiyat talebi alınamaz» (Samet, 27.09.2026): gefragt
     * wird nur aus dem ENTWURF — danach wird bestellt.
     */
    assertRequestable(bom, working, fromRequest = false) {
        // Auch während einer Revision (27.09.2026): neue Karten brauchen einen Preis, bevor sie freigegeben werden.
        // Ein Talep «Fiyat talebi» der BOM (Satın alma) bleibt bearbeitbar, auch wenn die BOM inzwischen freigegeben ist.
        if ((!working.draft && !fromRequest) || bom.consumedAt) {
            throw (0, productionBom_1.bomError)('REQUEST_DRAFT_ONLY', 'Preisanfragen gibt es nur im Entwurf — oder in einer Revision im Entwurf.', { status: 409 });
        }
        if (!working.lines.length)
            throw (0, productionBom_1.bomError)('REQUEST_EMPTY', 'Die BOM hat keine Zeilen.');
    }
    /** Was die Anfrage vorschlägt: jede gespeicherte Zeile mit ihrer Menge und den Lieferanten ihrer Karte. */
    async requestProposal(tenantId, actor, bomId, procurementRequestId = null) {
        const bom = await this.requireBom(tenantId, bomId);
        this.assertCanProcure(actor);
        const procurementRequest = procurementRequestId
            ? await this.procurementOrFail().assertUsable(tenantId, procurementRequestId, bom.id, 'PRICE') : null;
        const working = await this.workingLinesOf(tenantId, bom);
        this.assertRequestable(bom, working, Boolean(procurementRequestId));
        const requested = procurementRequest ? new Map(procurementRequest.lines.map((line) => [line.bomLineId, line.quantity])) : null;
        const proposalLines = working.lines.filter((line) => !requested || requested.has(line.id));
        const [products, purchases, nextNumber] = await Promise.all([
            this.stock.products(tenantId, proposalLines.map((line) => line.productId)),
            this.purchasesOf(tenantId, [bom.id]),
            this.nextRequestNumber(tenantId).catch(() => null),
        ]);
        const requestsByLine = new Map();
        for (const { link, order } of purchases) {
            if (link.kind !== 'REQUEST')
                continue;
            // Earlier partial requests must not disable this request's suppliers.
            if (procurementRequest && !procurementRequest.purchaseOrderIds.includes(order.id))
                continue;
            for (const item of order.items) {
                const lineId = typeof item.bomLineId === 'string' ? item.bomLineId : null;
                if (!lineId)
                    continue;
                requestsByLine.set(lineId, [...(requestsByLine.get(lineId) ?? []), {
                        purchaseOrderId: order.id,
                        referenceNumber: order.referenceNumber,
                        supplierName: order.supplierName,
                        quantity: (0, productionBom_1.round3)(Number(item.quantity) || 0),
                    }]);
            }
        }
        return {
            bomId: bom.id,
            bomNumber: bom.bomNumber,
            nextRequestNumber: nextNumber,
            lines: proposalLines.map((line) => {
                const product = products.get(line.productId) ?? null;
                return {
                    lineId: line.id,
                    erpCode: product?.erpCode ?? line.erpCode,
                    name: product?.name ?? line.name,
                    brand: product?.brand ?? line.brand,
                    modelNumber: product?.modelNumber ?? line.modelNumber,
                    unit: line.unit,
                    quantity: requested?.get(line.id) ?? line.quantity,
                    serialRequired: Boolean(product?.serialRequired),
                    missingProduct: !product,
                    suppliers: product ? product.suppliers.map((supplier) => ({ id: supplier.supplierId, name: supplier.name })) : [],
                    requests: requestsByLine.get(line.id) ?? [],
                };
            }),
        };
    }
    /**
     * Legt die Preisanfragen an — EINE je Lieferant («fiyat talepleri ayrı ayrı
     * tedarikçiler üzerinden açılsın»); eine Zeile mit drei Lieferanten steht
     * in drei Anfragen. Jede trägt Projekt, Gerät und die BOM-Zeile, sonst nur
     * Name, Modell und Menge. Die Lieferanten kommen NICHT an die Depo-Karte:
     * gefragt ist noch nicht bestellt.
     */
    async createRequests(tenantId, actor, bomId, body) {
        const bom = await this.requireBom(tenantId, bomId);
        this.assertCanProcure(actor);
        const procurementRequestId = procurementRequestIdOf(body);
        const procurementRequest = procurementRequestId
            ? await this.procurementOrFail().assertUsable(tenantId, procurementRequestId, bom.id, 'PRICE') : null;
        const working = await this.workingLinesOf(tenantId, bom);
        this.assertRequestable(bom, working, Boolean(procurementRequestId));
        const requested = procurementRequest ? new Set(procurementRequest.lines.map((line) => line.bomLineId)) : null;
        const lines = (0, productionBom_1.requestLinesFrom)(body?.lines, new Set(working.lines.filter((line) => !requested || requested.has(line.id)).map((line) => line.id)));
        const byLine = new Map(working.lines.map((line) => [line.id, line]));
        const [products, projectLabel] = await Promise.all([
            this.stock.products(tenantId, lines.map((entry) => byLine.get(entry.lineId).productId)),
            this.projectLabelOf(tenantId, bom),
        ]);
        // Je Lieferant eine Anfrage, die Zeilen in der Reihenfolge der BOM.
        const position = new Map(working.lines.map((line, index) => [line.id, index]));
        const groups = new Map();
        for (const entry of [...lines].sort((a, b) => (position.get(a.lineId) ?? 0) - (position.get(b.lineId) ?? 0))) {
            for (const supplier of entry.suppliers) {
                const key = (0, productionBom_1.supplierKey)(supplier.supplierId, supplier.supplierName);
                const group = groups.get(key) ?? { supplier, lines: [] };
                group.lines.push({ lineId: entry.lineId, quantity: entry.quantity });
                groups.set(key, group);
            }
        }
        const created = [];
        const failed = [];
        for (const group of groups.values()) {
            try {
                const request = await this.writer.createRequest({
                    tenantId,
                    userId: actor.id,
                    supplier: group.supplier,
                    projectLabel,
                    productionProjectId: bom.productionProjectId,
                    productionItemId: bom.productionItemId,
                    lines: group.lines.map((entry) => {
                        const line = byLine.get(entry.lineId);
                        const product = products.get(line.productId);
                        return {
                            bomLineId: line.id,
                            erpCode: product?.erpCode ?? line.erpCode,
                            name: product?.name ?? line.name,
                            modelNumber: product?.modelNumber ?? line.modelNumber,
                            unit: line.unit,
                            quantity: entry.quantity,
                        };
                    }),
                });
                await this.purchases.createLink(tenantId, {
                    purchaseOrderId: request.id,
                    bomId: bom.id,
                    productionProjectId: bom.productionProjectId,
                    productionItemId: bom.productionItemId,
                    kind: 'REQUEST',
                    sourcePurchaseOrderId: null,
                    bomRevision: working.revision,
                    lines: group.lines.map((entry) => {
                        const product = products.get(byLine.get(entry.lineId).productId);
                        return {
                            bomLineId: entry.lineId,
                            // Im Entwurf ist nichts reserviert — «fehlend» gibt es noch nicht.
                            missing: 0,
                            minimum: product?.minimumOrderQuantity ?? null,
                            ordered: entry.quantity,
                            note: null,
                        };
                    }),
                }, actor.id);
                created.push({ purchaseOrderId: request.id, referenceNumber: request.referenceNumber, supplierName: request.supplierName, lineCount: group.lines.length });
            }
            catch (error) {
                failed.push({ supplierName: group.supplier.supplierName, error: error?.message || 'Error' });
            }
        }
        if (procurementRequestId && created.length) {
            await this.procurementOrFail().attachDocuments(tenantId, procurementRequestId, bom.id, created.map((entry) => entry.purchaseOrderId), actor);
        }
        return { created, failed, bom: await this.get(tenantId, bomId) };
    }
    /* ── Hilfen ────────────────────────────────────────────────────────── */
    /** «Projekt · Name — Gerät (BOM-Nummer)» — so steht der Beleg beim Projekt. */
    async projectLabelOf(tenantId, bom) {
        const [project, device] = await Promise.all([
            this.directory.project(tenantId, bom.productionProjectId),
            this.directory.device(tenantId, bom.productionItemId),
        ]);
        return [
            project ? [project.projectNumber, project.projectName].filter(Boolean).join(' · ') : null,
            device?.name ?? null,
        ].filter(Boolean).join(' — ') + ` (${bom.bomNumber})`;
    }
    /** Preisanfragen und Bestellungen macht der Einkauf (Buchhaltung, Administratorrolle — Seite «Satın alma»). */
    assertCanProcure(actor) {
        if (actor.isAdmin || actor.canProcure)
            return;
        throw (0, productionBom_1.bomError)('FORBIDDEN', 'Preisanfragen und Bestellungen macht die Buchhaltung.', { status: 403 });
    }
    /** Der Einkauf (Talepler, Gelen mallar) — nach dem Bau angeschlossen, er liest selbst BOMs. */
    procurement = null;
    attachProcurement(procurement) {
        this.procurement = procurement;
    }
    procurementOrFail() {
        if (!this.procurement)
            throw (0, productionBom_1.bomError)('NOT_AVAILABLE', 'Der Einkauf ist nicht angeschlossen.', { status: 503 });
        return this.procurement;
    }
    async bomsByIds(tenantId, ids) {
        return this.boms.getMany(tenantId, ids);
    }
    canEdit(actor, assignees) {
        return actor.isAdmin || actor.canManage || assignees.includes(actor.id);
    }
    async assertCanEdit(tenantId, actor, itemId, area) {
        if (actor.isAdmin || actor.canManage)
            return;
        const assignees = await this.directory.bomStageAssignees(tenantId, itemId, area);
        if (!assignees.includes(actor.id)) {
            throw (0, productionBom_1.bomError)('FORBIDDEN', 'Die BOM bearbeitet, wer die Aufgabe der Stufe BOM hat.', { status: 403 });
        }
    }
    /** Solange eine Revision im Entwurf steht, wird weder abgeschlossen noch abgebucht. */
    async assertNoOpenRevision(tenantId, boms) {
        const drafts = (await this.revisions.listForBoms(tenantId, boms.map((entry) => entry.id)))
            .filter((entry) => entry.status === 'DRAFT');
        const first = drafts[0];
        if (first) {
            const number = boms.find((entry) => entry.id === first.bomId)?.bomNumber ?? '';
            throw (0, productionBom_1.bomError)('REVISION_OPEN', 'Erst die Revision im Entwurf freigeben oder verwerfen.', {
                status: 409,
                params: { number, revision: first.revision },
            });
        }
    }
    /** Bestellungen sperren; mit `requests` (Löschen der BOM) auch ihre Preisanfragen. */
    async assertNoOrders(tenantId, bom, options = {}) {
        const purchases = await this.purchasesOf(tenantId, [bom.id]);
        const orders = purchases.filter(({ link }) => link.kind === 'ORDER');
        if (orders.length) {
            throw (0, productionBom_1.bomError)('HAS_ORDERS', 'Die BOM hat Bestellungen — erst diese löschen.', {
                status: 409,
                params: { count: orders.length },
                details: orders.map(({ order }) => order.referenceNumber),
            });
        }
        const requests = options.requests ? purchases.filter(({ link }) => link.kind === 'REQUEST') : [];
        if (requests.length) {
            throw (0, productionBom_1.bomError)('HAS_REQUESTS', 'Die BOM hat Preisanfragen — erst diese löschen.', {
                status: 409,
                params: { count: requests.length },
                details: requests.map(({ order }) => order.referenceNumber),
            });
        }
    }
    async requireDevice(tenantId, itemId) {
        const device = await this.directory.device(tenantId, itemId);
        if (!device)
            throw (0, productionBom_1.bomError)('DEVICE_NOT_FOUND', 'Gerät nicht gefunden.', { status: 404 });
        return device;
    }
    async requireBom(tenantId, bomId) {
        const bom = await this.boms.get(tenantId, bomId);
        if (!bom)
            throw (0, productionBom_1.bomError)('BOM_NOT_FOUND', 'BOM nicht gefunden.', { status: 404 });
        return bom;
    }
    /** Für die Wege, die nur das Projekt brauchen. */
    async projectOf(tenantId, bom) {
        return this.directory.project(tenantId, bom.productionProjectId);
    }
    /** Stand «BOM tamamla» einer BOM (für den Wächter der Bestellungen). */
    async completionFor(tenantId, bom) {
        const [facts, purchases, deviceBoms] = await Promise.all([
            this.reservations.facts(tenantId, bom.lines.map((line) => line.productId)),
            this.purchasesOf(tenantId, [bom.id]),
            bom.kind === 'MAIN' ? this.boms.listForDevice(tenantId, bom.productionItemId) : Promise.resolve([]),
        ]);
        const subs = bom.kind === 'MAIN'
            ? this.subsOf(bom, deviceBoms).map((sub) => ({ completed: sub.status === 'COMPLETED' || Boolean(sub.consumedAt) }))
            : [];
        return (0, productionBom_1.completionOf)(bom, facts.coverage.lines, purchases.map(({ link, order }) => ({
            kind: link.kind,
            confirmed: ['PENDING', 'TO_BE_STOCKED', 'COMPLETED'].includes(order.status),
        })), subs);
    }
}
exports.DeviceBomsUseCase = DeviceBomsUseCase;
//# sourceMappingURL=DeviceBomsUseCase.js.map