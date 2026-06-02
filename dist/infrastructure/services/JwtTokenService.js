"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JwtTokenService = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
class JwtTokenService {
    generateToken(payload) {
        const secret = process.env.OFFITEC_JWT_SECRET;
        if (!secret)
            throw new Error('JWT Secret tanımlanmamış!');
        return jsonwebtoken_1.default.sign(payload, secret, { expiresIn: '1d' });
    }
}
exports.JwtTokenService = JwtTokenService;
//# sourceMappingURL=JwtTokenService.js.map