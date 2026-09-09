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
    | 'account_deletion'
    /**
     * Die halbe Anmeldung: Kennwort stimmt, der zweite Faktor fehlt noch.
     * Es ist AUSDRÜCKLICH kein Zugangstoken — mit eigenem Geheimnis, eigenem
     * `typ` und wenigen Minuten Laufzeit. Wer es hat, kann genau eines: einen
     * Einmalcode einreichen (siehe MfaUseCases).
     */
    | 'mfa';

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
    /**
     * NUR im Erneuerungstoken (`refresh`): die Zeile der offenen Anmeldung und
     * die Anmeldung selbst — siehe RefreshSessionService. Zugangstoken tragen
     * beides nicht; sie leben 15 Minuten und werden nicht einzeln entwertet.
     */
    jti?: string;
    sid?: string;
    /**
     * NUR im Zwischentoken (`mfa`): welche Hälfte des zweiten Faktors noch
     * aussteht.
     *   verify — es gibt ein eingerichtetes Geheimnis, es fehlt der Code.
     *   enroll — es gibt noch keines; `sec` trägt das VORGESCHLAGENE, und es
     *            wird erst geschrieben, wenn der erste Code stimmt.
     *
     * `sec` steht bewusst im (signierten) Token und nicht in der Datenbank:
     * ein abgebrochener Einrichtungsversuch hinterlässt damit keine halb
     * eingerichtete Zeile, und der Vorschlag ist ohnehin kein Geheimnis vor
     * dem Aufrufer — er bekommt ihn als QR-Bild zu sehen.
     */
    mfaStage?: 'verify' | 'enroll';
    sec?: string;
}

export interface VerifiedToken extends AuthTokenPayload {
    typ: TokenPurpose;
    iat: number;
    exp: number;
}

/** Ein geprüftes Erneuerungstoken trägt die Sitzungskennungen immer. */
export interface VerifiedRefreshToken extends VerifiedToken {
    jti: string;
    sid: string;
}

export interface ITokenService {
    generateToken(purpose: TokenPurpose, payload: AuthTokenPayload): string;
    /** Throws if the token is invalid, expired, or was issued for another purpose. */
    verifyToken(purpose: TokenPurpose, token: string): VerifiedToken;
}
