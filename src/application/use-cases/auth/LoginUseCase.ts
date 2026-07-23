import { IEmployeeRepository } from "../../../domain/repositories/IEmployeeRepository";
import { ICryptoService } from "../../interfaces/ICryptoService";
import { ITokenService } from "../../interfaces/ITokenService";
import { toPwdAtClaim } from "../../../infrastructure/services/JwtTokenService";

export class LoginUseCase {
    // bcrypt(cost 12) hash of a random throwaway string — compared against when
    // the e-mail is unknown so every login attempt costs the same wall time.
    private static readonly DUMMY_PASSWORD_HASH =
        '$2b$12$pnTvvJV1RFRAnjBSDLGVEejwkDI5j2V36hQM/LjiV7wGT/Xg9yTf6';

    constructor(

        private employeeRepo : IEmployeeRepository,
        private cryptoService : ICryptoService,
        private tokenService : ITokenService

    ){}

    async execute(email:string , plainpassword:string){
        // Generic credentials error (same for unknown email, deleted/banned
        // account and wrong password) so the endpoint can't enumerate accounts.
        const invalidCredentials = () => new Error("E-posta veya parola hatalı.");

        const employee = await this.employeeRepo.findByEmail(email);

        // Timing equalization: exactly one bcrypt compare runs on EVERY path.
        // Unknown e-mails compare against a fixed dummy hash, so "user not
        // found" and "wrong password" answer in the same timeframe with the
        // same message — response timing can't be used to enumerate accounts.
        const isPasswordValid = await this.cryptoService.comparePassword(
            plainpassword,
            employee?.passwordHash ?? LoginUseCase.DUMMY_PASSWORD_HASH,
        );

        if(!employee || employee.deletedAt || employee.bannedAt || !isPasswordValid) throw invalidCredentials();

        // Only revealed to someone holding the CORRECT password — the inactive
        // state can't be probed with credential guesses.
        if(!employee.isActive) throw new Error("Erişim Engellendi: Hesabınız pasif durumdadır. Sistem yöneticisi ile iletişime geçin.");

        const payload = {
            id: employee.id,
            tenantId: employee.tenantId,
            email: employee.email,
            pwdAt: toPwdAtClaim(employee.passwordChangedAt),
        };

        const accessToken  = this.tokenService.generateToken('access', payload);
        const refreshToken = this.tokenService.generateToken('refresh', payload);

        return {
            accessToken,
            refreshToken,
            employee: {
                id : employee.id,
                firstName : employee.firstName,
                lastName : employee.lastName,
                tenantId : employee.tenantId
            }

        }
    }


}
