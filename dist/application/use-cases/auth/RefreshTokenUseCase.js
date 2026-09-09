"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RefreshTokenUseCase = void 0;
const JwtTokenService_1 = require("../../../infrastructure/services/JwtTokenService");
const RefreshSessionService_1 = require("../../../infrastructure/services/RefreshSessionService");
const AuthErrors_1 = require("../../errors/AuthErrors");
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
class RefreshTokenUseCase {
    employeeRepo;
    tokenService;
    constructor(employeeRepo, tokenService) {
        this.employeeRepo = employeeRepo;
        this.tokenService = tokenService;
    }
    async execute(refreshToken, context = {}) {
        // Only a token signed with the refresh secret AND carrying typ=refresh
        // passes; an access (or any other) token is rejected here. Seit der
        // Sitzungsführung müssen ausserdem `jti` und `sid` darin stehen.
        // `verifyToken` hat `jti`/`sid` für diesen Zweck bereits erzwungen.
        const decoded = this.tokenService.verifyToken('refresh', refreshToken);
        const employee = await this.employeeRepo.findById(decoded.id);
        if (!employee || employee.deletedAt || employee.bannedAt)
            throw new AuthErrors_1.PublicError("Hesap bulunamadı veya silinmiş.");
        if (!employee.isActive)
            throw new AuthErrors_1.PublicError("Hesabınız pasif durumdadır. Sistem yöneticisi ile iletişime geçin.");
        const pwdAt = (0, JwtTokenService_1.toPwdAtClaim)(employee.passwordChangedAt);
        if (decoded.pwdAt !== pwdAt) {
            throw new AuthErrors_1.PublicError("Parola değiştirildiği için oturum geçersiz. Lütfen tekrar giriş yapın.");
        }
        // Der Tausch prüft, ob dieses Token überhaupt noch zu einer offenen
        // Anmeldung gehört — und wirft, wenn es schon getauscht oder abgemeldet
        // war. Erst danach werden neue Token ausgestellt.
        const session = await (0, RefreshSessionService_1.rotateRefreshSession)({ jti: decoded.jti, sid: decoded.sid }, employee.id, employee.tenantId, context);
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
exports.RefreshTokenUseCase = RefreshTokenUseCase;
//# sourceMappingURL=RefreshTokenUseCase.js.map