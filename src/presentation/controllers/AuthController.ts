import {Request , Response} from "express";
import {LoginUseCase} from "../../application/use-cases/auth/LoginUseCase";
import { GetUserPermissionsUseCase } from "../../application/use-cases/auth/GetUserPermissionsUseCase";
import { GetMeUseCase } from "../../application/use-cases/auth/GetMeUseCase";
import { RefreshTokenUseCase } from "../../application/use-cases/auth/RefreshTokenUseCase";
import { RequestAccountActivationUseCase, ActivateAccountUseCase } from "../../application/use-cases/auth/AccountActivationUseCases";
import { RequestPasswordResetUseCase, ResetPasswordUseCase } from "../../application/use-cases/auth/PasswordResetUseCases";
import { RequestAccountDeletionUseCase, ConfirmAccountDeletionUseCase } from "../../application/use-cases/auth/AccountDeletionUseCases";
import { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } from "../utils/authCookies";
import { auditLog } from "../../infrastructure/services/AuditLogService";

export class AuthController {
    constructor(
        private loginUseCase: LoginUseCase,
        private getUserPermissionsUseCase: GetUserPermissionsUseCase,
        private getMeUseCase: GetMeUseCase,
        private refreshTokenUseCase: RefreshTokenUseCase,
        private requestAccountActivationUseCase: RequestAccountActivationUseCase,
        private activateAccountUseCase: ActivateAccountUseCase,
        private requestPasswordResetUseCase: RequestPasswordResetUseCase,
        private resetPasswordUseCase: ResetPasswordUseCase,
        private requestAccountDeletionUseCase: RequestAccountDeletionUseCase,
        private confirmAccountDeletionUseCase: ConfirmAccountDeletionUseCase,
    ){}

    async login(req:Request , res:Response){
        const {email,password} = req.body;
        try{
            const result = await this.loginUseCase.execute(email,password);
            // Tokens travel only as HttpOnly cookies — never in the JSON body,
            // so XSS can't exfiltrate them.
            setAuthCookies(res, { accessToken: result.accessToken, refreshToken: result.refreshToken });
            auditLog.log({
                action: 'auth.login.success',
                tenantId: result.employee.tenantId,
                employeeId: result.employee.id,
                entityType: 'Employee',
                entityId: result.employee.id,
                ...auditLog.context(req),
            });
            res.status(200).json({ employee: result.employee });
        }catch(error:any){
            auditLog.log({
                action: 'auth.login.failed',
                metadata: { email: String(email || '') },
                ...auditLog.context(req),
            });
            res.status(400).json({error:error.message});
        }
    }

    async refresh(req:Request , res:Response){
        try{
            const refreshToken = String(req.cookies?.[REFRESH_COOKIE] || '');
            if (!refreshToken) {
                clearAuthCookies(res);
                return res.status(401).json({ error: 'Oturum bulunamadı. Lütfen giriş yapın.' });
            }
            const result = await this.refreshTokenUseCase.execute(refreshToken);
            setAuthCookies(res, { accessToken: result.accessToken, refreshToken: result.refreshToken });
            res.status(200).json({ message: 'Token yenilendi.' });
        }catch(error:any){
            // Invalid session → the server clears the cookies itself.
            clearAuthCookies(res);
            res.status(401).json({error:error.message});
        }
    }

    async logout(req:Request , res:Response){
        // Stateless JWTs: logout = the server clearing its HttpOnly cookies.
        clearAuthCookies(res);
        auditLog.log({ action: 'auth.logout', ...auditLog.context(req) });
        res.status(200).json({ message: 'Çıkış yapıldı.' });
    }

    async requestActivation(req:Request , res:Response){
        try{
            const email = String(req.body?.email || '').trim();
            if (!email) return res.status(400).json({ error: 'E-posta zorunludur.' });
            await this.requestAccountActivationUseCase.execute(email);
            // Always the same answer — no account enumeration.
            res.status(200).json({ message: 'Hesap mevcutsa aktivasyon bağlantısı e-posta ile gönderildi.' });
        }catch(error:any){
            res.status(500).json({error: 'İşlem şu anda gerçekleştirilemiyor.'});
        }
    }

