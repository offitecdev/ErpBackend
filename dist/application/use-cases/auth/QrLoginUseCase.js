"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.QrLoginUseCase = void 0;
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const JwtTokenService_1 = require("../../../infrastructure/services/JwtTokenService");
/**
 * ── ANMELDUNG PER PERSONAL-QR ────────────────────────────────────────────────
 *
 * Das Personalmodul gibt je Person GENAU EINEN QR-Code aus (`Employee.qrToken`).
 * Derselbe Code stempelt am Tablet ein und aus — und meldet hier an. Der frühere
 * Anmelde-QR trug E-Mail und Kennwort im Klartext; dieser Weg trägt nur einen
 * Schlüssel, der jederzeit neu ausgegeben werden kann (verlorene Karte), ohne
 * dass jemand sein Kennwort ändern muss.
 *
 * Die Antwort ist bewusst dieselbe wie beim Kennwort-Login: gleiche Fehler-
 * meldung für unbekannt/gesperrt/gelöscht, damit ein gefundener Code nicht
 * verrät, ob er einmal gültig war.
 */
class QrLoginUseCase {
    tokenService;
    constructor(tokenService) {
        this.tokenService = tokenService;
    }
    async execute(rawToken) {
        const token = String(rawToken ?? '').trim();
        const invalid = () => new Error('QR-Code ist ungültig oder abgelaufen.');
        if (!token)
            throw invalid();
        // Datenbankfehler dürfen NICHT als Meldung nach draussen: der Aufrufer
        // ist nicht angemeldet, und eine Prisma-Meldung verriete Tabellen- und
        // Spaltennamen. Nach aussen bleibt es bei „ungültig".
        let employee;
        try {
            employee = await prisma_client_1.default.employee.findUnique({
                where: { qrToken: token },
                select: {
                    id: true, tenantId: true, email: true, firstName: true, lastName: true,
                    passwordChangedAt: true, isActive: true, deletedAt: true, bannedAt: true,
                },
            });
        }
        catch (error) {
            console.error('[QrLoginUseCase] lookup failed:', error);
            throw invalid();
        }
        if (!employee || employee.deletedAt || employee.bannedAt)
            throw invalid();
        if (!employee.isActive) {
            throw new Error('Zugriff verweigert: Das Konto ist deaktiviert. Bitte die Systemverwaltung kontaktieren.');
        }
        const payload = {
            id: employee.id,
            tenantId: employee.tenantId,
            email: employee.email,
            pwdAt: (0, JwtTokenService_1.toPwdAtClaim)(employee.passwordChangedAt),
        };
        return {
            accessToken: this.tokenService.generateToken('access', payload),
            refreshToken: this.tokenService.generateToken('refresh', payload),
            employee: {
                id: employee.id,
                firstName: employee.firstName,
                lastName: employee.lastName,
                tenantId: employee.tenantId,
            },
        };
    }
}
exports.QrLoginUseCase = QrLoginUseCase;
//# sourceMappingURL=QrLoginUseCase.js.map