"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RefreshTokenUseCase = void 0;
const JwtTokenService_1 = require("../../../infrastructure/services/JwtTokenService");
class RefreshTokenUseCase {
    employeeRepo;
    tokenService;
    constructor(employeeRepo, tokenService) {
        this.employeeRepo = employeeRepo;
        this.tokenService = tokenService;
    }
    async execute(refreshToken) {
        // Only a token signed with the refresh secret AND carrying typ=refresh
        // passes; an access (or any other) token is rejected here.
        const decoded = this.tokenService.verifyToken('refresh', refreshToken);
        const employee = await this.employeeRepo.findById(decoded.id);
        if (!employee || employee.deletedAt || employee.bannedAt)
            throw new Error("Hesap bulunamadı veya silinmiş.");
        if (!employee.isActive)
            throw new Error("Hesabınız pasif durumdadır. Sistem yöneticisi ile iletişime geçin.");
        const pwdAt = (0, JwtTokenService_1.toPwdAtClaim)(employee.passwordChangedAt);
        if (decoded.pwdAt !== pwdAt) {
            throw new Error("Parola değiştirildiği için oturum geçersiz. Lütfen tekrar giriş yapın.");
        }
        const payload = {
            id: employee.id,
            tenantId: employee.tenantId,
            email: employee.email,
            pwdAt,
        };
        // Rotation: each refresh hands out a new refresh token as well.
        const accessToken = this.tokenService.generateToken('access', payload);
        const newRefreshToken = this.tokenService.generateToken('refresh', payload);
        return { accessToken, refreshToken: newRefreshToken };
    }
}
exports.RefreshTokenUseCase = RefreshTokenUseCase;
//# sourceMappingURL=RefreshTokenUseCase.js.map