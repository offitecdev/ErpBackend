"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfirmAccountDeletionUseCase = exports.RequestAccountDeletionUseCase = void 0;
const JwtTokenService_1 = require("../../../infrastructure/services/JwtTokenService");
/**
 * Mails a deletion-confirmation link to the logged-in employee's own address.
 * Deletion only happens after the mailed token is confirmed.
 */
class RequestAccountDeletionUseCase {
    employeeRepo;
    tokenService;
    mailService;
    constructor(employeeRepo, tokenService, mailService) {
        this.employeeRepo = employeeRepo;
        this.tokenService = tokenService;
        this.mailService = mailService;
    }
    async execute(employeeId) {
        const employee = await this.employeeRepo.findById(employeeId);
        if (!employee || employee.deletedAt)
            throw new Error("Hesap bulunamadı veya silinmiş.");
        const token = this.tokenService.generateToken('account_deletion', {
            id: employee.id,
            tenantId: employee.tenantId,
            email: employee.email,
            pwdAt: (0, JwtTokenService_1.toPwdAtClaim)(employee.passwordChangedAt),
        });
        await this.mailService.sendAccountDeletionMail(employee.tenantId, employee.email, token);
    }
}
exports.RequestAccountDeletionUseCase = RequestAccountDeletionUseCase;
class ConfirmAccountDeletionUseCase {
    employeeRepo;
    tokenService;
    constructor(employeeRepo, tokenService) {
        this.employeeRepo = employeeRepo;
        this.tokenService = tokenService;
    }
    async execute(token) {
        // Only a token signed with the account-deletion secret and
        // typ=account_deletion passes.
        const decoded = this.tokenService.verifyToken('account_deletion', token);
        const employee = await this.employeeRepo.findById(decoded.id);
        if (!employee)
            throw new Error("Hesap bulunamadı.");
        if (employee.deletedAt)
            return; // already deleted — idempotent
        if (decoded.pwdAt !== (0, JwtTokenService_1.toPwdAtClaim)(employee.passwordChangedAt)) {
            throw new Error("Silme bağlantısı geçersiz. Lütfen yeni bir bağlantı isteyin.");
        }
        // Soft delete: blocks login, refresh and every authorized request.
        await this.employeeRepo.update(employee.id, {
            deletedAt: new Date(),
            isActive: false,
        });
    }
}
exports.ConfirmAccountDeletionUseCase = ConfirmAccountDeletionUseCase;
//# sourceMappingURL=AccountDeletionUseCases.js.map