import { IEmployeeRepository } from "../../../domain/repositories/IEmployeeRepository";
import { ITokenService } from "../../interfaces/ITokenService";
import { AuthMailService } from "../../../infrastructure/services/AuthMailService";
import { toPwdAtClaim } from "../../../infrastructure/services/JwtTokenService";
import { PublicError } from "../../errors/AuthErrors";

/**
 * Sends an activation link to an inactive account. Always resolves silently so
 * the endpoint can't be used to probe which e-mail addresses exist.
 *
 * ── NUR EIN NIE FREIGESCHALTETES KONTO (Korrektur 22.09.2026) ───────────────
 * Der Weg war für die ERSTE Freischaltung gedacht — er traf aber jedes inaktive
 * Konto, also auch das, das die Verwaltung gerade stillgelegt hatte. Eine
 * ausgetretene Person forderte den Link an ihre eigene Adresse an, bestätigte
 * ihn und war wieder angemeldet; `LoginUseCase` prüft nur `isActive`, und das
 * stand danach wieder auf wahr.
 *
 * `Employee.deactivatedAt` trennt beides. Sie wird gesetzt, sobald ein Konto
 * stillgelegt/gesperrt/gelöscht wird (zentral in EmployeeRepository.update) und
 * geleert, sobald die Verwaltung es wieder aktiv setzt. Solange sie steht,
 * geschieht hier NICHTS — und zwar still, damit die Antwort weiterhin nichts
 * über den Zustand eines Kontos verrät.
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
        // Von der Verwaltung stillgelegt: nur die Verwaltung öffnet es wieder.
        if (employee.deactivatedAt) return;

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
        if (!employee || employee.deletedAt || employee.bannedAt) throw new PublicError("Hesap bulunamadı veya silinmiş.");
        if (employee.isActive) return; // already active — nothing to do

        // Zweite Schranke für einen Link, der VOR der Stilllegung verschickt
        // wurde: er ist 24 Stunden gültig und würde sie sonst überdauern.
        if (employee.deactivatedAt) {
            throw new PublicError("Bu hesap yönetici tarafından pasife alınmıştır; yeniden etkinleştirmeyi sistem yöneticisi yapar.");
        }

        if (decoded.pwdAt !== toPwdAtClaim(employee.passwordChangedAt)) {
            throw new PublicError("Aktivasyon bağlantısı geçersiz. Lütfen yeni bir bağlantı isteyin.");
        }

        await this.employeeRepo.update(employee.id, { isActive: true });
    }
}
