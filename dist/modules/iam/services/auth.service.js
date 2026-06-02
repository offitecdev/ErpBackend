"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
class AuthService {
    async login(email, plainPassword) {
        const employee = await prisma_client_1.default.employee.findUnique({
            where: { email }
        });
        if (!employee) {
            throw new Error('Kullanıcı bulunamadı.');
        }
        if (!employee.isActive) {
            throw new Error('Erişim Engellendi: Hesabınız pasif durumdadır. Sistem yöneticisi ile iletişime geçin.');
        }
        const isPasswordValid = await bcrypt_1.default.compare(plainPassword, employee.passwordHash);
        if (!isPasswordValid) {
            throw new Error('Hatalı parola.');
        }
        const payload = {
            id: employee.id,
            tenantId: employee.tenantId,
            email: employee.email
        };
        const secret = process.env.OFFITEC_JWT_SECRET;
        if (!secret)
            throw new Error('JWT Secret tanımlanmamış!');
        const token = jsonwebtoken_1.default.sign(payload, secret);
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
exports.AuthService = AuthService;
//# sourceMappingURL=auth.service.js.map