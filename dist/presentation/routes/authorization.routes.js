"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
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
const roleTemplate_routes_1 = require("./roleTemplate.routes");
/* ── ZUGANG EINER PERSON (Personal → Person → Zugang, 17.08.2026) ────────────
 *
 * Umgebaut: früher stellte diese Seite je Modul eine Stufe ein und LEITETE
 * daraus eine Rolle ab. Jetzt ist es umgekehrt — die Rollen werden unter
 * Einstellungen → Berechtigungen gebaut (roleTemplate.routes.ts), und hier
 * wird EINE davon zugewiesen. Ein Ort für die Rechte, ein Ort für die Personen.
 *
 * Der Router hängt weiter an `/employees`; seine Routen sind zweigliedrig
 * ('/:id/authorization') und kollidieren deshalb nicht mit dem '/:id' des
 * Personal-Routers davor.
 */
const router = (0, express_1.Router)();
const employeeRepo = new EmployeeRepository_1.EmployeeRepository();
const roleRepo = new RoleRepository_1.RoleRepository();
const cryptoService = new BcryptCryptoService_1.BcryptCryptoService();
/**
 * GET /employees/:id/authorization — der Zugangsstand EINER Person: E-Mail,
 * sichtbare Firmen, zugewiesene Rolle, die Rollenauswahl und — nur zum Ansehen —
 * die Seitenstufen, die diese Rolle mitbringt.
 */
router.get('/:id/authorization', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'), async (req, res) => {
    try {
        const user = req.user;
        const id = String(req.params.id || '');
        const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(user.tenantId);
        const rootTenantId = (await (0, tenantTree_1.findTenantRootIdCached)(user.tenantId)) ?? user.tenantId;
        await (0, roleTemplate_routes_1.ensureSystemAdminRole)(rootTenantId, treeTenantIds);
        const [employee, roles] = await Promise.all([
            prisma_client_1.default.employee.findFirst({
                where: { id, tenantId: { in: treeTenantIds }, deletedAt: null },
                select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    isActive: true,
                    allowedTenantIds: true,
                    employeeRoles: { take: 1, select: { roleId: true } },
                },
            }),
            prisma_client_1.default.role.findMany({
                where: { tenantId: { in: treeTenantIds } },
                orderBy: { roleName: 'asc' },
                select: {
                    id: true,
                    roleName: true,
                    pageLevels: true,
                    isSystemAdmin: true,
                    permissions: { select: { permission: { select: { permissionName: true } } } },
                },
            }),
        ]);
        if (!employee)
            return res.status(404).json({ error: 'Person nicht gefunden.' });
        const options = roles.map((role) => ({
            id: role.id,
            roleName: role.roleName,
            isSystemAdmin: Boolean(role.isSystemAdmin),
            pageLevels: (0, roleTemplate_routes_1.resolvePageLevels)(role, role.permissions.map((e) => e.permission.permissionName)),
        }));
        options.sort((a, b) => Number(b.isSystemAdmin) - Number(a.isSystemAdmin));
        const roleId = employee.employeeRoles[0]?.roleId ?? null;
        res.status(200).json({
            id: employee.id,
            firstName: employee.firstName,
            lastName: employee.lastName,
            email: employee.email,
            isActive: employee.isActive,
            allowedTenantIds: Array.isArray(employee.allowedTenantIds) ? employee.allowedTenantIds : null,
            roleId,
            roles: options,
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * PUT /employees/:id/authorization — { email?, password?, allowedTenantIds?, roleId }
 *
 * Weist die gewählte Rolle exklusiv zu (eine Rolle je Person — Haus-Semantik)
 * und schreibt die Zugangsdaten. `roleId: null` zieht jede Rolle ab: die Person
 * kann sich anmelden, sieht aber nichts.
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
            return res.status(404).json({ error: 'Person nicht gefunden.' });
        const rawRoleId = req.body?.roleId;
        const roleId = rawRoleId === null || rawRoleId === '' ? null : String(rawRoleId ?? '').trim() || undefined;
        let targetRole = null;
        if (roleId) {
            targetRole = await prisma_client_1.default.role.findFirst({
                where: { id: roleId, tenantId: { in: treeTenantIds } },
                select: { id: true, roleName: true, isSystemAdmin: true },
            });
            if (!targetRole)
                return res.status(400).json({ error: 'Rolle nicht gefunden.' });
        }
        /* Selbstaussperrung verhindern (Vorfall 14.08.2026: der Admin hat sein
           eigenes Konto gespeichert und dabei die Verwaltungsrechte verloren —
           danach hatte NIEMAND mehr Zugriff auf diese Seite). Nur die feste
           Administratorrolle trägt `roles.manage`; wer sich selbst speichert,
           muss sie also behalten. */
        if (id === user.id && roleId !== undefined && !targetRole?.isSystemAdmin) {
            return res.status(400).json({
                error: 'Das eigene Konto kann sich die Verwaltung nicht entziehen — Administratorrolle behalten oder eine zweite Admin-Person eintragen lassen.',
            });
        }
        if (roleId !== undefined) {
            if (targetRole)
                await roleRepo.assignRoleToEmployee(id, targetRole.id);
            else
                await roleRepo.clearRolesOfEmployee(id);
        }
        // Zugangsdaten. EmployeeRepository.update leert Auth- und
        // Personallisten-Cache selbst.
        const patch = {};
        if (roleId !== undefined)
            patch.roleName = targetRole?.roleName ?? null;
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
                    return res.status(400).json({ error: 'Eine der gewählten Firmen gehört nicht zu diesem Firmenbaum.' });
            }
            patch.allowedTenantIds = wanted;
        }
        if (Object.keys(patch).length)
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
            roleId: targetRole?.id ?? (roleId === null ? null : undefined),
            roleName: targetRole?.roleName ?? null,
        });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=authorization.routes.js.map