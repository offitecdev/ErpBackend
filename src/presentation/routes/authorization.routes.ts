import { Router } from 'express';
import prisma from '../../infrastructure/database/prisma.client';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import { EmployeeRepository } from '../../infrastructure/repositories/EmployeeRepository';
import { RoleRepository } from '../../infrastructure/repositories/RoleRepository';
import { BcryptCryptoService } from '../../infrastructure/services/BcryptCryptoService';
import { assertPasswordPolicy } from '../../application/validation/password';
import { getCompanyTreeTenantIds, getPersonnelTenantScope, getAssignableTenantIds, employeeScopeWhere } from '../controllers/serviceTenantScope';
import { findTenantRootIdCached } from '../../shared/tenantTree';
import { parseAllowedTenantIds } from '../utils/tenantAccess';
import { auditLog } from '../../infrastructure/services/AuditLogService';
import { ensureSystemAdminRole, resolvePageLevels } from './roleTemplate.routes';

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

const router = Router();

const employeeRepo = new EmployeeRepository();
const roleRepo = new RoleRepository();
const cryptoService = new BcryptCryptoService();

/**
 * GET /employees/:id/authorization — der Zugangsstand EINER Person: E-Mail,
 * sichtbare Firmen, zugewiesene Rolle, die Rollenauswahl und — nur zum Ansehen —
 * die Seitenstufen, die diese Rolle mitbringt.
 */
