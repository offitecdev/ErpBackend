import { IEmployeeRepository } from "../../../domain/repositories/IEmployeeRepository";
import { ICryptoService } from "../../interfaces/ICryptoService";
import { ITokenService } from "../../interfaces/ITokenService";

export class LoginUseCase {
    constructor(
        
        private employeeRepo : IEmployeeRepository,
        private cryptoService : ICryptoService,
        private tokenService : ITokenService

    ){}

    async execute(email:string , plainpassword:string){
        // Generic credentials error (same for unknown email and wrong password) so
        // the endpoint can't be used to enumerate which e-mails have accounts.
        const invalidCredentials = () => new Error("E-posta veya parola hatalı.");

        const employee = await this.employeeRepo.findByEmail(email);

        if(!employee) throw invalidCredentials();

        if(!employee.isActive) throw new Error("Erişim Engellendi: Hesabınız pasif durumdadır. Sistem yöneticisi ile iletişime geçin.");

        const isPasswordValid = await this.cryptoService.comparePassword(plainpassword , employee.passwordHash);

        if(!isPasswordValid) throw invalidCredentials();

        const token = this.tokenService
        .generateToken({
            id: employee.id,
            tenantId: employee.tenantId,
            email: employee.email
        });
        return {
            token,
            employee: {
                id : employee.id,
                firstName : employee.firstName,
                lastName : employee.lastName,
                tenantId : employee.tenantId
            }

        }
    }


}