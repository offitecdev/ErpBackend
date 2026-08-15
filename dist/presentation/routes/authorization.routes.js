"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const client_1 = require("@prisma/client");
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const EmployeeRepository_1 = require("../../infrastructure/repositories/EmployeeRepository");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
const BcryptCryptoService_1 = require("../../infrastructure/services/BcryptCryptoService");
const password_1 = require("../../application/validation/password");
const serviceTenantScope_1 = require("../controllers/serviceTenantScope");
const tenantTree_1 = require("../../shared/tenantTree");
const tenantAccess_1 = require("../utils/tenantAccess");
const AuditLogService_1 = require("../../infrastructure/services/AuditLogService");
const authorizationLevels_1 = require("../../shared/authorizationLevels");
/* Berechtigungsseite (Einstellungen → Berechtigungen): je Person die Zugangs-
   daten (E-Mail/Kennwort/Firmen) und je Modul eine Stufe (1 ansehen /
   2 bearbeiten / 3 löschen). Der Personentyp wird aus der Auswahl ABGELEITET.

   Persistenz läuft über das BESTEHENDE Rollenmodell, nicht daran vorbei:
   die Stufen ergeben eine Rechtemenge + ein Modulpaket, und dafür wird eine
   automatisch verwaltete, GETEILTE Rolle am Baum-Stamm gesucht oder angelegt
   (gleicher Name + gleiche Rechte + gleiches Paket → gleiche Rolle). Zwei
   Verkäufer mit identischen Stufen teilen sich also EINE Rolle — die
   Rollenliste wächst nur, wenn wirklich neue Kombinationen entstehen. */
const router = (0, express_1.Router)();
const employeeRepo = new EmployeeRepository_1.EmployeeRepository();
const roleRepo = new RoleRepository_1.RoleRepository();
const cryptoService = new BcryptCryptoService_1.BcryptCryptoService();
const setsEqual = (a, b) => a.size === b.size && [...a].every((value) => b.has(value));
/**
 * GET /employees/authorization/list?page=&pageSize= — die Personalliste der
 * Seite (15 je Seite): Name, E-Mail, abgeleitete Rolle, aktiv. Eine Anweisung
 * plus Zählung, Rolle per COALESCE wie überall.
 */
