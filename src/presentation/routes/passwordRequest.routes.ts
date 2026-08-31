import { Router } from 'express';
import { nanoid } from 'nanoid';
import prisma from '../../infrastructure/database/prisma.client';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requireAnyPermission, requirePermission } from '../middlewares/RbacMiddleware';
import { EmployeeRepository } from '../../infrastructure/repositories/EmployeeRepository';
import { RoleRepository } from '../../infrastructure/repositories/RoleRepository';
import { BcryptCryptoService } from '../../infrastructure/services/BcryptCryptoService';
import { assertPasswordPolicy } from '../../application/validation/password';
import { getPersonnelTenantScope } from '../controllers/serviceTenantScope';
import { auditLog } from '../../infrastructure/services/AuditLogService';

/* ── KENNWORTWUNSCH (17.08.2026) ─────────────────────────────────────────────
 *
 * Vorgabe: „Das Kennwort kann geändert werden, aber es braucht die Freigabe
 * einer verwaltenden Person." Also zwei Wege durch DIESELBE Maske:
 *
 *   • Wer verwaltet (roles.manage) → das Kennwort wird sofort gesetzt.
 *   • Alle anderen                 → es entsteht ein ANTRAG. Der Entwurf liegt
 *     bereits gehasht in der Zeile; Klartext wird nie gespeichert und ist nach
 *     dem Absenden auch dem Server nicht mehr bekannt. Erst die Freigabe
 *     schreibt den Hash auf das Konto.
 *
 * Das alte Kennwort muss in beiden Fällen stimmen — sonst könnte ein offen
 * gelassener Bildschirm zum Kontowechsel benutzt werden.
 */

const router = Router();

const employeeRepo = new EmployeeRepository();
const roleRepo = new RoleRepository();
const cryptoService = new BcryptCryptoService();

const requestSelect = {
    id: true,
    employeeId: true,
    status: true,
    note: true,
    createdAt: true,
    decidedAt: true,
    decisionNote: true,
    employee: { select: { id: true, firstName: true, lastName: true, email: true, staffNumber: true } },
    decidedBy: { select: { id: true, firstName: true, lastName: true } },
} as const;

const mapRequest = (row: any) => ({
    id: row.id,
    employeeId: row.employeeId,
    status: row.status,
    note: row.note ?? null,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt ?? null,
    decisionNote: row.decisionNote ?? null,
    employee: row.employee
        ? {
            id: row.employee.id,
            firstName: row.employee.firstName,
            lastName: row.employee.lastName,
            email: row.employee.email,
            staffNumber: row.employee.staffNumber ?? null,
        }
        : null,
    decidedBy: row.decidedBy
        ? { id: row.decidedBy.id, firstName: row.decidedBy.firstName, lastName: row.decidedBy.lastName }
        : null,
});

/** Trägt die anfragende Person die Verwaltung? Entscheidet den Weg unten. */
const callerManages = async (employeeId: string): Promise<boolean> =>
    (await roleRepo.getEmployeePermissions(employeeId)).includes('roles.manage');

/**
 * POST /password-requests — { currentPassword, newPassword, note? }
 * Antwort: { applied: true } (sofort gesetzt) oder { applied: false, request }.
 */
