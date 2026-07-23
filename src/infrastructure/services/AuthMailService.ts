import prisma from '../database/prisma.client';
import { SmtpMailService } from './SmtpMailService';

const APP_URL = () => (process.env.OFFITEC_APP_URL || 'https://demo.offitec.ch').replace(/\/$/, '');

const smtp = new SmtpMailService();

/**
 * Sends the security mails of the auth flows (activation, password reset,
 * account deletion) through the tenant's configured SMTP settings. When the
 * tenant has no SMTP host configured, SmtpMailService runs in preview mode and
 * the mail is only logged — the API response never leaks whether a mail (or
 * account) exists.
 */
export class AuthMailService {
    private async send(tenantId: string, to: string, subject: string, bodyLines: string[]) {
        const settings = await prisma.mailSetting.findUnique({ where: { tenantId } });
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

    async sendActivationMail(tenantId: string, to: string, token: string) {
        await this.send(tenantId, to, 'OFFITEC ERP - Hesap Aktivasyonu', [
            'Hesabınızı etkinleştirmek için aşağıdaki bağlantıyı kullanın (24 saat geçerlidir):',
            `${APP_URL()}/activate-account?token=${encodeURIComponent(token)}`,
            'Bu isteği siz yapmadıysanız bu e-postayı yok sayabilirsiniz.',
        ]);
    }

    async sendPasswordResetMail(tenantId: string, to: string, token: string) {
        await this.send(tenantId, to, 'OFFITEC ERP - Parola Sıfırlama', [
            'Parolanızı sıfırlamak için aşağıdaki bağlantıyı kullanın (1 saat geçerlidir):',
            `${APP_URL()}/reset-password?token=${encodeURIComponent(token)}`,
            'Bu isteği siz yapmadıysanız parolanız değişmemiştir; bu e-postayı yok sayabilirsiniz.',
        ]);
    }

    async sendAccountDeletionMail(tenantId: string, to: string, token: string) {
        await this.send(tenantId, to, 'OFFITEC ERP - Hesap Silme Onayı', [
            'Hesabınızı silmek için aşağıdaki bağlantıyı kullanın (15 dakika geçerlidir):',
            `${APP_URL()}/confirm-account-deletion?token=${encodeURIComponent(token)}`,
            'Bu isteği siz yapmadıysanız lütfen sistem yöneticinize bildirin.',
        ]);
    }
}
