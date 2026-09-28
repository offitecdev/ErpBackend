"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WarehouseController = void 0;
const warehouseModule_1 = require("../composition/warehouseModule");
const warehouse_1 = require("../../domain/services/warehouse");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
/**
 * ── DIE WEGE DES DEPOS (26.09.2026) ─────────────────────────────────────────
 * Dünn: Anfrage lesen, Anwendungsfall rufen, Antwort schreiben. Fachliche
 * Fehler tragen eine Kennung (`warehouse.err.*` in der Oberfläche); alles
 * andere landet als 500 im globalen Fehlerbehandler.
 */
const roles = new RoleRepository_1.RoleRepository();
const fail = (res, next, error) => {
    if ((0, warehouse_1.isWarehouseError)(error)) {
        res.status(error.status).json((0, warehouse_1.warehouseErrorBody)(error));
        return;
    }
    next(error);
};
const tenantOf = (req) => req.user.tenantId;
const userOf = (req) => req.user.id;
const idParam = (req, name = 'id') => String(req.params[name] ?? '');
/** Wer handelt: Kennung, Name (aus dem Anmeldetoken, sonst aus Personal) und Administratorrolle. */
const actorOf = async (req) => {
    const user = req.user;
    const fromToken = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
    const [name, role] = await Promise.all([
        fromToken ? Promise.resolve(fromToken) : warehouseModule_1.warehouseModule.directory.personName(user.id),
        roles.getEmployeeRoleInfo(user.id),
    ]);
    return { id: user.id, name: name || null, isSystemAdmin: role.isSystemAdmin };
};
/** Suche, Gruppen und Barcode der Liste — gleich für Liste und Export. */
const filterOf = (req) => {
    const sort = (0, warehouse_1.sortKeyFrom)(req.query.sort);
    const barcode = (0, warehouse_1.cleanCode)(typeof req.query.barcode === 'string' ? req.query.barcode : undefined, 'barcode', warehouse_1.WAREHOUSE_LIMITS.barcode);
    const search = (0, warehouse_1.searchFrom)(req.query.search);
    const groupIds = (0, warehouse_1.groupIdsFrom)(req.query.groups);
    return {
        ...(search ? { search } : {}),
        ...(groupIds ? { groupIds } : {}),
        ...(barcode ? { barcode } : {}),
        sort,
        direction: (0, warehouse_1.directionFrom)(req.query.dir, sort),
    };
};
class WarehouseController {
    /**
     * Nur in einer Produktionsfirma, deren Kategorie die Produktion führt —
     * dieselbe Frage stellt das Menü (MainLayout) für die Sichtbarkeit.
     */
    static requireWarehouse = async (req, res, next) => {
        try {
            const state = await (0, warehouseModule_1.warehouseAvailability)(tenantOf(req));
            if (state.available)
                return next();
            if (state.companyType !== 'PRODUCTION') {
                res.status(403).json({
                    error: 'Das Depo gibt es nur in Produktionsfirmen.',
                    code: 'NOT_PRODUCTION_COMPANY',
                });
                return;
            }
            res.status(403).json({
                error: 'Das Produktionsmodul ist für diese Firma nicht eingeschaltet.',
                code: 'MODULE_DISABLED',
            });
        }
        catch (error) {
            next(error);
        }
    };
    async status(req, res, next) {
        try {
            res.json(await (0, warehouseModule_1.warehouseAvailability)(tenantOf(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    /* ── Produktkarten ──────────────────────────────────────────────────── */
    async list(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.products.list(tenantOf(req), {
                ...filterOf(req),
                page: (0, warehouse_1.pageFrom)(req.query.page),
                pageSize: (0, warehouse_1.pageSizeFrom)(req.query.pageSize),
            }));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async export(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.products.export(tenantOf(req), filterOf(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async get(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.products.get(tenantOf(req), idParam(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async create(req, res, next) {
        try {
            res.status(201).json(await warehouseModule_1.warehouseModule.products.create(tenantOf(req), userOf(req), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async update(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.products.update(tenantOf(req), userOf(req), idParam(req), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async remove(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.products.delete(tenantOf(req), idParam(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async receive(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.products.receive(tenantOf(req), userOf(req), idParam(req), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async lookup(req, res, next) {
        try {
            // Ein Scan muss den Stand von JETZT sehen — nichts zwischenspeichern.
            res.set('Cache-Control', 'no-store');
            res.json(await warehouseModule_1.warehouseModule.products.lookup(tenantOf(req), req.query.code));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    /* ── Seriennummern ──────────────────────────────────────────────────── */
    async addSerial(req, res, next) {
        try {
            res.status(201).json(await warehouseModule_1.warehouseModule.serials.add(tenantOf(req), userOf(req), idParam(req), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async updateSerial(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.serials.update(tenantOf(req), idParam(req), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async removeSerial(req, res, next) {
        try {
            // `?receipt=` — «Geri al» einer Nummer, die eben als Wareneingang kam (28.09.2026).
            res.json(await warehouseModule_1.warehouseModule.serials.delete(tenantOf(req), userOf(req), idParam(req), req.query.receipt));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    /* ── Hauptkategorien und Materialgruppen ────────────────────────────── */
    async groups(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.catalog.tree(tenantOf(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async createCategory(req, res, next) {
        try {
            res.status(201).json(await warehouseModule_1.warehouseModule.catalog.createCategory(tenantOf(req), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async updateCategory(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.catalog.updateCategory(tenantOf(req), idParam(req), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async removeCategory(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.catalog.deleteCategory(tenantOf(req), idParam(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async createGroup(req, res, next) {
        try {
            res.status(201).json(await warehouseModule_1.warehouseModule.catalog.createGroup(tenantOf(req), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async updateGroup(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.catalog.updateGroup(tenantOf(req), idParam(req), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async removeGroup(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.catalog.deleteGroup(tenantOf(req), idParam(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async assignCodes(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.catalog.assignCodes(tenantOf(req), idParam(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    /* ── Etikett ────────────────────────────────────────────────────────── */
    async settings(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.catalog.settings(tenantOf(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async saveSettings(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.catalog.saveSettings(tenantOf(req), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    /* ── Excel-Aktarım ──────────────────────────────────────────────────── */
    async imports(req, res, next) {
        try {
            res.set('Cache-Control', 'no-store');
            res.json(await warehouseModule_1.warehouseModule.imports.list(tenantOf(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async previewImport(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.imports.preview(tenantOf(req), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async requestImport(req, res, next) {
        try {
            res.status(201).json(await warehouseModule_1.warehouseModule.imports.request(tenantOf(req), await actorOf(req), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async getImport(req, res, next) {
        try {
            res.set('Cache-Control', 'no-store');
            res.json(await warehouseModule_1.warehouseModule.imports.get(tenantOf(req), idParam(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async approveImport(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.imports.approve(tenantOf(req), await actorOf(req), idParam(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async rejectImport(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.imports.reject(tenantOf(req), await actorOf(req), idParam(req), req.body));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async cancelImport(req, res, next) {
        try {
            res.json(await warehouseModule_1.warehouseModule.imports.cancel(tenantOf(req), await actorOf(req), idParam(req)));
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    /* ── Auswahlen ──────────────────────────────────────────────────────── */
    async suppliers(req, res, next) {
        try {
            res.json({ items: await warehouseModule_1.warehouseModule.catalog.suppliers(tenantOf(req), req.query.q) });
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async projects(req, res, next) {
        try {
            res.json({ items: await warehouseModule_1.warehouseModule.catalog.projects(tenantOf(req), req.query.search) });
        }
        catch (error) {
            fail(res, next, error);
        }
    }
    async devices(req, res, next) {
        try {
            res.json({ items: await warehouseModule_1.warehouseModule.catalog.devices(tenantOf(req), idParam(req)) });
        }
        catch (error) {
            fail(res, next, error);
        }
    }
}
exports.WarehouseController = WarehouseController;
//# sourceMappingURL=WarehouseController.js.map