import type { NextFunction, Request, Response } from 'express';

import { warehouseAvailability, warehouseModule } from '../composition/warehouseModule';
import {
    directionFrom,
    groupIdsFrom,
    isWarehouseError,
    pageFrom,
    pageSizeFrom,
    searchFrom,
    sortKeyFrom,
    warehouseErrorBody,
    cleanCode,
    WAREHOUSE_LIMITS,
} from '../../domain/services/warehouse';
import type { WarehouseActor } from '../../application/use-cases/warehouse/WarehouseImportsUseCase';
import { RoleRepository } from '../../infrastructure/repositories/RoleRepository';

/**
 * ── DIE WEGE DES DEPOS (26.09.2026) ─────────────────────────────────────────
 * Dünn: Anfrage lesen, Anwendungsfall rufen, Antwort schreiben. Fachliche
 * Fehler tragen eine Kennung (`warehouse.err.*` in der Oberfläche); alles
 * andere landet als 500 im globalen Fehlerbehandler.
 */

const roles = new RoleRepository();

const fail = (res: Response, next: NextFunction, error: unknown) => {
    if (isWarehouseError(error)) {
        res.status(error.status).json(warehouseErrorBody(error));
        return;
    }
    next(error);
};

const tenantOf = (req: Request) => req.user!.tenantId;
const userOf = (req: Request) => req.user!.id;
const idParam = (req: Request, name = 'id') => String(req.params[name] ?? '');

/** Wer handelt: Kennung, Name (aus dem Anmeldetoken, sonst aus Personal) und Administratorrolle. */
const actorOf = async (req: Request): Promise<WarehouseActor> => {
    const user = req.user!;
    const fromToken = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
    const [name, role] = await Promise.all([
        fromToken ? Promise.resolve(fromToken) : warehouseModule.directory.personName(user.id),
        roles.getEmployeeRoleInfo(user.id),
    ]);
    return { id: user.id, name: name || null, isSystemAdmin: role.isSystemAdmin };
};

/** Suche, Gruppen und Barcode der Liste — gleich für Liste und Export. */
const filterOf = (req: Request) => {
    const sort = sortKeyFrom(req.query.sort);
    const barcode = cleanCode(
        typeof req.query.barcode === 'string' ? req.query.barcode : undefined,
        'barcode',
        WAREHOUSE_LIMITS.barcode,
    );
    const search = searchFrom(req.query.search);
    const groupIds = groupIdsFrom(req.query.groups);
    return {
        ...(search ? { search } : {}),
        ...(groupIds ? { groupIds } : {}),
        ...(barcode ? { barcode } : {}),
        sort,
        direction: directionFrom(req.query.dir, sort),
    };
};

export class WarehouseController {
    /**
     * Nur in einer Produktionsfirma, deren Kategorie die Produktion führt —
     * dieselbe Frage stellt das Menü (MainLayout) für die Sichtbarkeit.
     */
    static requireWarehouse = async (req: Request, res: Response, next: NextFunction) => {
        try {
            const state = await warehouseAvailability(tenantOf(req));
            if (state.available) return next();
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
        } catch (error) {
            next(error);
        }
    };

