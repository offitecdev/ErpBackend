import { IEmployeeRepository } from "../../../domain/repositories/IEmployeeRepository";
import { ITokenService } from "../../interfaces/ITokenService";
import { AuthMailService } from "../../../infrastructure/services/AuthMailService";
import { toPwdAtClaim } from "../../../infrastructure/services/JwtTokenService";

/**
 * Mails a deletion-confirmation link to the logged-in employee's own address.
 * Deletion only happens after the mailed token is confirmed.
 */
export class RequestAccountDeletionUseCase {
    constructor(
        private employeeRepo: IEmployeeRepository,
        private tokenService: ITokenService,
        private mailService: AuthMailService,
    ) {}

    async execute(employeeId: string): Promise<void> {
        const employee = await this.employeeRepo.findById(employeeId);
        if (!employee || employee.deletedAt) throw new Error("Hesap bulunamadı veya silinmiş.");

        const token = this.tokenService.generateToken('account_deletion', {
            id: employee.id,
            tenantId: employee.tenantId,
            email: employee.email,
            pwdAt: toPwdAtClaim(employee.passwordChangedAt),
        });

        await this.mailService.sendAccountDeletionMail(employee.tenantId, employee.email, token);
    }
}

export class ConfirmAccountDeletionUseCase {
    constructor(
        private employeeRepo: IEmployeeRepository,
        private tokenService: ITokenService,
    ) {}

    async execute(token: string): Promise<void> {
        // Only a token signed with the account-deletion secret and
        // typ=account_deletion passes.
        const decoded = this.tokenService.verifyToken('account_deletion', token);

        const employee = await this.employeeRepo.findById(decoded.id);
        if (!employee) throw new Error("Hesap bulunamadı.");
        if (employee.deletedAt) return; // already deleted — idempotent

        if (decoded.pwdAt !== toPwdAtClaim(employee.passwordChangedAt)) {
            throw new Error("Silme bağlantısı geçersiz. Lütfen yeni bir bağlantı isteyin.");
        }

        // Soft delete: blocks login, refresh and every authorized request.
        await this.employeeRepo.update(employee.id, {
            deletedAt: new Date(),
            isActive: false,
        });
    }
}
