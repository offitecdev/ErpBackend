"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.toPwdAtClaim = exports.jwtTokenService = exports.JwtTokenService = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const SECRET_ENV_VARS = {
    access: 'OFFITEC_JWT_ACCESS_SECRET',
    refresh: 'OFFITEC_JWT_REFRESH_SECRET',
    activation: 'OFFITEC_JWT_ACTIVATION_SECRET',
    password_reset: 'OFFITEC_JWT_PASSWORD_RESET_SECRET',
    account_deletion: 'OFFITEC_JWT_ACCOUNT_DELETION_SECRET',
};
const TOKEN_TTL = {
    access: '15m',
    refresh: '30d',
    activation: '24h',
    password_reset: '1h',
    account_deletion: '15m',
};
class JwtTokenService {
    secretCache = new Map();
    /**
     * Secrets live in env as Base64. Decoded once, kept as raw key bytes.
     * Enforces a 32-byte minimum (HS256 key size) and rejects a secret that is
     * byte-identical to another purpose's secret, so purpose isolation can't be
     * silently broken by a copy-paste in .env.
     */
    getSecret(purpose) {
        const cached = this.secretCache.get(purpose);
        if (cached)
            return cached;
        const envVar = SECRET_ENV_VARS[purpose];
        const raw = process.env[envVar];
        if (!raw)
            throw new Error(`JWT secret eksik: ${envVar} tanımlanmamış.`);
        const secret = Buffer.from(raw, 'base64');
        if (secret.length < 32) {
            throw new Error(`JWT secret zayıf: ${envVar} en az 32 bayt (Base64) olmalı.`);
        }
        for (const [otherPurpose, otherSecret] of this.secretCache) {
            if (otherSecret.equals(secret)) {
                throw new Error(`JWT secret çakışması: ${envVar} ile ${SECRET_ENV_VARS[otherPurpose]} aynı değere sahip olamaz.`);
            }
        }
        this.secretCache.set(purpose, secret);
        return secret;
    }
    generateToken(purpose, payload) {
        return jsonwebtoken_1.default.sign({ ...payload, typ: purpose }, this.getSecret(purpose), {
            algorithm: 'HS256',
            expiresIn: TOKEN_TTL[purpose],
        });
    }
    verifyToken(purpose, token) {
        let decoded;
        try {
            // Algorithm pinned to HS256 so a forged token can't downgrade to
            // "none" or switch to an asymmetric scheme.
            decoded = jsonwebtoken_1.default.verify(token, this.getSecret(purpose), {
                algorithms: ['HS256'],
            });
        }
        catch (error) {
            if (error instanceof jsonwebtoken_1.default.TokenExpiredError) {
                throw new Error('Token süresi dolmuş.');
            }
            throw new Error('Geçersiz token.');
        }
        // Defense-in-depth: the purpose-specific secret already rejects foreign
        // tokens, but the typ claim is checked as well.
        if (!decoded ||
            typeof decoded !== 'object' ||
            decoded.typ !== purpose ||
            typeof decoded.id !== 'string' ||
            typeof decoded.tenantId !== 'string' ||
            typeof decoded.email !== 'string' ||
            typeof decoded.pwdAt !== 'number') {
            throw new Error('Geçersiz token içeriği.');
        }
        return decoded;
    }
}
exports.JwtTokenService = JwtTokenService;
/** Shared instance for middlewares / route wiring. */
exports.jwtTokenService = new JwtTokenService();
/** `passwordChangedAt` → epoch-seconds claim value (0 = never changed). */
const toPwdAtClaim = (passwordChangedAt) => passwordChangedAt ? Math.floor(passwordChangedAt.getTime() / 1000) : 0;
exports.toPwdAtClaim = toPwdAtClaim;
//# sourceMappingURL=JwtTokenService.js.map