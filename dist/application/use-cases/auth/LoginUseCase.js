"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LoginUseCase = void 0;
class LoginUseCase {
    employeeRepo;
    cryptoService;
    tokenService;
    constructor(employeeRepo, cryptoService, tokenService) {
        this.employeeRepo = employeeRepo;
        this.cryptoService = cryptoService;
        this.tokenService = tokenService;
    }
    async execute(email, plainpassword) {
        // Generic credentials error (same for unknown email and wrong password) so
        // the endpoint can't be used to enumerate which e-mails have accounts.
        const invalidCredentials = () => new Error("E-posta veya parola hatalı.");
        const employee = await this.employeeRepo.findByEmail(email);
        if (!employee)
            throw invalidCredentials();
        if (!employee.isActive)
            throw new Error("Erişim Engellendi: Hesabınız pasif durumdadır. Sistem yöneticisi ile iletişime geçin.");
        const isPasswordValid = await this.cryptoService.comparePassword(plainpassword, employee.passwordHash);
        if (!isPasswordValid)
            throw invalidCredentials();
        const token = this.tokenService
            .generateToken({
            id: employee.id,
            tenantId: employee.tenantId,
            email: employee.email
        });
        return {
            token,
            employee: {
                id: employee.id,
                firstName: employee.firstName,
                lastName: employee.lastName,
                tenantId: employee.tenantId
            }
        };
    }
}
exports.LoginUseCase = LoginUseCase;
//# sourceMappingURL=LoginUseCase.js.map