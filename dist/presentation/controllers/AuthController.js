"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const MfaUseCases_1 = require("../../application/use-cases/auth/MfaUseCases");
const authCookies_1 = require("../utils/authCookies");
const AuditLogService_1 = require("../../infrastructure/services/AuditLogService");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const client_1 = require("@prisma/client");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
const JwtTokenService_1 = require("../../infrastructure/services/JwtTokenService");
const RefreshSessionService_1 = require("../../infrastructure/services/RefreshSessionService");
const AuthErrors_1 = require("../../application/errors/AuthErrors");
const pageCatalog_1 = require("../../shared/pageCatalog");
/** Seitenstufen hängen an derselben Rollenzeile wie die Rechte; der Zugriff
    läuft über dieselbe zwischenspeichernde Ablage (siehe RoleRepository). */
const roleRepositoryForPages = new RoleRepository_1.RoleRepository();
class AuthController {
    loginUseCase;
    getUserPermissionsUseCase;
    getMeUseCase;
    refreshTokenUseCase;
    requestAccountActivationUseCase;
    activateAccountUseCase;
    requestPasswordResetUseCase;
    resetPasswordUseCase;
    requestAccountDeletionUseCase;
    confirmAccountDeletionUseCase;
    qrLoginUseCase;
    verifyMfaCodeUseCase;
    constructor(loginUseCase, getUserPermissionsUseCase, getMeUseCase, refreshTokenUseCase, requestAccountActivationUseCase, activateAccountUseCase, requestPasswordResetUseCase, resetPasswordUseCase, requestAccountDeletionUseCase, confirmAccountDeletionUseCase, qrLoginUseCase, verifyMfaCodeUseCase) {
        this.loginUseCase = loginUseCase;
        this.getUserPermissionsUseCase = getUserPermissionsUseCase;
        this.getMeUseCase = getMeUseCase;
        this.refreshTokenUseCase = refreshTokenUseCase;
        this.requestAccountActivationUseCase = requestAccountActivationUseCase;
        this.activateAccountUseCase = activateAccountUseCase;
        this.requestPasswordResetUseCase = requestPasswordResetUseCase;
        this.resetPasswordUseCase = resetPasswordUseCase;
        this.requestAccountDeletionUseCase = requestAccountDeletionUseCase;
        this.confirmAccountDeletionUseCase = confirmAccountDeletionUseCase;
        this.qrLoginUseCase = qrLoginUseCase;
        this.verifyMfaCodeUseCase = verifyMfaCodeUseCase;
    }
    /** Woher die Anmeldung kam — steht in der Sitzungszeile, damit man eine
        fremde Sitzung an Adresse und Browser erkennt. */
    sessionContext(req) {
        const context = AuditLogService_1.auditLog.context(req);
        return { ipAddress: context.ipAddress, userAgent: context.userAgent };
    }
    /** Anmeldung mit dem Personal-QR-Code (siehe QrLoginUseCase). */
    async qrLogin(req, res) {
        try {
            const result = await this.qrLoginUseCase.execute(String(req.body?.token ?? ''), this.sessionContext(req));
            (0, authCookies_1.setAuthCookies)(res, { accessToken: result.accessToken, refreshToken: result.refreshToken });
            AuditLogService_1.auditLog.log({
                action: 'auth.qrLogin.success',
                tenantId: result.employee.tenantId,
                employeeId: result.employee.id,
                entityType: 'Employee',
                entityId: result.employee.id,
                ...AuditLogService_1.auditLog.context(req),
            });
            res.status(200).json({ employee: result.employee });
        }
        catch (error) {
            // Der Code selbst wird NICHT protokolliert — er ist ein Geheimnis.
            AuditLogService_1.auditLog.log({ action: 'auth.qrLogin.failed', ...AuditLogService_1.auditLog.context(req) });
            res.status(400).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'auth.qrLogin') });
        }
    }
    /**
     * ERSTE HÄLFTE der Anmeldung: E-Mail und Kennwort.
     *
     * Die Antwort ist bewusst KEINE Sitzung mehr, sondern die Aufforderung zum
     * zweiten Faktor (siehe MfaUseCases). Das Zwischentoken geht als HttpOnly-
     * Keks hinaus — im Körper steht nur, WAS die Oberfläche jetzt zeigen soll:
     * das Codefeld, und bei der ersten Anmeldung zusätzlich das QR-Bild zum
     * Einrichten.
     */
    async login(req, res) {
        const { email, password } = req.body;
        try {
            const challenge = await this.loginUseCase.execute(email, password, this.sessionContext(req));
            (0, authCookies_1.setMfaCookie)(res, challenge.challengeToken);
            AuditLogService_1.auditLog.log({
                action: challenge.stage === 'enroll' ? 'auth.login.password_ok.enroll' : 'auth.login.password_ok',
                metadata: { email: String(email || '') },
                ...AuditLogService_1.auditLog.context(req),
            });
            // Das Zwischentoken selbst bleibt im Keks — hier steht nur, was auf
            // den Bildschirm gehört. Bei `enroll` gehört das vorgeschlagene
            // Geheimnis ausdrücklich dazu: es soll ja gescannt werden.
            res.status(200).json({
                mfaRequired: true,
                stage: challenge.stage,
                issuer: challenge.issuer,
                account: challenge.account,
                digits: challenge.digits,
                periodSeconds: challenge.periodSeconds,
                setup: challenge.setup,
            });
        }
        catch (error) {
            // Ein misslungener Anlauf darf keinen alten Zwischenkeks stehen
            // lassen — sonst hinge an der Anmeldeseite die halbe Anmeldung von
            // vorhin.
            (0, authCookies_1.clearMfaCookie)(res);
            AuditLogService_1.auditLog.log({
                action: 'auth.login.failed',
                metadata: { email: String(email || '') },
                ...AuditLogService_1.auditLog.context(req),
            });
            // Kontosperre (loginThrottle) ist kein Anmeldefehler, sondern ein
            // "zu viel" — eigener Statuscode, damit die Oberfläche es als
            // Wartezeit zeigen kann und nicht als falsches Kennwort.
            if (error instanceof AuthErrors_1.TooManyAttemptsError) {
                res.setHeader('Retry-After', String(error.retryAfterSeconds));
                return res.status(429).json({ error: error.message });
            }
            res.status(400).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'auth.login') });
        }
    }
    /**
     * ZWEITE HÄLFTE der Anmeldung: der sechsstellige Code aus der
     * Authenticator-App. Stimmt er, entstehen hier die Sitzungskeks — vorher
     * gibt es keine Sitzung.
     */
    async verifyMfa(req, res) {
        const challengeToken = String(req.cookies?.[authCookies_1.MFA_COOKIE] || '');
        try {
            const result = await this.verifyMfaCodeUseCase.execute(challengeToken, String(req.body?.code ?? ''), this.sessionContext(req));
            // setAuthCookies räumt den Zwischenkeks selbst weg.
            (0, authCookies_1.setAuthCookies)(res, { accessToken: result.accessToken, refreshToken: result.refreshToken });
            if (result.enrolled) {
                AuditLogService_1.auditLog.log({
                    action: 'auth.mfa.enrolled',
                    tenantId: result.employee.tenantId,
                    employeeId: result.employee.id,
                    entityType: 'Employee',
                    entityId: result.employee.id,
                    ...AuditLogService_1.auditLog.context(req),
                });
            }
            AuditLogService_1.auditLog.log({
                action: 'auth.login.success',
                tenantId: result.employee.tenantId,
                employeeId: result.employee.id,
                entityType: 'Employee',
                entityId: result.employee.id,
                ...AuditLogService_1.auditLog.context(req),
            });
            res.status(200).json({ employee: result.employee, enrolled: result.enrolled });
        }
        catch (error) {
            // Der eingegebene Code wird NICHT protokolliert — er ist eine
            // Zugangsangabe, wie das Kennwort und der QR-Schlüssel.
            AuditLogService_1.auditLog.log({ action: 'auth.mfa.failed', ...AuditLogService_1.auditLog.context(req) });
            if (error instanceof AuthErrors_1.TooManyAttemptsError) {
                res.setHeader('Retry-After', String(error.retryAfterSeconds));
                return res.status(429).json({ error: error.message, code: 'mfa_too_many_attempts' });
            }
            /* Ein falscher Code lässt die halbe Anmeldung STEHEN (man tippt sich
               vertippt), alles andere — abgelaufen, Konto gesperrt, Kennwort
               gewechselt — fängt von vorne an. Der Keks fällt entsprechend. */
            const code = error instanceof MfaUseCases_1.MfaError ? error.code : undefined;
            const retryable = code === 'mfa_code_invalid' || code === 'mfa_code_reused';
            if (!retryable)
                (0, authCookies_1.clearMfaCookie)(res);
            res.status(retryable ? 400 : 401).json({
                error: (0, AuthErrors_1.toPublicMessage)(error, 'auth.mfa.verify', 'Oturum geçersiz. Lütfen tekrar giriş yapın.'),
                code: code ?? 'mfa_challenge_expired',
            });
        }
    }
    async refresh(req, res) {
        try {
            const refreshToken = String(req.cookies?.[authCookies_1.REFRESH_COOKIE] || '');
            if (!refreshToken) {
                (0, authCookies_1.clearAuthCookies)(res);
                return res.status(401).json({ error: 'Oturum bulunamadı. Lütfen giriş yapın.' });
            }
            const result = await this.refreshTokenUseCase.execute(refreshToken, this.sessionContext(req));
            (0, authCookies_1.setAuthCookies)(res, { accessToken: result.accessToken, refreshToken: result.refreshToken });
            res.status(200).json({ message: 'Token yenilendi.' });
        }
        catch (error) {
            // Invalid session → the server clears the cookies itself.
            (0, authCookies_1.clearAuthCookies)(res);
            res.status(401).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'auth.refresh', 'Oturum geçersiz. Lütfen tekrar giriş yapın.') });
        }
    }
    /**
     * Abmelden beendet die Anmeldung WIRKLICH.
     *
     * Vorher wurden nur die Keks gelöscht — das Erneuerungstoken blieb bis zu
     * 30 Tage gültig, und wer es in der Hand hatte, war nach dem "Abmelden"
     * unverändert angemeldet. Jetzt fällt die ganze Familie (alle Zeilen dieser
     * Anmeldung, siehe RefreshSessionService).
     *
     * Ein unlesbares oder abgelaufenes Token ist kein Fehler: die Keks werden
     * in jedem Fall gelöscht und die Antwort bleibt 200 — Abmelden darf nie
     * scheitern.
     */
    async logout(req, res) {
        const refreshToken = String(req.cookies?.[authCookies_1.REFRESH_COOKIE] || '');
        if (refreshToken) {
            try {
                const decoded = JwtTokenService_1.jwtTokenService.verifyToken('refresh', refreshToken);
                if (decoded.sid)
                    await (0, RefreshSessionService_1.revokeRefreshFamily)(decoded.sid, 'logout');
            }
            catch {
                // Nicht mehr lesbar (abgelaufen, alt, verfälscht): dann gibt es
                // auch nichts zu entwerten.
            }
        }
        (0, authCookies_1.clearAuthCookies)(res);
        AuditLogService_1.auditLog.log({ action: 'auth.logout', ...AuditLogService_1.auditLog.context(req) });
        res.status(200).json({ message: 'Çıkış yapıldı.' });
    }
    async requestActivation(req, res) {
        try {
            const email = String(req.body?.email || '').trim();
            if (!email)
                return res.status(400).json({ error: 'E-posta zorunludur.' });
            await this.requestAccountActivationUseCase.execute(email);
            // Always the same answer — no account enumeration.
            res.status(200).json({ message: 'Hesap mevcutsa aktivasyon bağlantısı e-posta ile gönderildi.' });
        }
        catch (error) {
            res.status(500).json({ error: 'İşlem şu anda gerçekleştirilemiyor.' });
        }
    }
    async activate(req, res) {
        try {
            const token = String(req.body?.token || '');
            if (!token)
                return res.status(400).json({ error: 'Token zorunludur.' });
            await this.activateAccountUseCase.execute(token);
            AuditLogService_1.auditLog.log({ action: 'auth.activation.confirm', ...AuditLogService_1.auditLog.context(req) });
            res.status(200).json({ message: 'Hesabınız etkinleştirildi. Giriş yapabilirsiniz.' });
        }
        catch (error) {
            res.status(400).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'auth.activation.confirm') });
        }
    }
    async requestPasswordReset(req, res) {
        try {
            const email = String(req.body?.email || '').trim();
            if (!email)
                return res.status(400).json({ error: 'E-posta zorunludur.' });
            await this.requestPasswordResetUseCase.execute(email);
            // Always the same answer — no account enumeration.
            res.status(200).json({ message: 'Hesap mevcutsa parola sıfırlama bağlantısı e-posta ile gönderildi.' });
        }
        catch (error) {
            res.status(500).json({ error: 'İşlem şu anda gerçekleştirilemiyor.' });
        }
    }
    async resetPassword(req, res) {
        try {
            const token = String(req.body?.token || '');
            const newPassword = String(req.body?.newPassword || '');
            if (!token)
                return res.status(400).json({ error: 'Token zorunludur.' });
            await this.resetPasswordUseCase.execute(token, newPassword);
            AuditLogService_1.auditLog.log({ action: 'auth.password_reset.confirm', ...AuditLogService_1.auditLog.context(req) });
            res.status(200).json({ message: 'Parolanız güncellendi. Yeni parolanızla giriş yapabilirsiniz.' });
        }
        catch (error) {
            res.status(400).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'auth.password_reset.confirm') });
        }
    }
    async requestAccountDeletion(req, res) {
        try {
            const employeeId = req.user?.id;
            if (!employeeId)
                return res.status(401).json({ error: 'Yetkisiz erişim.' });
            await this.requestAccountDeletionUseCase.execute(employeeId);
            AuditLogService_1.auditLog.log({
                action: 'auth.account_deletion.request',
                tenantId: req.user.tenantId,
                employeeId,
                entityType: 'Employee',
                entityId: employeeId,
                ...AuditLogService_1.auditLog.context(req),
            });
            res.status(200).json({ message: 'Hesap silme onay bağlantısı e-posta adresinize gönderildi.' });
        }
        catch (error) {
            res.status(400).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'auth.account_deletion.request') });
        }
    }
    async confirmAccountDeletion(req, res) {
        try {
            const token = String(req.body?.token || '');
            if (!token)
                return res.status(400).json({ error: 'Token zorunludur.' });
            await this.confirmAccountDeletionUseCase.execute(token);
            (0, authCookies_1.clearAuthCookies)(res);
            AuditLogService_1.auditLog.log({ action: 'auth.account_deletion.confirm', ...AuditLogService_1.auditLog.context(req) });
            res.status(200).json({ message: 'Hesabınız silindi.' });
        }
        catch (error) {
            res.status(400).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'auth.account_deletion.confirm') });
        }
    }
    async getPermissions(req, res) {
        try {
            const employeeId = req.user?.id;
            if (!employeeId) {
                return res.status(401).json({ error: 'Yetkisiz erişim.' });
            }
            // `pageAccess` (17.08.2026): die Stufe je SEITE aus der Rolle —
            // Menü und Seitenwächter im Browser lesen daraus, welche Seiten
            // diese Person überhaupt öffnen darf. Die flachen `permissions`
            // bleiben daneben stehen: sie regeln, was INNERHALB einer Seite
            // geht, und sind weiterhin das, was der Server prüft.
            // Beide kommen aus demselben Cache — kein zweiter Rundgang.
            const [permissions, roleInfo] = await Promise.all([
                this.getUserPermissionsUseCase.execute(employeeId),
                roleRepositoryForPages.getEmployeeRoleInfo(employeeId),
            ]);
            // `isSystemAdmin` = Administratorrolle. Nur die Anzeige hängt daran
            // (gefährliche Aktionen fragen jedes ANDERE Konto nach dem
            // Kennwort); geprüft wird die Rolle beim Aufruf erneut am Server.
            res.status(200).json({
                permissions,
                pageAccess: roleInfo.pageAccess,
                isSystemAdmin: roleInfo.isSystemAdmin,
            });
        }
        catch (error) {
            res.status(500).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'auth.permissions') });
        }
    }
    async getMe(req, res) {
        try {
            const employeId = req.user?.id;
            if (!employeId) {
                return res.status(401).json({ error: 'Yetkisiz erişim.' });
            }
            // One remote database round-trip replaces Employee + EmployeeRole
            // + Role + RoleModuleConfig reads that previously ran sequentially.
            const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT
                    employee.id,
                    employee.tenantId,
                    employee.firstName,
                    employee.lastName,
                    employee.email,
                    employee.roleName,
                    role.id AS roleId,
                    role.roleName AS assignedRoleName,
                    role.isSystemAdmin AS isSystemAdmin,
                    config.tenantId AS configTenantId,
                    config.moduleKeys
                FROM Employee AS employee
                LEFT JOIN EmployeeRole AS employeeRole ON employeeRole.employeeId = employee.id
                LEFT JOIN Role AS role ON role.id = employeeRole.roleId
                LEFT JOIN RoleModuleConfig AS config ON config.roleId = role.id
                WHERE employee.id = ${employeId}
            `);
            const employee = rows[0];
            if (!employee)
                return res.status(404).json({ error: 'Kullanıcı bulunamadı.' });
            const roleById = new Map();
            for (const row of rows) {
                if (row.roleId && row.assignedRoleName) {
                    roleById.set(row.roleId, { id: row.roleId, roleName: row.assignedRoleName });
                }
            }
            const roleIds = [...roleById.keys()];
            const roleModuleKeysByTenant = {};
            if (roleIds.length) {
                const rowsByTenant = new Map();
                for (const row of rows) {
                    if (!row.configTenantId)
                        continue;
                    const tenantRows = rowsByTenant.get(row.configTenantId) || [];
                    tenantRows.push(row);
                    rowsByTenant.set(row.configTenantId, tenantRows);
                }
                for (const [tenantId, tenantRows] of rowsByTenant) {
                    const coveredRoles = new Set(tenantRows.map((row) => row.roleId).filter(Boolean));
                    if (coveredRoles.size < roleIds.length)
                        continue;
                    // ADMINISTRATOR SIEHT JEDES MODUL DES KATALOGS — auch eines, das
                    // nach dem letzten Speichern der Rolle dazugekommen ist. Sonst
                    // haengt ein neues Modul (Produktion, 19.09.2026) unsichtbar in
                    // einem alten `RoleModuleConfig`-Paket fest, bis jemand die
                    // Berechtigungsseite oeffnet — `ensureSystemAdminRole` zieht das
                    // Paket erst dort nach. Die Firmenkategorie schraenkt weiter ein:
                    // das Menue zeigt Kategorie ∩ Paket.
                    if (tenantRows.some((row) => Boolean(row.isSystemAdmin))) {
                        roleModuleKeysByTenant[tenantId] = (0, pageCatalog_1.adminModuleKeys)();
                        continue;
                    }
                    roleModuleKeysByTenant[tenantId] = [...new Set(tenantRows.flatMap((row) => {
                            if (Array.isArray(row.moduleKeys))
                                return row.moduleKeys.map(String);
                            if (typeof row.moduleKeys !== 'string')
                                return [];
                            try {
                                const parsed = JSON.parse(row.moduleKeys);
                                return Array.isArray(parsed) ? parsed.map(String) : [];
                            }
                            catch {
                                return [];
                            }
                        }))];
                }
            }
            return res.status(200).json({
                id: employee.id,
                tenantId: employee.tenantId,
                firstName: employee.firstName,
                lastName: employee.lastName,
                email: employee.email,
                roleName: roleById.values().next().value?.roleName ?? employee.roleName,
                employeeRoles: [...roleById.values()].map((role) => ({ role })),
                roleModuleKeysByTenant,
            });
        }
        catch (error) {
            res.status(500).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'auth.me') });
        }
    }
}
exports.AuthController = AuthController;
//# sourceMappingURL=AuthController.js.map