router.post('/', requireAuth, async (req, res) => {
    try {
        const user = req.user!;
        const currentPassword = String(req.body?.currentPassword || '');
        const newPassword = String(req.body?.newPassword || '');
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Bisheriges und neues Kennwort sind beide erforderlich.' });
        }
        assertPasswordPolicy(newPassword);

        const employee = await prisma.employee.findFirst({
            where: { id: user.id, deletedAt: null },
            select: { id: true, tenantId: true, passwordHash: true },
        });
        if (!employee) return res.status(404).json({ error: 'Person nicht gefunden.' });

        const ok = await cryptoService.comparePassword(currentPassword, employee.passwordHash);
        if (!ok) return res.status(400).json({ error: 'Das bisherige Kennwort stimmt nicht.' });
        if (await cryptoService.comparePassword(newPassword, employee.passwordHash)) {
            return res.status(400).json({ error: 'Das neue Kennwort ist mit dem bisherigen identisch.' });
        }

        const newPasswordHash = await cryptoService.hashPassword(newPassword);

        if (await callerManages(user.id)) {
            await employeeRepo.update(user.id, { passwordHash: newPasswordHash, passwordChangedAt: new Date() } as any);
            auditLog.log({
                action: 'password.change.self',
                tenantId: user.tenantId,
                employeeId: user.id,
                entityType: 'Employee',
                entityId: user.id,
                ...auditLog.context(req),
            });
            return res.status(200).json({ applied: true, request: null });
        }

        // Ein zweiter Antrag ersetzt den ersten — sonst stünden zwei Entwürfe
        // nebeneinander und die Freigabe wäre eine Ratesache.
        await (prisma as any).passwordChangeRequest.deleteMany({ where: { employeeId: user.id, status: 'PENDING' } });
        const created = await (prisma as any).passwordChangeRequest.create({
            data: {
                id: nanoid(12),
                tenantId: employee.tenantId,
                employeeId: user.id,
                newPasswordHash,
                status: 'PENDING',
                note: String(req.body?.note || '').trim() || null,
            },
            select: requestSelect,
        });

        auditLog.log({
            action: 'password.change.requested',
            tenantId: user.tenantId,
            employeeId: user.id,
            entityType: 'PasswordChangeRequest',
            entityId: created.id,
            ...auditLog.context(req),
        });

        res.status(201).json({ applied: false, request: mapRequest(created) });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/** GET /password-requests/mine — der eigene Stand (offen oder zuletzt entschieden). */
router.get('/mine', requireAuth, async (req, res) => {
    try {
        const rows = await (prisma as any).passwordChangeRequest.findMany({
            where: { employeeId: req.user!.id },
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: requestSelect,
        });
        res.status(200).json({ data: rows.map(mapRequest) });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/** GET /password-requests?status=PENDING — die Freigabeliste.
    SEIT DEM 27.08.2026 auch für die Projektleitung (Vorgabe: «Kennwörter
    ändern dürfen nur Projektleitung und Administrator»): `employees.update`
    genügt — das Recht trägt, wer die Personalliste auf Stufe «bearbeiten»
    führt. */
router.get('/', requireAuth, requireAnyPermission(['roles.manage', 'employees.update']), async (req, res) => {
    try {
        // Kennwortwünsche gehören der Firma, unter der sie gestellt wurden.
        const treeTenantIds = await getPersonnelTenantScope(req.user!.tenantId);
        const status = String(req.query.status || 'PENDING').toUpperCase();
        const rows = await (prisma as any).passwordChangeRequest.findMany({
            where: {
                tenantId: { in: treeTenantIds },
                ...(status === 'ALL' ? {} : { status }),
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
            select: requestSelect,
        });
        res.status(200).json({ data: rows.map(mapRequest) });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/** POST /password-requests/:id/decide — { approve, note? }. Entscheiden darf,
    wer Kennwörter führen darf: Administrator (roles.manage) und Projektleitung
    (employees.update). */
router.post('/:id/decide', requireAuth, requireAnyPermission(['roles.manage', 'employees.update']), async (req, res) => {
    try {
        const user = req.user!;
        const id = String(req.params.id || '');
        const approve = Boolean(req.body?.approve);
        const treeTenantIds = await getPersonnelTenantScope(user.tenantId);

        const request = await (prisma as any).passwordChangeRequest.findFirst({
            where: { id, tenantId: { in: treeTenantIds } },
            select: { id: true, employeeId: true, status: true, newPasswordHash: true },
        });
        if (!request) return res.status(404).json({ error: 'Antrag nicht gefunden.' });
        if (request.status !== 'PENDING') return res.status(400).json({ error: 'Dieser Antrag ist bereits entschieden.' });

        if (approve) {
            // Der Entwurf ist bereits ein Hash — er wandert unverändert auf das
            // Konto. `passwordChangedAt` macht jedes ältere Token ungültig.
            await employeeRepo.update(request.employeeId, {
                passwordHash: request.newPasswordHash,
                passwordChangedAt: new Date(),
            } as any);
        }

        const updated = await (prisma as any).passwordChangeRequest.update({
            where: { id },
            data: {
                status: approve ? 'APPROVED' : 'REJECTED',
                decidedAt: new Date(),
                decidedById: user.id,
                decisionNote: String(req.body?.note || '').trim() || null,
                // Der Entwurf hat seinen Zweck erfüllt; ein abgelehnter Hash
                // soll nicht in der Tabelle liegen bleiben.
                ...(approve ? {} : { newPasswordHash: '' }),
            },
            select: requestSelect,
        });

        auditLog.log({
            action: approve ? 'password.change.approved' : 'password.change.rejected',
            tenantId: user.tenantId,
            employeeId: user.id,
            entityType: 'PasswordChangeRequest',
            entityId: id,
            ...auditLog.context(req),
        });

        res.status(200).json({ request: mapRequest(updated) });
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

export default router;