    async activate(req:Request , res:Response){
        try{
            const token = String(req.body?.token || '');
            if (!token) return res.status(400).json({ error: 'Token zorunludur.' });
            await this.activateAccountUseCase.execute(token);
            auditLog.log({ action: 'auth.activation.confirm', ...auditLog.context(req) });
            res.status(200).json({ message: 'Hesabınız etkinleştirildi. Giriş yapabilirsiniz.' });
        }catch(error:any){
            res.status(400).json({error:error.message});
        }
    }

    async requestPasswordReset(req:Request , res:Response){
        try{
            const email = String(req.body?.email || '').trim();
            if (!email) return res.status(400).json({ error: 'E-posta zorunludur.' });
            await this.requestPasswordResetUseCase.execute(email);
            // Always the same answer — no account enumeration.
            res.status(200).json({ message: 'Hesap mevcutsa parola sıfırlama bağlantısı e-posta ile gönderildi.' });
        }catch(error:any){
            res.status(500).json({error: 'İşlem şu anda gerçekleştirilemiyor.'});
        }
    }

    async resetPassword(req:Request , res:Response){
        try{
            const token = String(req.body?.token || '');
            const newPassword = String(req.body?.newPassword || '');
            if (!token) return res.status(400).json({ error: 'Token zorunludur.' });
            await this.resetPasswordUseCase.execute(token, newPassword);
            auditLog.log({ action: 'auth.password_reset.confirm', ...auditLog.context(req) });
            res.status(200).json({ message: 'Parolanız güncellendi. Yeni parolanızla giriş yapabilirsiniz.' });
        }catch(error:any){
            res.status(400).json({error:error.message});
        }
    }

    async requestAccountDeletion(req:Request , res:Response){
        try{
            const employeeId = req.user?.id;
            if (!employeeId) return res.status(401).json({ error: 'Yetkisiz erişim.' });
            await this.requestAccountDeletionUseCase.execute(employeeId);
            auditLog.log({
                action: 'auth.account_deletion.request',
                tenantId: req.user!.tenantId,
                employeeId,
                entityType: 'Employee',
                entityId: employeeId,
                ...auditLog.context(req),
            });
            res.status(200).json({ message: 'Hesap silme onay bağlantısı e-posta adresinize gönderildi.' });
        }catch(error:any){
            res.status(400).json({error:error.message});
        }
    }

    async confirmAccountDeletion(req:Request , res:Response){
        try{
            const token = String(req.body?.token || '');
            if (!token) return res.status(400).json({ error: 'Token zorunludur.' });
            await this.confirmAccountDeletionUseCase.execute(token);
            clearAuthCookies(res);
            auditLog.log({ action: 'auth.account_deletion.confirm', ...auditLog.context(req) });
            res.status(200).json({ message: 'Hesabınız silindi.' });
        }catch(error:any){
            res.status(400).json({error:error.message});
        }
    }

    async getPermissions(req:Request , res:Response){
        try{
            const employeeId = req.user?.id;
            if (!employeeId) {
                return res.status(401).json({ error: 'Yetkisiz erişim.' });
            }
            const permissions = await this.getUserPermissionsUseCase.execute(employeeId);
            res.status(200).json({ permissions });
        }catch(error:any){
            res.status(500).json({error: error.message});
        }
    }

    async getMe(req:Request , res:Response){
        try{
            const employeId = req.user?.id;

            if(!employeId){
                return res.status(401).json({error:'Yetkisiz erişim.'});
            }

            const employee = await this.getMeUseCase.execute(employeId);
            return res.status(200).json(employee);

        }catch(error : any){
            res.status(500).json({error: error.message});
        }
}
}
