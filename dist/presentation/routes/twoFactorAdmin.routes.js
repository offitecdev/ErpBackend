"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetEmployeeTotp = exports.requireMfaAdmin = exports.MFA_RESET_PERMISSION = exports.MFA_VIEW_PERMISSION = void 0;
const express_1 = require("express");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
const RefreshSessionService_1 = require("../../infrastructure/services/RefreshSessionService");
const AuditLogService_1 = require("../../infrastructure/services/AuditLogService");
const serviceTenantScope_1 = require("../controllers/serviceTenantScope");
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
exports.MFA_VIEW_PERMISSION = 'security.mfa.view';
exports.MFA_RESET_PERMISSION = 'security.mfa.reset';
const roleRepository = new RoleRepository_1.RoleRepository();
const router = (0, express_1.Router)();
/** Recht ODER Administratorrolle. */
const requireMfaAdmin = (permission) => async (req, res, next) => {
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
    }
    catch (error) {
        console.error('[two-factor] Berechtigungsprüfung fehlgeschlagen:', error?.message || error);
        res.status(500).json({ error: 'Bei der Berechtigungsprüfung ist ein Fehler aufgetreten.' });
    }
};
exports.requireMfaAdmin = requireMfaAdmin;
/**
 * Setzt den zweiten Faktor EINER Person zurück (Personalbereich der
 * ausgewählten Firma). `null` = nicht gefunden / ausserhalb des Bereichs.
 */
const resetEmployeeTotp = async (req, id) => {
    const scopeTenantIds = await (0, serviceTenantScope_1.getPersonnelTenantScope)(req.user.tenantId);
    const existing = await prisma_client_1.default.employee.findFirst({
        where: { id, ...(0, serviceTenantScope_1.employeeScopeWhere)(scopeTenantIds) },
        select: { id: true, totpSecret: true, totpEnabledAt: true },
    });
    if (!existing)
        return null;
    if (!existing.totpEnabledAt && !existing.totpSecret)
        return { reset: false };
    /* Direkt über Prisma: die drei Spalten stehen bewusst nicht in der
       Schreibliste des Personalwegs — der zweite Faktor ist eine Zugangsangabe
       wie der QR-Schlüssel, kein Stammdatenfeld. */
    await prisma_client_1.default.employee.update({
        where: { id },
        data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null },
    });
    /* Die offenen Anmeldungen fallen mit: wer das Telefon verloren hat, will
       nicht, dass eine Sitzung von dort weiterläuft. */
    await (0, RefreshSessionService_1.revokeAllRefreshSessions)(id, 'account').catch((error) => console.error('[two-factor] Sitzungen konnten nicht beendet werden:', error?.message || error));
    AuditLogService_1.auditLog.log({
        action: 'employee.mfa_reset',
        tenantId: req.user.tenantId,
        employeeId: req.user.id,
        entityType: 'Employee',
        entityId: id,
        ...AuditLogService_1.auditLog.context(req),
    });
    return { reset: true };
};
exports.resetEmployeeTotp = resetEmployeeTotp;
/**
 * @swagger
 * /security/two-factor:
 *   get:
 *     tags: [Security]
 *     summary: "Personen mit ihrem Aegis-Stand (eingerichtet ja/nein)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/', AuthMiddleware_1.requireAuth, (0, exports.requireMfaAdmin)(exports.MFA_VIEW_PERMISSION), async (req, res) => {
    try {
        const scopeTenantIds = await (0, serviceTenantScope_1.getPersonnelTenantScope)(req.user.tenantId);
        const rows = await prisma_client_1.default.employee.findMany({
            where: { ...(0, serviceTenantScope_1.employeeScopeWhere)(scopeTenantIds), deletedAt: null },
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
    }
    catch (error) {
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
router.post('/:id/reset', AuthMiddleware_1.requireAuth, (0, exports.requireMfaAdmin)(exports.MFA_RESET_PERMISSION), async (req, res) => {
    try {
        const result = await (0, exports.resetEmployeeTotp)(req, String(req.params.id || ''));
        if (!result)
            return res.status(404).json({ error: 'Personel bulunamadı.' });
        res.status(200).json(result);
    }
    catch (error) {
        console.error('[two-factor/reset]', error);
        res.status(400).json({ error: 'İşlem şu anda gerçekleştirilemiyor.' });
    }
});
exports.default = router;
//# sourceMappingURL=twoFactorAdmin.routes.js.map