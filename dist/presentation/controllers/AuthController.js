"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthController = void 0;
const authCookies_1 = require("../utils/authCookies");
const AuditLogService_1 = require("../../infrastructure/services/AuditLogService");
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
    constructor(loginUseCase, getUserPermissionsUseCase, getMeUseCase, refreshTokenUseCase, requestAccountActivationUseCase, activateAccountUseCase, requestPasswordResetUseCase, resetPasswordUseCase, requestAccountDeletionUseCase, confirmAccountDeletionUseCase) {
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
    }
    async login(req, res) {
        const { email, password } = req.body;
        try {
            const result = await this.loginUseCase.execute(email, password);
            // Tokens travel only as HttpOnly cookies — never in the JSON body,
            // so XSS can't exfiltrate them.
            (0, authCookies_1.setAuthCookies)(res, { accessToken: result.accessToken, refreshToken: result.refreshToken });
            AuditLogService_1.auditLog.log({
                action: 'auth.login.success',
                tenantId: result.employee.tenantId,
                employeeId: result.employee.id,
                entityType: 'Employee',
                entityId: result.employee.id,
                ...AuditLogService_1.auditLog.context(req),
            });
            res.status(200).json({ employee: result.employee });
        }
        catch (error) {
            AuditLogService_1.auditLog.log({
                action: 'auth.login.failed',
                metadata: { email: String(email || '') },
                ...AuditLogService_1.auditLog.context(req),
            });
            res.status(400).json({ error: error.message });
        }
    }
    async refresh(req, res) {
        try {
            const refreshToken = String(req.cookies?.[authCookies_1.REFRESH_COOKIE] || '');
            if (!refreshToken) {
                (0, authCookies_1.clearAuthCookies)(res);
                return res.status(401).json({ error: 'Oturum bulunamadı. Lütfen giriş yapın.' });
            }
            const result = await this.refreshTokenUseCase.execute(refreshToken);
            (0, authCookies_1.setAuthCookies)(res, { accessToken: result.accessToken, refreshToken: result.refreshToken });
            res.status(200).json({ message: 'Token yenilendi.' });
        }
        catch (error) {
            // Invalid session → the server clears the cookies itself.
            (0, authCookies_1.clearAuthCookies)(res);
            res.status(401).json({ error: error.message });
        }
    }
    async logout(req, res) {
        // Stateless JWTs: logout = the server clearing its HttpOnly cookies.
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
            res.status(400).json({ error: error.message });
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
            res.status(400).json({ error: error.message });
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
            res.status(400).json({ error: error.message });
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
            res.status(400).json({ error: error.message });
        }
    }
    async getPermissions(req, res) {
        try {
            const employeeId = req.user?.id;
            if (!employeeId) {
                return res.status(401).json({ error: 'Yetkisiz erişim.' });
            }
            const permissions = await this.getUserPermissionsUseCase.execute(employeeId);
            res.status(200).json({ permissions });
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
    async getMe(req, res) {
        try {
            const employeId = req.user?.id;
            if (!employeId) {
                return res.status(401).json({ error: 'Yetkisiz erişim.' });
            }
            const employee = await this.getMeUseCase.execute(employeId);
            return res.status(200).json(employee);
        }
        catch (error) {
            res.status(500).json({ error: error.message });
        }
    }
}
exports.AuthController = AuthController;
//# sourceMappingURL=AuthController.js.map