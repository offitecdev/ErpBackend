"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthMailService = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const SmtpMailService_1 = require("./SmtpMailService");
const APP_URL = () => (process.env.OFFITEC_APP_URL || 'https://demo.offitec.ch').replace(/\/$/, '');
const smtp = new SmtpMailService_1.SmtpMailService();
/**
 * Sends the security mails of the auth flows (activation, password reset,
 * account deletion) through the tenant's configured SMTP settings. When the
 * tenant has no SMTP host configured, SmtpMailService runs in preview mode and
 * the mail is only logged — the API response never leaks whether a mail (or
 * account) exists.
 */
class AuthMailService {
    async send(tenantId, to, subject, bodyLines) {
        const settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId } });
        const fromEmail = settings?.fromEmail || 'no-reply@offitec.ch';
        const text = bodyLines.join('\n');
        const html = bodyLines.map((line) => `<p>${line}</p>`).join('');
        const result = await smtp.send(settings || {}, {
            fromEmail,
            fromName: settings?.fromName || 'OFFITEC ERP',
            to,
            subject,
            text,
            html,
        });
        if (result.preview) {
            console.log(`[AuthMail:preview] to=${to} subject="${subject}"\n${text}`);
        }
    }
    async sendActivationMail(tenantId, to, token) {
        await this.send(tenantId, to, 'OFFITEC ERP - Hesap Aktivasyonu', [
            'Hesabınızı etkinleştirmek için aşağıdaki bağlantıyı kullanın (24 saat geçerlidir):',
            `${APP_URL()}/activate-account?token=${encodeURIComponent(token)}`,
            'Bu isteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz.',
        ]);
    }
    async sendPasswordResetMail(tenantId, to, token) {
        await this.send(tenantId, to, 'OFFITEC ERP - Parola Sıfırlama', [
            'Parolanızı sıfırlamak için aşağıdaki bağlantıyı kullanın (1 saat geçerlidir):',
            `${APP_URL()}/reset-password?token=${encodeURIComponent(token)}`,
            'Bu isteği siz yapmadıysanız parolanız değişmemiştir; bu e-postayı yok sayabilirsiniz.',
        ]);
    }
    async sendAccountDeletionMail(tenantId, to, token) {
        await this.send(tenantId, to, 'OFFITEC ERP - Hesap Silme Onayı', [
            'Hesabınızı silmek için aşağıdaki bağlantıyı kullanın (15 dakika geçerlidir):',
            `${APP_URL()}/confirm-account-deletion?token=${encodeURIComponent(token)}`,
            'Bu isteği siz yapmadıysanız lütfen sistem yöneticinize bildirin.',
        ]);
    }
}
exports.AuthMailService = AuthMailService;
//# sourceMappingURL=AuthMailService.js.map