    async status(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseAvailability(tenantOf(req)));
        } catch (error) { fail(res, next, error); }
    }

    /* ── Produktkarten ──────────────────────────────────────────────────── */

    async list(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.products.list(tenantOf(req), {
                ...filterOf(req),
                page: pageFrom(req.query.page),
                pageSize: pageSizeFrom(req.query.pageSize),
            }));
        } catch (error) { fail(res, next, error); }
    }

    async export(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.products.export(tenantOf(req), filterOf(req)));
        } catch (error) { fail(res, next, error); }
    }

    async get(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.products.get(tenantOf(req), idParam(req)));
        } catch (error) { fail(res, next, error); }
    }

    async create(req: Request, res: Response, next: NextFunction) {
        try {
            res.status(201).json(await warehouseModule.products.create(tenantOf(req), userOf(req), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async update(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.products.update(tenantOf(req), userOf(req), idParam(req), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async remove(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.products.delete(tenantOf(req), idParam(req)));
        } catch (error) { fail(res, next, error); }
    }

    async receive(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.products.receive(tenantOf(req), userOf(req), idParam(req), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async lookup(req: Request, res: Response, next: NextFunction) {
        try {
            // Ein Scan muss den Stand von JETZT sehen — nichts zwischenspeichern.
            res.set('Cache-Control', 'no-store');
            res.json(await warehouseModule.products.lookup(tenantOf(req), req.query.code));
        } catch (error) { fail(res, next, error); }
    }

    /* ── Seriennummern ──────────────────────────────────────────────────── */

    async addSerial(req: Request, res: Response, next: NextFunction) {
        try {
            res.status(201).json(await warehouseModule.serials.add(tenantOf(req), userOf(req), idParam(req), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async updateSerial(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.serials.update(tenantOf(req), idParam(req), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async removeSerial(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.serials.delete(tenantOf(req), idParam(req)));
        } catch (error) { fail(res, next, error); }
    }

    /* ── Hauptkategorien und Materialgruppen ────────────────────────────── */

    async groups(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.catalog.tree(tenantOf(req)));
        } catch (error) { fail(res, next, error); }
    }

    async createCategory(req: Request, res: Response, next: NextFunction) {
        try {
            res.status(201).json(await warehouseModule.catalog.createCategory(tenantOf(req), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async updateCategory(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.catalog.updateCategory(tenantOf(req), idParam(req), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async removeCategory(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.catalog.deleteCategory(tenantOf(req), idParam(req)));
        } catch (error) { fail(res, next, error); }
    }

    async createGroup(req: Request, res: Response, next: NextFunction) {
        try {
            res.status(201).json(await warehouseModule.catalog.createGroup(tenantOf(req), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async updateGroup(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.catalog.updateGroup(tenantOf(req), idParam(req), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async removeGroup(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.catalog.deleteGroup(tenantOf(req), idParam(req)));
        } catch (error) { fail(res, next, error); }
    }

    async assignCodes(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.catalog.assignCodes(tenantOf(req), idParam(req)));
        } catch (error) { fail(res, next, error); }
    }

    /* ── Etikett ────────────────────────────────────────────────────────── */

    async settings(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.catalog.settings(tenantOf(req)));
        } catch (error) { fail(res, next, error); }
    }

    async saveSettings(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.catalog.saveSettings(tenantOf(req), req.body));
        } catch (error) { fail(res, next, error); }
    }

    /* ── Excel-Aktarım ──────────────────────────────────────────────────── */

    async imports(req: Request, res: Response, next: NextFunction) {
        try {
            res.set('Cache-Control', 'no-store');
            res.json(await warehouseModule.imports.list(tenantOf(req)));
        } catch (error) { fail(res, next, error); }
    }

    async previewImport(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.imports.preview(tenantOf(req), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async requestImport(req: Request, res: Response, next: NextFunction) {
        try {
            res.status(201).json(await warehouseModule.imports.request(tenantOf(req), await actorOf(req), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async getImport(req: Request, res: Response, next: NextFunction) {
        try {
            res.set('Cache-Control', 'no-store');
            res.json(await warehouseModule.imports.get(tenantOf(req), idParam(req)));
        } catch (error) { fail(res, next, error); }
    }

    async approveImport(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.imports.approve(tenantOf(req), await actorOf(req), idParam(req)));
        } catch (error) { fail(res, next, error); }
    }

    async rejectImport(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.imports.reject(tenantOf(req), await actorOf(req), idParam(req), req.body));
        } catch (error) { fail(res, next, error); }
    }

    async cancelImport(req: Request, res: Response, next: NextFunction) {
        try {
            res.json(await warehouseModule.imports.cancel(tenantOf(req), await actorOf(req), idParam(req)));
        } catch (error) { fail(res, next, error); }
    }

    /* ── Auswahlen ──────────────────────────────────────────────────────── */

    async suppliers(req: Request, res: Response, next: NextFunction) {
        try {
            res.json({ items: await warehouseModule.catalog.suppliers(tenantOf(req), req.query.q) });
        } catch (error) { fail(res, next, error); }
    }

    async projects(req: Request, res: Response, next: NextFunction) {
        try {
            res.json({ items: await warehouseModule.catalog.projects(tenantOf(req), req.query.search) });
        } catch (error) { fail(res, next, error); }
    }

    async devices(req: Request, res: Response, next: NextFunction) {
        try {
            res.json({ items: await warehouseModule.catalog.devices(tenantOf(req), idParam(req)) });
        } catch (error) { fail(res, next, error); }
    }
}
