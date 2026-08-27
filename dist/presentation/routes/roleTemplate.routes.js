"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOTAL_PAGE_COUNT = exports.ensurePurserRole = exports.ensureSystemAdminRole = exports.resolvePageLevels = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const serviceTenantScope_1 = require("../controllers/serviceTenantScope");
const tenantTree_1 = require("../../shared/tenantTree");
const AuditLogService_1 = require("../../infrastructure/services/AuditLogService");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
const pageCatalog_1 = require("../../shared/pageCatalog");
/* ── ROLLENVORLAGEN (Einstellungen → Berechtigungen, 17.08.2026) ─────────────
 *
 * Hier werden die Rollen GEBAUT: eine Tabelle, Modul für Modul und Seite für
 * Seite, je Seite eine Stufe (1 ansehen / 2 bearbeiten / 3 löschen). Wer welche
 * Rolle bekommt, steht nicht mehr hier, sondern beim Personal
 * (/personnel/:id → Zugang).
 *
 * Gespeichert wird die Stufenkarte auf `Role.pageLevels`; daraus werden die
 * RolePermission-Zeilen und das Modulpaket ABGELEITET. So bleibt jede
 * bestehende `requirePermission`-Prüfung im Server die Autorität — die neue
 * Tabelle füttert das alte Rechtemodell, sie umgeht es nicht.
 *
 * Die Administratorrolle ist FEST (Vorgabe): alle Seiten, alle Rechte, nicht
 * änderbar und nicht löschbar. Sie wird beim ersten Aufruf am Stamm angelegt
 * und bei jedem Aufruf nachgezogen, damit ein erweiterter Katalog sie nicht
 * hinter sich lässt. Der IT-Bereich bleibt aussen vor: der hängt an einem
 * eigenen Kennwort, nicht an einem Recht.
 */
const router = (0, express_1.Router)();
const ADMIN_ROLE_NAME = 'Administrator';
const PURSER_ROLE_NAME = 'Purser';
/**
 * Startstufen der festen Purser-Rolle: das Antragspostfach zum Entscheiden,
 * die eigenen Anträge und die Gesamtübersicht. Nur der ERSTE Wurf — die
 * Stufenkarte bleibt (anders als beim Administrator) bearbeitbar.
 */
const PURSER_DEFAULT_PAGE_LEVELS = {
    'personnel.requests': 1,
    'personnel.requestsIncoming': 2,
    'personnel.requestsAll': 1,
};
const setsEqual = (a, b) => a.size === b.size && [...a].every((value) => b.has(value));
/**
 * Rechtenamen → ids. Fehlende Namen werden ANGELEGT statt still verworfen:
 * der Katalog ist die Autorität, und eine neue Seite darf nicht dadurch
 * wirkungslos bleiben, dass der Seed noch nicht durchgelaufen ist.
 */
const permissionIdsForNames = async (names) => {
    if (!names.length)
        return [];
    const existing = await prisma_client_1.default.permission.findMany({
        where: { permissionName: { in: names } },
        select: { id: true, permissionName: true },
    });
    const known = new Map(existing.map((row) => [row.permissionName, row.id]));
    const missing = names.filter((name) => !known.has(name));
    if (missing.length) {
        await prisma_client_1.default.permission.createMany({
            data: missing.map((permissionName) => ({ id: (0, nanoid_1.nanoid)(8), permissionName })),
            skipDuplicates: true,
        });
        const created = await prisma_client_1.default.permission.findMany({
            where: { permissionName: { in: missing } },
            select: { id: true, permissionName: true },
        });
        for (const row of created)
            known.set(row.permissionName, row.id);
    }
    return names.map((name) => known.get(name)).filter((id) => Boolean(id));
};
/**
 * Rechtezeilen einer Rolle auf die Sollmenge bringen (nur bei Abweichung).
 *
 * Weggenommen wird NUR, was der Seitenkatalog selbst vergeben kann. Rechte
 * ausserhalb des Katalogs (Wartung, Regie, Logistik, Arbeitsaufträge, die
 * Verwaltungsrechte) stehen in dieser Tabelle nicht zur Wahl — ein Speichern
 * hier ist also keine Aussage über sie und darf sie nicht löschen. Vorher hat
 * jedes Speichern einer Technikerrolle `maintenance.tasks.manage` mitgerissen
 * und die Person aus /montage ausgesperrt.
 */
