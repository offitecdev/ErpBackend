"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActivateAccountUseCase = exports.RequestAccountActivationUseCase = void 0;
const JwtTokenService_1 = require("../../../infrastructure/services/JwtTokenService");
/**
 * Sends an activation link to an inactive account. Always resolves silently so
 * the endpoint can't be used to probe which e-mail addresses exist.
 */
class RequestAccountActivationUseCase {
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
        if (!employee || employee.deletedAt || employee.bannedAt || employee.isActive)
            return;
        const token = this.tokenService.generateToken('activation', {
            id: employee.id,
            tenantId: employee.tenantId,
            email: employee.email,
            pwdAt: (0, JwtTokenService_1.toPwdAtClaim)(employee.passwordChangedAt),
        });
        await this.mailService.sendActivationMail(employee.tenantId, employee.email, token);
    }
}
exports.RequestAccountActivationUseCase = RequestAccountActivationUseCase;
class ActivateAccountUseCase {
    employeeRepo;
    tokenService;
    constructor(employeeRepo, tokenService) {
        this.employeeRepo = employeeRepo;
        this.tokenService = tokenService;
    }
    async execute(token) {
        // Only a token signed with the activation secret and typ=activation passes.
        const decoded = this.tokenService.verifyToken('activation', token);
        const employee = await this.employeeRepo.findById(decoded.id);
        if (!employee || employee.deletedAt || employee.bannedAt)
            throw new Error("Hesap bulunamadı veya silinmiş.");
        if (employee.isActive)
            return; // already active — nothing to do
        if (decoded.pwdAt !== (0, JwtTokenService_1.toPwdAtClaim)(employee.passwordChangedAt)) {
            throw new Error("Aktivasyon bağlantısı geçersiz. Lütfen yeni bir bağlantı isteyin.");
        }
        await this.employeeRepo.update(employee.id, { isActive: true });
    }
}
exports.ActivateAccountUseCase = ActivateAccountUseCase;
//# sourceMappingURL=AccountActivationUseCases.js.map