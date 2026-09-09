import { IEmployeeRepository } from "../../../domain/repositories/IEmployeeRepository";
import { ITokenService, VerifiedRefreshToken } from "../../interfaces/ITokenService";
import { toPwdAtClaim } from "../../../infrastructure/services/JwtTokenService";
import {
    rotateRefreshSession,
    RefreshSessionContext,
} from "../../../infrastructure/services/RefreshSessionService";
import { PublicError } from "../../errors/AuthErrors";

/**
 * Erneuerung mit Tausch UND Sitzungsführung.
 *
 * Getauscht wurde schon immer — entwertet wurde nichts: das alte Token blieb
 * bis zu seinem Ablauf (30 Tage) gültig, sodass ein abgegriffenes Token und das
 * echte nebeneinander weiterliefen und weder Abmelden noch irgendetwas sonst
 * das beenden konnte. Der Tausch geht jetzt durch `rotateRefreshSession`: die
 * vorgelegte Zeile stirbt, eine neue tritt an ihre Stelle, und ein bereits
 * getauschtes Token legt die ganze Anmeldung stumm (Wiedereinspielschutz).
 */
export class RefreshTokenUseCase {
    constructor(
        private employeeRepo: IEmployeeRepository,
        private tokenService: ITokenService,
    ) {}

    async execute(refreshToken: string, context: RefreshSessionContext = {}) {
        // Only a token signed with the refresh secret AND carrying typ=refresh
        // passes; an access (or any other) token is rejected here. Seit der
        // Sitzungsführung müssen ausserdem `jti` und `sid` darin stehen.
        // `verifyToken` hat `jti`/`sid` für diesen Zweck bereits erzwungen.
        const decoded = this.tokenService.verifyToken('refresh', refreshToken) as VerifiedRefreshToken;

        const employee = await this.employeeRepo.findById(decoded.id);

        if (!employee || employee.deletedAt || employee.bannedAt) throw new PublicError("Hesap bulunamadı veya silinmiş.");
        if (!employee.isActive) throw new PublicError("Hesabınız pasif durumdadır. Sistem yöneticisi ile iletişime geçin.");

        const pwdAt = toPwdAtClaim(employee.passwordChangedAt);
        if (decoded.pwdAt !== pwdAt) {
            throw new PublicError("Parola değiştirildiği için oturum geçersiz. Lütfen tekrar giriş yapın.");
        }

        // Der Tausch prüft, ob dieses Token überhaupt noch zu einer offenen
        // Anmeldung gehört — und wirft, wenn es schon getauscht oder abgemeldet
        // war. Erst danach werden neue Token ausgestellt.
        const session = await rotateRefreshSession(
            { jti: decoded.jti, sid: decoded.sid },
            employee.id,
            employee.tenantId,
            context,
        );

        const payload = {
            id: employee.id,
            tenantId: employee.tenantId,
            email: employee.email,
            pwdAt,
        };

        const accessToken = this.tokenService.generateToken('access', payload);
        const newRefreshToken = this.tokenService.generateToken('refresh', { ...payload, ...session });

        return { accessToken, refreshToken: newRefreshToken };
    }
}
