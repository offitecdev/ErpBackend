import { IEmployeeRepository } from "../../../domain/repositories/IEmployeeRepository";
import { ICryptoService } from "../../interfaces/ICryptoService";
import { ITokenService } from "../../interfaces/ITokenService";
import { AuthMailService } from "../../../infrastructure/services/AuthMailService";
import { toPwdAtClaim } from "../../../infrastructure/services/JwtTokenService";
import { assertPasswordPolicy } from "../../validation/password";

/**
 * Sends a password-reset link. Always resolves silently so the endpoint can't
 * be used to probe which e-mail addresses exist.
 */
export class RequestPasswordResetUseCase {
    constructor(
        private employeeRepo: IEmployeeRepository,
        private tokenService: ITokenService,
        private mailService: AuthMailService,
    ) {}

    async execute(email: string): Promise<void> {
        const employee = await this.employeeRepo.findByEmail(email);
        if (!employee || employee.deletedAt || employee.bannedAt || !employee.isActive) return;

        const token = this.tokenService.generateToken('password_reset', {
            id: employee.id,
            tenantId: employee.tenantId,
            email: employee.email,
            pwdAt: toPwdAtClaim(employee.passwordChangedAt),
        });

        await this.mailService.sendPasswordResetMail(employee.tenantId, employee.email, token);
    }
}

export class ResetPasswordUseCase {
    constructor(
        private employeeRepo: IEmployeeRepository,
        private tokenService: ITokenService,
        private cryptoService: ICryptoService,
    ) {}

    async execute(token: string, newPassword: string): Promise<void> {
        assertPasswordPolicy(newPassword);

        // Only a token signed with the password-reset secret and
        // typ=password_reset passes; access/refresh tokens are rejected.
        const decoded = this.tokenService.verifyToken('password_reset', token);

        const employee = await this.employeeRepo.findById(decoded.id);
        if (!employee || employee.deletedAt) throw new Error("Hesap bulunamadı veya silinmiş.");
        if (!employee.isActive) throw new Error("Hesabınız pasif durumdadır.");

        // pwdAt binding makes a reset link effectively single-use: as soon as the
        // password changes, every link issued before it stops validating.
        if (decoded.pwdAt !== toPwdAtClaim(employee.passwordChangedAt)) {
            throw new Error("Parola sıfırlama bağlantısı geçersiz. Lütfen yeni bir bağlantı isteyin.");
        }

        const passwordHash = await this.cryptoService.hashPassword(newPassword);
        await this.employeeRepo.update(employee.id, {
            passwordHash,
            passwordChangedAt: new Date(),
        });
    }
}
