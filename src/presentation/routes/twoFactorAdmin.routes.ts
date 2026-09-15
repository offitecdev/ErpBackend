import { Router, type NextFunction, type Request, type Response } from 'express';
import prisma from '../../infrastructure/database/prisma.client';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { RoleRepository } from '../../infrastructure/repositories/RoleRepository';
import { revokeAllRefreshSessions } from '../../infrastructure/services/RefreshSessionService';
import { auditLog } from '../../infrastructure/services/AuditLogService';
import { employeeScopeWhere, getPersonnelTenantScope } from '../controllers/serviceTenantScope';

/* ── EINSTELLUNGEN → ZWEI-FAKTOR (AEGIS), 15.09.2026 ─────────────────────────
 *
 * Vorgabe Samet: «Einrichtung neu starten» als eigene Einstellung, die NICHT
 * jeder sieht — sie wird über die Rollentabelle vergeben (Seite
 * `settings.twoFactor` in shared/pageCatalog.ts):
 *
 *   Stufe 1 = ansehen    → `security.mfa.view`   (wer hat Aegis eingerichtet)
 *   Stufe 2 = bearbeiten → `security.mfa.reset`  (Einrichtung neu starten)
 *
 * Die Administratorrolle darf beides auch, BEVOR ensureSystemAdminRole die
 * neuen Rechtenamen in ihre Rolle geschrieben hat (das geschieht erst beim
 * nächsten Öffnen der Berechtigungen) — sonst stünde der Menüpunkt da und der
 * Server antwortete 403.
 *
 * «Neu starten» löscht die Verbindung zur App; der zweite Faktor entfällt
 * dadurch NICHT. Die Person wird bei der nächsten Anmeldung wieder durch die
 * Einrichtung geführt (stage 'enroll', siehe login-two-factor).
 */

export const MFA_VIEW_PERMISSION = 'security.mfa.view';
export const MFA_RESET_PERMISSION = 'security.mfa.reset';

const roleRepository = new RoleRepository();

const router = Router();

/** Recht ODER Administratorrolle. */
export const requireMfaAdmin = (permission: string) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const employeeId = req.user?.id;
            if (!employeeId) {
                res.status(401).json({ error: 'Anmeldung erforderlich.' });
                return;
            }
            const [permissions, roleInfo] = await Promise.all([
                roleRepository.getEmployeePermissions(employeeId),
                roleRepository.getEmployeeRoleInfo(employeeId),
            ]);
            if (roleInfo.isSystemAdmin || permissions.includes(permission)) {
                next();
                return;
            }
            res.status(403).json({ error: 'Zugriff verweigert.', requiredPermissions: [permission] });
        } catch (error: any) {
            console.error('[two-factor] Berechtigungsprüfung fehlgeschlagen:', error?.message || error);
            res.status(500).json({ error: 'Bei der Berechtigungsprüfung ist ein Fehler aufgetreten.' });
        }
    };

/**
 * Setzt den zweiten Faktor EINER Person zurück (Personalbereich der
 * ausgewählten Firma). `null` = nicht gefunden / ausserhalb des Bereichs.
 */
export const resetEmployeeTotp = async (req: Request, id: string): Promise<{ reset: boolean } | null> => {
    const scopeTenantIds = await getPersonnelTenantScope(req.user!.tenantId);
    const existing = await prisma.employee.findFirst({
        where: { id, ...employeeScopeWhere(scopeTenantIds) },
        select: { id: true, totpSecret: true, totpEnabledAt: true },
    });
    if (!existing) return null;
    if (!existing.totpEnabledAt && !existing.totpSecret) return { reset: false };

    /* Direkt über Prisma: die drei Spalten stehen bewusst nicht in der
       Schreibliste des Personalwegs — der zweite Faktor ist eine Zugangsangabe
       wie der QR-Schlüssel, kein Stammdatenfeld. */
    await prisma.employee.update({
        where: { id },
        data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null },
    });
    /* Die offenen Anmeldungen fallen mit: wer das Telefon verloren hat, will
       nicht, dass eine Sitzung von dort weiterläuft. */
    await revokeAllRefreshSessions(id, 'account').catch((error) =>
        console.error('[two-factor] Sitzungen konnten nicht beendet werden:', error?.message || error));
    auditLog.log({
        action: 'employee.mfa_reset',
        tenantId: req.user!.tenantId,
        employeeId: req.user!.id,
        entityType: 'Employee',
        entityId: id,
        ...auditLog.context(req),
    });
    return { reset: true };
};

/**
 * @swagger
 * /security/two-factor:
 *   get:
 *     tags: [Security]
 *     summary: "Personen mit ihrem Aegis-Stand (eingerichtet ja/nein)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/', requireAuth, requireMfaAdmin(MFA_VIEW_PERMISSION), async (req, res) => {
    try {
        const scopeTenantIds = await getPersonnelTenantScope(req.user!.tenantId);
        const rows = await prisma.employee.findMany({
            where: { ...employeeScopeWhere(scopeTenantIds), deletedAt: null },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                isActive: true,
                totpEnabledAt: true,
            },
            orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        });
        res.status(200).json(rows.map((row) => ({
            id: row.id,
            name: `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim(),
            email: row.email,
            isActive: row.isActive,
            enrolledAt: row.totpEnabledAt,
        })));
    } catch (error: any) {
        console.error('[two-factor/list]', error);
        res.status(500).json({ error: 'İşlem şu anda gerçekleştirilemiyor.' });
    }
});

/**
 * @swagger
 * /security/two-factor/{id}/reset:
 *   post:
 *     tags: [Security]
 *     summary: "Aegis-Einrichtung neu starten (Verbindung zur App löschen)"
 *     security:
 *       - bearerAuth: []
 */
router.post('/:id/reset', requireAuth, requireMfaAdmin(MFA_RESET_PERMISSION), async (req, res) => {
    try {
        const result = await resetEmployeeTotp(req, String(req.params.id || ''));
        if (!result) return res.status(404).json({ error: 'Personel bulunamadı.' });
        res.status(200).json(result);
    } catch (error: any) {
        console.error('[two-factor/reset]', error);
        res.status(400).json({ error: 'İşlem şu anda gerçekleştirilemiyor.' });
    }
});

export default router;