router.get('/authorization/list', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (req, res) => {
    try {
        const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(req.user.tenantId);
        if (treeTenantIds.length === 0)
            return res.status(200).json({ data: [], total: 0, page: 1, pageSize: 15 });
        const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
        const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize || '15'), 10) || 15));
        const search = String(req.query.search || '').trim();
        const conditions = [
            client_1.Prisma.sql `e.tenantId IN (${client_1.Prisma.join(treeTenantIds)})`,
            client_1.Prisma.sql `e.deletedAt IS NULL`,
        ];
        if (search) {
            const like = `%${search}%`;
            conditions.push(client_1.Prisma.sql `(e.firstName LIKE ${like} OR e.lastName LIKE ${like} OR e.email LIKE ${like})`);
        }
        const whereSql = client_1.Prisma.join(conditions, ' AND ');
        const [rows, countRows] = await Promise.all([
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT e.id, e.firstName, e.lastName, e.email, e.isActive,
                       COALESCE(
                           (SELECT r.roleName FROM EmployeeRole er JOIN Role r ON r.id = er.roleId
                             WHERE er.employeeId = e.id LIMIT 1),
                           e.roleName
                       ) AS roleName
                FROM Employee e
                WHERE ${whereSql}
                ORDER BY e.firstName ASC, e.lastName ASC
                LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
            `),
            prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT COUNT(*) AS total FROM Employee e WHERE ${whereSql}
            `),
        ]);
        res.status(200).json({
            data: rows.map((row) => ({
                id: row.id,
                firstName: row.firstName,
                lastName: row.lastName,
                email: row.email,
                isActive: Boolean(row.isActive),
                roleName: row.roleName ?? null,
            })),
            total: Number(countRows[0]?.total ?? 0),
            page,
            pageSize,
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * GET /employees/:id/authorization — der Stand EINER Person für das Formular:
 * E-Mail, Firmen, Rollenname und die je Modul zurückgerechnete Stufe.
 */
router.get('/:id/authorization', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(req.user.tenantId);
        const employee = await prisma_client_1.default.employee.findFirst({
            where: { id, tenantId: { in: treeTenantIds }, deletedAt: null },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                roleName: true,
                allowedTenantIds: true,
                employeeRoles: {
                    take: 1,
                    select: {
                        role: {
                            select: {
                                roleName: true,
                                permissions: { select: { permission: { select: { permissionName: true } } } },
                                moduleConfigs: { take: 1, select: { moduleKeys: true } },
                            },
                        },
                    },
                },
            },
        });
        if (!employee)
            return res.status(404).json({ error: 'Personel bulunamadı.' });
        const role = employee.employeeRoles[0]?.role ?? null;
        const packageKeys = Array.isArray(role?.moduleConfigs?.[0]?.moduleKeys)
            ? role.moduleConfigs[0].moduleKeys
            : [];
        const permissionNames = role
            ? role.permissions.map((entry) => entry.permission.permissionName)
            : [];
        res.status(200).json({
            id: employee.id,
            firstName: employee.firstName,
            lastName: employee.lastName,
            email: employee.email,
            roleName: role?.roleName ?? employee.roleName ?? null,
            allowedTenantIds: Array.isArray(employee.allowedTenantIds) ? employee.allowedTenantIds : null,
            moduleLevels: (0, authorizationLevels_1.levelsFromRole)(packageKeys, permissionNames),
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * PUT /employees/:id/authorization — { email?, password?, allowedTenantIds?, moduleLevels }
 *
 * Rechnet die Stufen in Rechte + Modulpaket um, sucht/erzeugt die passende
 * automatisch verwaltete Rolle am Stamm, weist sie exklusiv zu (eine Rolle je
 * Person — Haus-Semantik) und schreibt die Zugangsdaten. Antwort = der neue
 * Stand in der Form des GET.
 */
router.put('/:id/authorization', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (req, res) => {
    try {
        const user = req.user;
        const id = String(req.params.id || '');
        const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(user.tenantId);
        const employee = await prisma_client_1.default.employee.findFirst({
            where: { id, tenantId: { in: treeTenantIds }, deletedAt: null },
            select: { id: true, email: true },
        });
        if (!employee)
            return res.status(404).json({ error: 'Personel bulunamadı.' });
        const levels = (0, authorizationLevels_1.sanitizeModuleLevels)(req.body?.moduleLevels);
        const permissionNames = (0, authorizationLevels_1.permissionsForLevels)(levels);
        const roleName = (0, authorizationLevels_1.deriveRoleName)(levels);
        const packageKeys = (0, authorizationLevels_1.packageKeysForLevels)(levels);
        /* Selbstaussperrung verhindern (Vorfall 14.08.2026: der Admin hat sein
           eigenes Konto gespeichert und dabei die Verwaltungsrechte verloren —
           danach hatte NIEMAND mehr Zugriff auf diese Seite). Wer sich selbst
           speichert, muss Einstellungen gewählt lassen; damit behält immer
           mindestens die speichernde Person die Verwaltungsrechte. */
        if (id === user.id && !permissionNames.includes('roles.manage')) {
            return res.status(400).json({
                error: 'Das eigene Konto kann sich die Verwaltung nicht entziehen — Einstellungen gewählt lassen oder eine zweite Admin-Person speichern lassen.',
            });
        }
        // Rechtenamen → ids (eine Abfrage; unbekannte Namen fallen still weg —
        // der Katalog ist die Autorität, die Tabelle wird per Seed gefüllt).
        const permissionRows = permissionNames.length
            ? await prisma_client_1.default.permission.findMany({
                where: { permissionName: { in: permissionNames } },
                select: { id: true },
            })
            : [];
        const wantedPermissionIds = new Set(permissionRows.map((row) => row.id));
        // Passende verwaltete Rolle suchen: gleicher Name am Stamm, gleiche
        // Rechtemenge, gleiches Modulpaket.
        const rootId = (await (0, tenantTree_1.findTenantRootIdCached)(user.tenantId)) ?? user.tenantId;
        const candidates = await prisma_client_1.default.role.findMany({
            where: { tenantId: rootId, roleName },
            select: {
                id: true,
                permissions: { select: { permissionId: true } },
                moduleConfigs: { select: { tenantId: true, moduleKeys: true } },
            },
        });
        const wantedPackage = new Set(packageKeys);
        let role = candidates.find((candidate) => {
            const candidatePerms = new Set(candidate.permissions.map((entry) => entry.permissionId));
            const config = candidate.moduleConfigs[0];
            const candidatePackage = new Set(Array.isArray(config?.moduleKeys) ? config.moduleKeys : []);
            return setsEqual(candidatePerms, wantedPermissionIds) && setsEqual(candidatePackage, wantedPackage);
        }) ?? null;
        if (!role) {
            const created = await prisma_client_1.default.role.create({
                data: {
                    id: (0, nanoid_1.nanoid)(8),
                    tenantId: rootId,
                    roleName,
                    permissions: {
                        create: [...wantedPermissionIds].map((permissionId) => ({ permissionId })),
                    },
                    // Das Paket gilt im GANZEN Baum: getMe zeigt einen Mandanten
                    // nur, wenn die Rolle dort eine Konfigurationszeile hat.
                    moduleConfigs: {
                        create: treeTenantIds.map((tenantId) => ({ tenantId, moduleKeys: packageKeys })),
                    },
                },
                select: { id: true },
            });
            role = { id: created.id, permissions: [], moduleConfigs: [] };
        }
        // Exklusive Zuweisung (löscht vorige Rollen, leert den Rechte-Cache).
        await roleRepo.assignRoleToEmployee(id, role.id);
        // Zugangsdaten. EmployeeRepository.update leert Auth- und
        // Personallisten-Cache selbst.
        const patch = { roleName };
        const email = String(req.body?.email || '').trim();
        if (email && email !== employee.email)
            patch.email = email;
        if (req.body?.password) {
            const password = String(req.body.password);
            (0, password_1.assertPasswordPolicy)(password);
            patch.passwordHash = await cryptoService.hashPassword(password);
            patch.passwordChangedAt = new Date();
        }
        if (req.body?.allowedTenantIds !== undefined) {
            const wanted = (0, tenantAccess_1.parseAllowedTenantIds)(req.body.allowedTenantIds);
            if (wanted) {
                const outside = wanted.filter((tenantId) => !treeTenantIds.includes(tenantId));
                if (outside.length)
                    return res.status(400).json({ error: 'Seçilen şirketlerden biri bu şirket ağacına ait değil.' });
            }
            patch.allowedTenantIds = wanted;
        }
        await employeeRepo.update(id, patch);
        AuditLogService_1.auditLog.log({
            action: 'employee.authorization',
            tenantId: user.tenantId,
            employeeId: user.id,
            entityType: 'Employee',
            entityId: id,
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(200).json({
            id,
            roleName,
            moduleLevels: levels,
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=authorization.routes.js.map