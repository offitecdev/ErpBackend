"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.issueEmployeeSession = void 0;
const JwtTokenService_1 = require("../../../infrastructure/services/JwtTokenService");
const RefreshSessionService_1 = require("../../../infrastructure/services/RefreshSessionService");
const issueEmployeeSession = async (tokenService, employee, context = {}) => {
    const payload = {
        id: employee.id,
        tenantId: employee.tenantId,
        email: employee.email,
        pwdAt: (0, JwtTokenService_1.toPwdAtClaim)(employee.passwordChangedAt),
    };
    // Eine Anmeldung = eine Zeile. Das Erneuerungstoken trägt ihre Kennung,
    // damit Abmelden, Sperre und Wiedereinspielschutz greifen können
    // (RefreshSessionService).
    const session = await (0, RefreshSessionService_1.startRefreshSession)(employee.id, employee.tenantId, context);
    return {
        accessToken: tokenService.generateToken('access', payload),
        refreshToken: tokenService.generateToken('refresh', { ...payload, ...session }),
        employee: {
            id: employee.id,
            firstName: employee.firstName,
            lastName: employee.lastName,
            tenantId: employee.tenantId,
        },
    };
};
exports.issueEmployeeSession = issueEmployeeSession;
//# sourceMappingURL=sessionIssuer.js.map