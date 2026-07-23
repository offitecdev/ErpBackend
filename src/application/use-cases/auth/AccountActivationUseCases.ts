import { IEmployeeRepository } from "../../../domain/repositories/IEmployeeRepository";
import { ITokenService } from "../../interfaces/ITokenService";
import { AuthMailService } from "../../../infrastructure/services/AuthMailService";
import { toPwdAtClaim } from "../../../infrastructure/services/JwtTokenService";

/**
 * Sends an activation link to an inactive account. Always resolves silently so
 * the endpoint can't be used to probe which e-mail addresses exist.
 */
export class RequestAccountActivationUseCase {
    constructor(
        private employeeRepo: IEmployeeRepository,
        private tokenService: ITokenService,
        private mailService: AuthMailService,
    ) {}

    async execute(email: string): Promise<void> {
        const employee = await this.employeeRepo.findByEmail(email);
        if (!employee || employee.deletedAt || employee.bannedAt || employee.isActive) return;

        const token = this.tokenService.generateToken('activation', {
            id: employee.id,
            tenantId: employee.tenantId,
            email: employee.email,
            pwdAt: toPwdAtClaim(employee.passwordChangedAt),
        });

        await this.mailService.sendActivationMail(employee.tenantId, employee.email, token);
    }
}

export class ActivateAccountUseCase {
    constructor(
        private employeeRepo: IEmployeeRepository,
        private tokenService: ITokenService,
    ) {}

    async execute(token: string): Promise<void> {
        // Only a token signed with the activation secret and typ=activation passes.
        const decoded = this.tokenService.verifyToken('activation', token);

        const employee = await this.employeeRepo.findById(decoded.id);
        if (!employee || employee.deletedAt || employee.bannedAt) throw new Error("Hesap bulunamadı veya silinmiş.");
        if (employee.isActive) return; // already active — nothing to do

        if (decoded.pwdAt !== toPwdAtClaim(employee.passwordChangedAt)) {
            throw new Error("Aktivasyon bağlantısı geçersiz. Lütfen yeni bir bağlantı isteyin.");
        }

        await this.employeeRepo.update(employee.id, { isActive: true });
    }
}
