"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActivateAccountUseCase = exports.RequestAccountActivationUseCase = void 0;
const JwtTokenService_1 = require("../../../infrastructure/services/JwtTokenService");
const AuthErrors_1 = require("../../errors/AuthErrors");
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
        // Von der Verwaltung stillgelegt: nur die Verwaltung öffnet es wieder.
        if (employee.deactivatedAt)
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
            throw new AuthErrors_1.PublicError("Hesap bulunamadı veya silinmiş.");
        if (employee.isActive)
            return; // already active — nothing to do
        // Zweite Schranke für einen Link, der VOR der Stilllegung verschickt
        // wurde: er ist 24 Stunden gültig und würde sie sonst überdauern.
        if (employee.deactivatedAt) {
            throw new AuthErrors_1.PublicError("Bu hesap yönetici tarafından pasife alınmıştır; yeniden etkinleştirmeyi sistem yöneticisi yapar.");
        }
        if (decoded.pwdAt !== (0, JwtTokenService_1.toPwdAtClaim)(employee.passwordChangedAt)) {
            throw new AuthErrors_1.PublicError("Aktivasyon bağlantısı geçersiz. Lütfen yeni bir bağlantı isteyin.");
        }
        await this.employeeRepo.update(employee.id, { isActive: true });
    }
}
exports.ActivateAccountUseCase = ActivateAccountUseCase;
//# sourceMappingURL=AccountActivationUseCases.js.map