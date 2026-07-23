/**
 * Every JWT this system issues is bound to exactly one purpose. Each purpose is
 * signed with its own HMAC secret AND carries a `typ` claim, so a token minted
 * for one flow (e.g. refresh) can never be accepted in another (e.g. access).
 */
export type TokenPurpose =
    | 'access'
    | 'refresh'
    | 'activation'
    | 'password_reset'
    | 'account_deletion';

export interface AuthTokenPayload {
    /** Employee id */
    id: string;
    tenantId: string;
    email: string;
    /**
     * `passwordChangedAt` of the employee at issue time, as epoch seconds
     * (0 = password never changed). Verified against the database on every
     * authenticated request so a password change invalidates all tokens
     * issued before it.
     */
    pwdAt: number;
}

export interface VerifiedToken extends AuthTokenPayload {
    typ: TokenPurpose;
    iat: number;
    exp: number;
}

export interface ITokenService {
    generateToken(purpose: TokenPurpose, payload: AuthTokenPayload): string;
    /** Throws if the token is invalid, expired, or was issued for another purpose. */
    verifyToken(purpose: TokenPurpose, token: string): VerifiedToken;
}
