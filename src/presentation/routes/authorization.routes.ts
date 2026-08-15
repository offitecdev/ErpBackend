import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import prisma from '../../infrastructure/database/prisma.client';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import { EmployeeRepository } from '../../infrastructure/repositories/EmployeeRepository';
import { RoleRepository } from '../../infrastructure/repositories/RoleRepository';
import { BcryptCryptoService } from '../../infrastructure/services/BcryptCryptoService';
import { assertPasswordPolicy } from '../../application/validation/password';
import { getCompanyTreeTenantIds } from '../controllers/serviceTenantScope';
import { findTenantRootIdCached } from '../../shared/tenantTree';
import { parseAllowedTenantIds } from '../utils/tenantAccess';
import { auditLog } from '../../infrastructure/services/AuditLogService';
import {
    deriveRoleName,
    levelsFromRole,
    packageKeysForLevels,
    permissionsForLevels,
    sanitizeModuleLevels,
} from '../../shared/authorizationLevels';
import type { AuthorizationLevel } from '../../shared/authorizationLevels';

/* Berechtigungsseite (Einstellungen → Berechtigungen): je Person die Zugangs-
   daten (E-Mail/Kennwort/Firmen) und je Modul eine Stufe (1 ansehen /
   2 bearbeiten / 3 löschen). Der Personentyp wird aus der Auswahl ABGELEITET.

   Persistenz läuft über das BESTEHENDE Rollenmodell, nicht daran vorbei:
   die Stufen ergeben eine Rechtemenge + ein Modulpaket, und dafür wird eine
   automatisch verwaltete, GETEILTE Rolle am Baum-Stamm gesucht oder angelegt
   (gleicher Name + gleiche Rechte + gleiches Paket → gleiche Rolle). Zwei
   Verkäufer mit identischen Stufen teilen sich also EINE Rolle — die
   Rollenliste wächst nur, wenn wirklich neue Kombinationen entstehen. */

const router = Router();

const employeeRepo = new EmployeeRepository();
const roleRepo = new RoleRepository();
const cryptoService = new BcryptCryptoService();

const setsEqual = (a: Set<string>, b: Set<string>): boolean =>
    a.size === b.size && [...a].every((value) => b.has(value));

/**
 * GET /employees/authorization/list?page=&pageSize= — die Personalliste der
 * Seite (15 je Seite): Name, E-Mail, abgeleitete Rolle, aktiv. Eine Anweisung
 * plus Zählung, Rolle per COALESCE wie überall.
 */
router.get('/authorization/list', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const treeTenantIds = await getCompanyTreeTenantIds(req.user!.tenantId);
        if (treeTenantIds.length === 0) return res.status(200).json({ data: [], total: 0, page: 1, pageSize: 15 });

        const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
        const pageSize = Math.min(50, Math.max(1, parseInt(String(req.query.pageSize || '15'), 10) || 15));
        const search = String(req.query.search || '').trim();

        const conditions: Prisma.Sql[] = [
            Prisma.sql`e.tenantId IN (${Prisma.join(treeTenantIds)})`,
            Prisma.sql`e.deletedAt IS NULL`,
        ];
        if (search) {
            const like = `%${search}%`;
            conditions.push(Prisma.sql`(e.firstName LIKE ${like} OR e.lastName LIKE ${like} OR e.email LIKE ${like})`);
        }
        const whereSql = Prisma.join(conditions, ' AND ');

        const [rows, countRows] = await Promise.all([
            prisma.$queryRaw<Array<Record<string, any>>>(Prisma.sql`
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
            prisma.$queryRaw<Array<{ total: bigint | number }>>(Prisma.sql`
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
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * GET /employees/:id/authorization — der Stand EINER Person für das Formular:
 * E-Mail, Firmen, Rollenname und die je Modul zurückgerechnete Stufe.
 */
router.get('/:id/authorization', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const id = String(req.params.id || '');
        const treeTenantIds = await getCompanyTreeTenantIds(req.user!.tenantId);
        const employee = await prisma.employee.findFirst({
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
        if (!employee) return res.status(404).json({ error: 'Personel bulunamadı.' });

        const role = employee.employeeRoles[0]?.role ?? null;
        const packageKeys = Array.isArray(role?.moduleConfigs?.[0]?.moduleKeys)
            ? (role!.moduleConfigs[0].moduleKeys as string[])
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
            moduleLevels: levelsFromRole(packageKeys, permissionNames),
        });
    } catch (error: any) {
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
router.put('/:id/authorization', requireAuth, requirePermission('roles.manage'), async (req, res) => {
    try {
        const user = req.user!;
        const id = String(req.params.id || '');
        const treeTenantIds = await getCompanyTreeTenantIds(user.tenantId);
        const employee = await prisma.employee.findFirst({
            where: { id, tenantId: { in: treeTenantIds }, deletedAt: null },
            select: { id: true, email: true },
        });
        if (!employee) return res.status(404).json({ error: 'Personel bulunamadı.' });

        const levels = sanitizeModuleLevels(req.body?.moduleLevels);
        const permissionNames = permissionsForLevels(levels);
        const roleName = deriveRoleName(levels);
        const packageKeys = packageKeysForLevels(levels);

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
            ? await prisma.permission.findMany({
                  where: { permissionName: { in: permissionNames } },
                  select: { id: true },
              })
            : [];
        const wantedPermissionIds = new Set(permissionRows.map((row) => row.id));

        // Passende verwaltete Rolle suchen: gleicher Name am Stamm, gleiche
        // Rechtemenge, gleiches Modulpaket.
        const rootId = (await findTenantRootIdCached(user.tenantId)) ?? user.tenantId;
        const candidates = await prisma.role.findMany({
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
            const candidatePackage = new Set(Array.isArray(config?.moduleKeys) ? (config!.moduleKeys as string[]) : []);
            return setsEqual(candidatePerms, wantedPermissionIds) && setsEqual(candidatePackage, wantedPackage);
        }) ?? null;

        if (!role) {
            const created = await prisma.role.create({
                data: {
                    id: nanoid(8),
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
        const patch: Record<string, unknown> = { roleName };
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
                const outside = wanted.filter((tenantId) => !treeTenantIds.includes(tenantId));
                if (outside.length) return res.status(400).json({ error: 'Seçilen şirketlerden biri bu şirket ağacına ait değil.' });
            }
            patch.allowedTenantIds = wanted;
        }
        await employeeRepo.update(id, patch as any);

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
            roleName,
            moduleLevels: levels as Record<string, AuthorizationLevel>,
        });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

export default router;
