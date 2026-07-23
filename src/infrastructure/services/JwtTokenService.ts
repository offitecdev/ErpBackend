import jwt from 'jsonwebtoken';
import {
    ITokenService,
    TokenPurpose,
    AuthTokenPayload,
    VerifiedToken,
} from '../../application/interfaces/ITokenService';

const SECRET_ENV_VARS: Record<TokenPurpose, string> = {
    access: 'OFFITEC_JWT_ACCESS_SECRET',
    refresh: 'OFFITEC_JWT_REFRESH_SECRET',
    activation: 'OFFITEC_JWT_ACTIVATION_SECRET',
    password_reset: 'OFFITEC_JWT_PASSWORD_RESET_SECRET',
    account_deletion: 'OFFITEC_JWT_ACCOUNT_DELETION_SECRET',
};

const TOKEN_TTL: Record<TokenPurpose, string> = {
    access: '15m',
    refresh: '30d',
    activation: '24h',
    password_reset: '1h',
    account_deletion: '15m',
};

export class JwtTokenService implements ITokenService {
    private readonly secretCache = new Map<TokenPurpose, Buffer>();

    /**
     * Secrets live in env as Base64. Decoded once, kept as raw key bytes.
     * Enforces a 32-byte minimum (HS256 key size) and rejects a secret that is
     * byte-identical to another purpose's secret, so purpose isolation can't be
     * silently broken by a copy-paste in .env.
     */
    private getSecret(purpose: TokenPurpose): Buffer {
        const cached = this.secretCache.get(purpose);
        if (cached) return cached;

        const envVar = SECRET_ENV_VARS[purpose];
        const raw = process.env[envVar];
        if (!raw) throw new Error(`JWT secret eksik: ${envVar} tanımlanmamış.`);

        const secret = Buffer.from(raw, 'base64');
        if (secret.length < 32) {
            throw new Error(`JWT secret zayıf: ${envVar} en az 32 bayt (Base64) olmalı.`);
        }

        for (const [otherPurpose, otherSecret] of this.secretCache) {
            if (otherSecret.equals(secret)) {
                throw new Error(
                    `JWT secret çakışması: ${envVar} ile ${SECRET_ENV_VARS[otherPurpose]} aynı değere sahip olamaz.`,
                );
            }
        }

        this.secretCache.set(purpose, secret);
        return secret;
    }

    generateToken(purpose: TokenPurpose, payload: AuthTokenPayload): string {
        return jwt.sign({ ...payload, typ: purpose }, this.getSecret(purpose), {
            algorithm: 'HS256',
            expiresIn: TOKEN_TTL[purpose] as NonNullable<jwt.SignOptions['expiresIn']>,
        });
    }

    verifyToken(purpose: TokenPurpose, token: string): VerifiedToken {
        let decoded: jwt.JwtPayload;
        try {
            // Algorithm pinned to HS256 so a forged token can't downgrade to
            // "none" or switch to an asymmetric scheme.
            decoded = jwt.verify(token, this.getSecret(purpose), {
                algorithms: ['HS256'],
            }) as jwt.JwtPayload;
        } catch (error) {
            if (error instanceof jwt.TokenExpiredError) {
                throw new Error('Token süresi dolmuş.');
            }
            throw new Error('Geçersiz token.');
        }

        // Defense-in-depth: the purpose-specific secret already rejects foreign
        // tokens, but the typ claim is checked as well.
        if (
            !decoded ||
            typeof decoded !== 'object' ||
            decoded.typ !== purpose ||
            typeof decoded.id !== 'string' ||
            typeof decoded.tenantId !== 'string' ||
            typeof decoded.email !== 'string' ||
            typeof decoded.pwdAt !== 'number'
        ) {
            throw new Error('Geçersiz token içeriği.');
        }

        return decoded as VerifiedToken;
    }
}

/** Shared instance for middlewares / route wiring. */
export const jwtTokenService = new JwtTokenService();

/** `passwordChangedAt` → epoch-seconds claim value (0 = never changed). */
export const toPwdAtClaim = (passwordChangedAt?: Date | null): number =>
    passwordChangedAt ? Math.floor(passwordChangedAt.getTime() / 1000) : 0;