const syncRolePermissions = async (roleId, permissionNames) => {
    const wantedIds = new Set(await permissionIdsForNames(permissionNames));
    // Ein Join statt `include`: der Name entscheidet, ob eine Zeile
    // überhaupt zur Tabelle gehört (siehe oben).
    const currentRows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
        SELECT rp.permissionId AS permissionId, p.permissionName AS permissionName
        FROM RolePermission rp
        JOIN Permission p ON p.id = rp.permissionId
        WHERE rp.roleId = ${roleId}
    `);
    const currentIds = new Set(currentRows.map((row) => row.permissionId));
    const removableIds = new Set(currentRows
        .filter((row) => pageCatalog_1.CATALOG_GRANTED_PERMISSION_NAMES.has(row.permissionName))
        .map((row) => row.permissionId));
    const toRemove = [...removableIds].filter((id) => !wantedIds.has(id));
    const toAdd = [...wantedIds].filter((id) => !currentIds.has(id));
    if (!toRemove.length && !toAdd.length)
        return false;
    if (toRemove.length) {
        await prisma_client_1.default.rolePermission.deleteMany({ where: { roleId, permissionId: { in: toRemove } } });
    }
    if (toAdd.length) {
        await prisma_client_1.default.rolePermission.createMany({
            data: toAdd.map((permissionId) => ({ roleId, permissionId })),
            skipDuplicates: true,
        });
    }
    return true;
};
/**
 * Das Modulpaket gilt im GANZEN Baum: getMe zeigt einen Mandanten nur, wenn
 * die Rolle dort eine Konfigurationszeile hat. Darum eine Zeile je Firma.
 */
const syncRoleModuleConfigs = async (roleId, treeTenantIds, moduleKeys) => {
    const configs = prisma_client_1.default.roleModuleConfig;
    const existing = await configs.findMany({
        where: { roleId },
        select: { tenantId: true, moduleKeys: true },
    });
    const byTenant = new Map(existing.map((row) => [row.tenantId, row.moduleKeys]));
    const wanted = new Set(moduleKeys);
    await Promise.all(treeTenantIds.map(async (tenantId) => {
        const current = byTenant.get(tenantId);
        const currentSet = new Set(Array.isArray(current) ? current : []);
        if (byTenant.has(tenantId) && setsEqual(currentSet, wanted))
            return;
        await configs.upsert({
            where: { roleId_tenantId: { roleId, tenantId } },
            create: { roleId, tenantId, moduleKeys },
            update: { moduleKeys },
        });
    }));
    // Firmen, die nicht mehr zum Baum gehören, verlieren ihre Zeile.
    const stale = existing.map((row) => row.tenantId).filter((tenantId) => !treeTenantIds.includes(tenantId));
    if (stale.length)
        await configs.deleteMany({ where: { roleId, tenantId: { in: stale } } });
};
/**
 * Stufenkarte einer Rolle für die Anzeige. Reihenfolge der Wahrheit:
 * Administrator → alles; gespeicherte Karte → so wie gespeichert; Altrolle
 * ohne Karte → aus den Rechten zurückgerechnet.
 */
const resolvePageLevels = (role, permissionNames) => {
    if (role.isSystemAdmin)
        return { ...pageCatalog_1.ADMIN_PAGE_LEVELS };
    if (role.pageLevels && typeof role.pageLevels === 'object')
        return (0, pageCatalog_1.sanitizePageLevels)(role.pageLevels);
    return (0, pageCatalog_1.pageLevelsFromPermissions)(permissionNames);
};
exports.resolvePageLevels = resolvePageLevels;
/**
 * Die feste Administratorrolle des Baums holen — anlegen, falls sie fehlt, und
 * ihre Rechte/Module nachziehen, falls der Katalog gewachsen ist.
 */
const ensureSystemAdminRole = async (rootTenantId, treeTenantIds) => {
    let role = await prisma_client_1.default.role.findFirst({
        where: { tenantId: rootTenantId, isSystemAdmin: true },
        select: { id: true, roleName: true },
    });
    if (!role) {
        // Übernahme statt Zweitrolle: ein bestehender "Administrator" am Stamm
        // WIRD die feste Rolle, sonst stünden nach dem Aufspielen zwei gleich
        // benannte Rollen nebeneinander.
        const legacy = await prisma_client_1.default.role.findFirst({
            where: { tenantId: rootTenantId, roleName: ADMIN_ROLE_NAME },
            select: { id: true, roleName: true },
        });
        if (legacy) {
            await prisma_client_1.default.role.update({ where: { id: legacy.id }, data: { isSystemAdmin: true } });
            role = legacy;
        }
        else {
            const created = await prisma_client_1.default.role.create({
                data: { id: (0, nanoid_1.nanoid)(8), tenantId: rootTenantId, roleName: ADMIN_ROLE_NAME, isSystemAdmin: true },
                select: { id: true, roleName: true },
            });
            role = created;
        }
    }
    const changed = await syncRolePermissions(role.id, (0, pageCatalog_1.adminPermissionNames)());
    await syncRoleModuleConfigs(role.id, treeTenantIds, (0, pageCatalog_1.adminModuleKeys)());
    if (changed)
        await (0, RoleRepository_1.clearPermissionCacheForRole)(role.id);
    return role;
};
exports.ensureSystemAdminRole = ensureSystemAdminRole;
/**
 * ── DIE FESTE PURSER-ROLLE (27.08.2026, Vorgabe) ─────────────────────────────
 *
 * Der Purser führt die ZWEITE Stufe des Antragswegs: erst entscheidet die
 * Verwaltung (Administrator oder z. B. Projektleitung), dann geht der Antrag
 * direkt an ihn — seine Freigabe schliesst ihn ab. Er löst die alte
 * Personalrolle ACCOUNTANT ab, die auf einer eigenen Spalte lebte und in den
 * Einstellungen unsichtbar war.
 *
 * Anders als die Administratorrolle bleibt seine STUFENKARTE bearbeitbar —
 * Name und Flagge nicht: die Antragslogik erkennt die Rolle an `isPurser`,
 * nicht am Namen.
 */
const ensurePurserRole = async (rootTenantId, treeTenantIds) => {
    let role = await prisma_client_1.default.role.findFirst({
        where: { tenantId: { in: treeTenantIds }, isPurser: true },
        select: { id: true, roleName: true },
    });
    if (!role) {
        // Übernahme statt Zweitrolle — wie beim Administrator.
        const legacy = await prisma_client_1.default.role.findFirst({
            where: { tenantId: rootTenantId, roleName: PURSER_ROLE_NAME },
            select: { id: true, roleName: true },
        });
        if (legacy) {
            await prisma_client_1.default.role.update({ where: { id: legacy.id }, data: { isPurser: true } });
            role = legacy;
        }
        else {
            role = await prisma_client_1.default.role.create({
                data: {
                    id: (0, nanoid_1.nanoid)(8),
                    tenantId: rootTenantId,
                    roleName: PURSER_ROLE_NAME,
                    isPurser: true,
                    pageLevels: PURSER_DEFAULT_PAGE_LEVELS,
                },
                select: { id: true, roleName: true },
            });
            await syncRolePermissions(role.id, (0, pageCatalog_1.permissionsForPageLevels)(PURSER_DEFAULT_PAGE_LEVELS));
            await syncRoleModuleConfigs(role.id, treeTenantIds, (0, pageCatalog_1.moduleKeysForPageLevels)(PURSER_DEFAULT_PAGE_LEVELS));
        }
    }
    return role;
};
exports.ensurePurserRole = ensurePurserRole;
/**
 * GET /role-templates — die Rollenliste der Berechtigungsseite: Name, Anzahl
 * zugewiesener Personen und die Stufenkarte je Rolle. Die Administratorrolle
 * steht immer zuoberst.
 */
router.get('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(tenantId);
        const rootTenantId = (await (0, tenantTree_1.findTenantRootIdCached)(tenantId)) ?? tenantId;
        await (0, exports.ensureSystemAdminRole)(rootTenantId, treeTenantIds);
        await (0, exports.ensurePurserRole)(rootTenantId, treeTenantIds);
        const roles = await prisma_client_1.default.role.findMany({
            where: { tenantId: { in: treeTenantIds } },
            orderBy: { roleName: 'asc' },
            select: {
                id: true,
                roleName: true,
                pageLevels: true,
                isSystemAdmin: true,
                isPurser: true,
                permissions: { select: { permission: { select: { permissionName: true } } } },
                _count: { select: { employees: true } },
            },
        });
        const data = roles.map((role) => ({
            id: role.id,
            roleName: role.roleName,
            isSystemAdmin: Boolean(role.isSystemAdmin),
            isPurser: Boolean(role.isPurser),
            userCount: role._count?.employees ?? 0,
            pageLevels: (0, exports.resolvePageLevels)(role, role.permissions.map((entry) => entry.permission.permissionName)),
        }));
        // Administrator zuoberst, der Rest alphabetisch (kommt schon so).
        data.sort((a, b) => Number(b.isSystemAdmin) - Number(a.isSystemAdmin));
        res.status(200).json({ data });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/** GET /role-templates/catalog — der Seitenkatalog, damit die Tabelle nicht
    von einer zweiten Kopie im Browser abhängt, wenn sie auseinanderlaufen. */
router.get('/catalog', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), (_req, res) => {
    res.status(200).json({
        modules: pageCatalog_1.PAGE_MODULES.map((moduleDef) => ({
            key: moduleDef.key,
            labelKey: moduleDef.labelKey,
            pages: moduleDef.pages.map((page) => ({
                key: page.key,
                path: page.path,
                labelKey: page.labelKey,
                maxLevel: page.maxLevel,
            })),
        })),
    });
});
/** POST /role-templates — { roleName, pageLevels } → neue Rolle am Stamm. */
router.post('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (req, res) => {
    try {
        const user = req.user;
        const roleName = String(req.body?.roleName || '').trim();
        if (!roleName)
            return res.status(400).json({ error: 'Rollenname fehlt.' });
        if (roleName.toLowerCase() === ADMIN_ROLE_NAME.toLowerCase()) {
            return res.status(400).json({ error: 'Der Name "Administrator" ist für die feste Rolle reserviert.' });
        }
        if (roleName.toLowerCase() === PURSER_ROLE_NAME.toLowerCase()) {
            return res.status(400).json({ error: 'Der Name "Purser" ist für die feste Rolle reserviert.' });
        }
        const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(user.tenantId);
        const rootTenantId = (await (0, tenantTree_1.findTenantRootIdCached)(user.tenantId)) ?? user.tenantId;
        const duplicate = await prisma_client_1.default.role.findFirst({
            where: { tenantId: { in: treeTenantIds }, roleName },
            select: { id: true },
        });
        if (duplicate)
            return res.status(400).json({ error: 'Eine Rolle mit diesem Namen besteht bereits.' });
        const pageLevels = (0, pageCatalog_1.sanitizePageLevels)(req.body?.pageLevels);
        const role = await prisma_client_1.default.role.create({
            data: { id: (0, nanoid_1.nanoid)(8), tenantId: rootTenantId, roleName, pageLevels },
            select: { id: true, roleName: true },
        });
        await syncRolePermissions(role.id, (0, pageCatalog_1.permissionsForPageLevels)(pageLevels));
        await syncRoleModuleConfigs(role.id, treeTenantIds, (0, pageCatalog_1.moduleKeysForPageLevels)(pageLevels));
        AuditLogService_1.auditLog.log({
            action: 'role.template.create',
            tenantId: user.tenantId,
            employeeId: user.id,
            entityType: 'Role',
            entityId: role.id,
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(201).json({ id: role.id, roleName: role.roleName, isSystemAdmin: false, userCount: 0, pageLevels });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/** PUT /role-templates/:id — { roleName?, pageLevels? }. Die Administratorrolle
    ist fest und antwortet 403. */
router.put('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (req, res) => {
    try {
        const user = req.user;
        const id = String(req.params.id || '');
        const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(user.tenantId);
        const existing = await prisma_client_1.default.role.findFirst({
            where: { id, tenantId: { in: treeTenantIds } },
            select: { id: true, roleName: true, isSystemAdmin: true, isPurser: true },
        });
        if (!existing)
            return res.status(404).json({ error: 'Rolle nicht gefunden.' });
        if (existing.isSystemAdmin) {
            return res.status(403).json({ error: 'Die Administratorrolle ist fest und kann nicht geändert werden.' });
        }
        // Die Purser-Rolle: Stufen ja, Name nein — die Antragslogik hängt an ihr.
        if (existing.isPurser && req.body?.roleName !== undefined
            && String(req.body.roleName).trim() !== existing.roleName) {
            return res.status(403).json({ error: 'Die Purser-Rolle behält ihren Namen; ihre Seitenstufen bleiben änderbar.' });
        }
        /* Selbstaussperrung verhindern (Vorfall 14.08.2026): wer die Rolle
           bearbeitet, die er selbst trägt, darf sich die Verwaltung nicht
           entziehen — sonst käme danach NIEMAND mehr auf diese Seite. Der
           Seitenkatalog kennt `roles.manage` gar nicht, also trägt nur die
           Administratorrolle es; eine andere Rolle zu tragen und zugleich zu
           bearbeiten heisst deshalb: Finger weg. */
        const ownRole = await prisma_client_1.default.employeeRole.findFirst({
            where: { employeeId: user.id, roleId: id },
            select: { roleId: true },
        });
        if (ownRole) {
            return res.status(400).json({
                error: 'Die eigene Rolle kann hier nicht bearbeitet werden — sonst entzieht sich das eigene Konto die Verwaltung.',
            });
        }
        const data = {};
        let pageLevels = null;
        if (req.body?.roleName !== undefined) {
            const roleName = String(req.body.roleName || '').trim();
            if (!roleName)
                return res.status(400).json({ error: 'Rollenname fehlt.' });
            if (roleName.toLowerCase() === ADMIN_ROLE_NAME.toLowerCase()) {
                return res.status(400).json({ error: 'Der Name "Administrator" ist für die feste Rolle reserviert.' });
            }
            if (!existing.isPurser && roleName.toLowerCase() === PURSER_ROLE_NAME.toLowerCase()) {
                return res.status(400).json({ error: 'Der Name "Purser" ist für die feste Rolle reserviert.' });
            }
            if (roleName !== existing.roleName) {
                const duplicate = await prisma_client_1.default.role.findFirst({
                    where: { tenantId: { in: treeTenantIds }, roleName, id: { not: id } },
                    select: { id: true },
                });
                if (duplicate)
                    return res.status(400).json({ error: 'Eine Rolle mit diesem Namen besteht bereits.' });
            }
            data.roleName = roleName;
        }
        if (req.body?.pageLevels !== undefined) {
            pageLevels = (0, pageCatalog_1.sanitizePageLevels)(req.body.pageLevels);
            data.pageLevels = pageLevels;
        }
        if (Object.keys(data).length)
            await prisma_client_1.default.role.update({ where: { id }, data: data });
        if (pageLevels) {
            await syncRolePermissions(id, (0, pageCatalog_1.permissionsForPageLevels)(pageLevels));
            await syncRoleModuleConfigs(id, treeTenantIds, (0, pageCatalog_1.moduleKeysForPageLevels)(pageLevels));
            // Die Rechte der Trägerinnen und Träger stehen im Cache — ohne das
            // Leeren griffe die neue Stufe erst nach Ablauf der TTL.
            await (0, RoleRepository_1.clearPermissionCacheForRole)(id);
        }
        AuditLogService_1.auditLog.log({
            action: 'role.template.update',
            tenantId: user.tenantId,
            employeeId: user.id,
            entityType: 'Role',
            entityId: id,
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(200).json({
            id,
            roleName: data.roleName ?? existing.roleName,
            isSystemAdmin: false,
            pageLevels: pageLevels ?? undefined,
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/** DELETE /role-templates/:id — nur unbenutzte Rollen; die Administratorrolle nie. */
router.delete('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (req, res) => {
    try {
        const user = req.user;
        const id = String(req.params.id || '');
        const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(user.tenantId);
        const existing = await prisma_client_1.default.role.findFirst({
            where: { id, tenantId: { in: treeTenantIds } },
            select: { id: true, isSystemAdmin: true, isPurser: true, _count: { select: { employees: true } } },
        });
        if (!existing)
            return res.status(404).json({ error: 'Rolle nicht gefunden.' });
        if (existing.isSystemAdmin) {
            return res.status(403).json({ error: 'Die Administratorrolle kann nicht gelöscht werden.' });
        }
        if (existing.isPurser) {
            return res.status(403).json({ error: 'Die Purser-Rolle ist fest und kann nicht gelöscht werden.' });
        }
        if ((existing._count?.employees ?? 0) > 0) {
            return res.status(400).json({
                error: 'Diese Rolle ist noch Personen zugewiesen — erst umhängen, dann löschen.',
            });
        }
        await prisma_client_1.default.rolePermission.deleteMany({ where: { roleId: id } });
        await prisma_client_1.default.roleModuleConfig.deleteMany({ where: { roleId: id } });
        await prisma_client_1.default.role.delete({ where: { id } });
        AuditLogService_1.auditLog.log({
            action: 'role.template.delete',
            tenantId: user.tenantId,
            employeeId: user.id,
            entityType: 'Role',
            entityId: id,
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(200).json({ ok: true });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/** Anzahl Seiten im Katalog — die Liste zeigt „12 von 22 Seiten". */
exports.TOTAL_PAGE_COUNT = pageCatalog_1.ALL_PAGES.length;
exports.default = router;
//# sourceMappingURL=roleTemplate.routes.js.map