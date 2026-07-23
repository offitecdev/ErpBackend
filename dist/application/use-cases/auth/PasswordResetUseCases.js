"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResetPasswordUseCase = exports.RequestPasswordResetUseCase = void 0;
const JwtTokenService_1 = require("../../../infrastructure/services/JwtTokenService");
const password_1 = require("../../validation/password");
/**
 * Sends a password-reset link. Always resolves silently so the endpoint can't
 * be used to probe which e-mail addresses exist.
 */
class RequestPasswordResetUseCase {
    employeeRepo;
    tokenService;
    mailService;
    constructor(employeeRepo, tokenService, mailService) {
        this.employeeRepo = employeeRepo;
        this.tokenService = tokenService;
        this.mailService = mailService;
    }
    async execute(email) {
        const employee = await this.employeeRepo.findByEmail(email);
        if (!employee || employee.deletedAt || employee.bannedAt || !employee.isActive)
            return;
        const token = this.tokenService.generateToken('password_reset', {
            id: employee.id,
            tenantId: employee.tenantId,
            email: employee.email,
            pwdAt: (0, JwtTokenService_1.toPwdAtClaim)(employee.passwordChangedAt),
        });
        await this.mailService.sendPasswordResetMail(employee.tenantId, employee.email, token);
    }
}
exports.RequestPasswordResetUseCase = RequestPasswordResetUseCase;
class ResetPasswordUseCase {
    employeeRepo;
    tokenService;
    cryptoService;
    constructor(employeeRepo, tokenService, cryptoService) {
        this.employeeRepo = employeeRepo;
        this.tokenService = tokenService;
        this.cryptoService = cryptoService;
    }
    async execute(token, newPassword) {
        (0, password_1.assertPasswordPolicy)(newPassword);
        // Only a token signed with the password-reset secret and
        // typ=password_reset passes; access/refresh tokens are rejected.
        const decoded = this.tokenService.verifyToken('password_reset', token);
        const employee = await this.employeeRepo.findById(decoded.id);
        if (!employee || employee.deletedAt)
            throw new Error("Hesap bulunamadı veya silinmiş.");
        if (!employee.isActive)
            throw new Error("Hesabınız pasif durumdadır.");
        // pwdAt binding makes a reset link effectively single-use: as soon as the
        // password changes, every link issued before it stops validating.
        if (decoded.pwdAt !== (0, JwtTokenService_1.toPwdAtClaim)(employee.passwordChangedAt)) {
            throw new Error("Parola sıfırlama bağlantısı geçersiz. Lütfen yeni bir bağlantı isteyin.");
        }
        const passwordHash = await this.cryptoService.hashPassword(newPassword);
        await this.employeeRepo.update(employee.id, {
            passwordHash,
            passwordChangedAt: new Date(),
        });
    }
}
exports.ResetPasswordUseCase = ResetPasswordUseCase;
//# sourceMappingURL=PasswordResetUseCases.js.map