router.get('/:id/authorization', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const user = req.user!;
        const id = String(req.params.id || '');
        // Rollen sind baumweit (sie werden am Stamm gebaut); die PERSON gehört
        // dagegen nur der ausgewählten Firma — eine Person der Schwesterfirma
        // ist von hier aus unsichtbar und antwortet 404.
        const treeTenantIds = await getCompanyTreeTenantIds(user.tenantId);
        const scopeTenantIds = await getPersonnelTenantScope(user.tenantId);
        const rootTenantId = (await findTenantRootIdCached(user.tenantId)) ?? user.tenantId;
        await ensureSystemAdminRole(rootTenantId, treeTenantIds);

        const [employee, roles] = await Promise.all([
            prisma.employee.findFirst({
                where: { id, ...employeeScopeWhere(scopeTenantIds), deletedAt: null },
                select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    email: true,
                    isActive: true,
                    tenantId: true,
                    allowedTenantIds: true,
                    employeeRoles: { take: 1, select: { roleId: true } },
                },
            }),
            prisma.role.findMany({
                where: { tenantId: { in: treeTenantIds } },
                orderBy: { roleName: 'asc' },
                select: {
                    id: true,
                    roleName: true,
                    pageLevels: true,
                    isSystemAdmin: true,
                    canSwitchTenant: true,
                    permissions: { select: { permission: { select: { permissionName: true } } } },
                } as any,
            }) as any,
        ]);
        if (!employee) return res.status(404).json({ error: 'Person nicht gefunden.' });

        const options = (roles as any[]).map((role) => ({
            id: role.id,
            roleName: role.roleName,
            isSystemAdmin: Boolean(role.isSystemAdmin),
            /* Damit die Verwaltung auf DIESER Seite sieht, was die Rolle zur
               Firmenauswahl beitraegt: eine Rolle mit Firmenwechsel oeffnet die
               ganze eigene Gruppe, auch ohne einen Haken unten. Sonst haekelt
               jemand drei Firmen an und wundert sich, dass fuenf erscheinen. */
            canSwitchTenant: Boolean(role.isSystemAdmin || role.canSwitchTenant),
            pageLevels: resolvePageLevels(role, role.permissions.map((e: any) => e.permission.permissionName)),
        }));
        options.sort((a, b) => Number(b.isSystemAdmin) - Number(a.isSystemAdmin));

        /* Die Firmenauswahl dieser Seite kommt NICHT aus dem Firmenumschalter
           (der zeigt nur die zugeteilten Firmen — damit liesse sich nie eine
           weitere zuteilen), sondern aus `getAssignableTenantIds`: seit dem
           31.08.2026 JEDE aktive Firma, Untergesellschaft oder nicht. Die
           Vorgabe lautet, dass die Verwaltung hier sieht, was ueberhaupt in der
           Liste steht, und die Auswahl ausdruecklich trifft. */
        const assignableTenantIds = await getAssignableTenantIds(user.tenantId, user.homeTenantId);
        const companies = (await prisma.tenant.findMany({
            where: { id: { in: assignableTenantIds } },
            select: { id: true, tenantName: true, parentTenantId: true },
            orderBy: { tenantName: 'asc' },
        })).sort((a, b) => {
            if (!a.parentTenantId && b.parentTenantId) return -1;
            if (a.parentTenantId && !b.parentTenantId) return 1;
            return a.tenantName.localeCompare(b.tenantName, 'de');
        });

        const roleId = employee.employeeRoles[0]?.roleId ?? null;
        res.status(200).json({
            id: employee.id,
            firstName: employee.firstName,
            lastName: employee.lastName,
            email: employee.email,
            isActive: employee.isActive,
            // Die Firma, unter der die Person angelegt wurde: ohne eigene
            // Zuteilung ist genau das ihre einzige Firma.
            homeTenantId: employee.tenantId,
            allowedTenantIds: Array.isArray(employee.allowedTenantIds) ? employee.allowedTenantIds : null,
            companies,
            roleId,
            roles: options,
        });
    } catch (error: any) {
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
router.put('/:id/authorization', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const user = req.user!;
        const id = String(req.params.id || '');
        // Person: nur die ausgewählte Firma. Rollen: baumweit (siehe GET).
        const treeTenantIds = await getCompanyTreeTenantIds(user.tenantId);
        const employee = await prisma.employee.findFirst({
            where: { id, ...employeeScopeWhere(await getPersonnelTenantScope(user.tenantId)), deletedAt: null },
            select: { id: true, email: true },
        });
        if (!employee) return res.status(404).json({ error: 'Person nicht gefunden.' });

        const rawRoleId = req.body?.roleId;
        const roleId = rawRoleId === null || rawRoleId === '' ? null : String(rawRoleId ?? '').trim() || undefined;

        let targetRole: { id: string; roleName: string; isSystemAdmin: boolean } | null = null;
        if (roleId) {
            targetRole = await prisma.role.findFirst({
                where: { id: roleId, tenantId: { in: treeTenantIds } },
                select: { id: true, roleName: true, isSystemAdmin: true } as any,
            }) as any;
            if (!targetRole) return res.status(400).json({ error: 'Rolle nicht gefunden.' });
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
            if (targetRole) await roleRepo.assignRoleToEmployee(id, targetRole.id);
            else await roleRepo.clearRolesOfEmployee(id);
        }

        // Zugangsdaten. EmployeeRepository.update leert Auth- und
        // Personallisten-Cache selbst.
        const patch: Record<string, unknown> = {};
        if (roleId !== undefined) patch.roleName = targetRole?.roleName ?? null;
        const email = String(req.body?.email || '').trim();
        if (email && email !== employee.email) patch.email = email;
        if (req.body?.password) {
            const password = String(req.body.password);
            assertPasswordPolicy(password);
            patch.passwordHash = await cryptoService.hashPassword(password);
            patch.passwordChangedAt = new Date();
        }
        if (req.body?.allowedTenantIds !== undefined) {
            const wanted = parseAllowedTenantIds(req.body.allowedTenantIds);
            if (wanted) {
                // Nur der eigene Teilbaum — dieselbe Menge, die die Fläche
                // anbietet. Eine Untergesellschaft kann so keinen Zugang zu
                // einer Schwesterfirma verteilen, auch nicht mit einer von
                // Hand gesetzten Id.
                const assignable = await getAssignableTenantIds(user.tenantId, user.homeTenantId);
                const outside = wanted.filter((tenantId) => !assignable.includes(tenantId));
                if (outside.length) return res.status(400).json({ error: 'Eine der gewählten Firmen steht Ihnen nicht zur Verfügung.' });
            }
            patch.allowedTenantIds = wanted;
        }
        if (Object.keys(patch).length) await employeeRepo.update(id, patch as any);

        auditLog.log({
            action: 'employee.authorization',
            tenantId: user.tenantId,
            employeeId: user.id,
            entityType: 'Employee',
            entityId: id,
            ...auditLog.context(req),
        });

        res.status(200).json({
            id,
            roleId: targetRole?.id ?? (roleId === null ? null : undefined),
            roleName: targetRole?.roleName ?? null,
        });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

export default router;
