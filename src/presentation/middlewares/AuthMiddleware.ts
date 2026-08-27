import { Request, Response, NextFunction } from 'express';
import { jwtTokenService, toPwdAtClaim } from '../../infrastructure/services/JwtTokenService';
import { ACCESS_COOKIE, CSRF_COOKIE, clearAuthCookies } from '../utils/authCookies';
import { parseAllowedTenantIds } from '../utils/tenantAccess';
import { getAuthIdentity } from '../../shared/authIdentityCache';
import { findTenantRootIdCached } from '../../shared/tenantTree';

declare module 'express-serve-static-core' {
    interface Request {
        user?: {
            id: string;
            tenantId: string;
            homeTenantId: string;
            email: string;
            firstName?: string;
            lastName?: string;
        };
    }
}

/**
 * Şirket ağacındaki kök tenant. Zincir artık tenant tablosunun paylaşılan
 * önbelleğinden bellekte yürünüyor: eskiden her seviye ayrı bir `findUnique`
 * turuydu ve tenant başına ayrı bir kök önbelleği tutuluyordu.
 */
export const findTenantRootId = findTenantRootIdCached;

/**
 * The employee's assigned companies, reduced to the ones that really sit in
 * their own company tree and are still active. An assignment may only ever
 * narrow the tree, never widen it. Empty result = no usable restriction.
 */
const narrowAssignmentToTree = async (assigned: string[], homeRootId: string): Promise<string[]> => {
    const roots = await Promise.all(assigned.map((tenantId) => findTenantRootId(tenantId)));
    return assigned.filter((_, index) => roots[index] === homeRootId);
};

const resolveTenantId = async (
    homeTenantId: string,
    allowedTenantIds: string[] | null,
    requestedTenantId?: string,
): Promise<string> => {
    const requested = requestedTenantId?.trim();

    // Fast path — no company assignment: the whole own tree stays accessible
    // (the behaviour of every account before assignments existed).
    if (!allowedTenantIds?.length) {
        if (!requested || requested === homeTenantId) return homeTenantId;

        const [homeRootId, requestedRootId] = await Promise.all([
            findTenantRootId(homeTenantId),
            findTenantRootId(requested),
        ]);

        if (!homeRootId || homeRootId !== requestedRootId) {
            throw new Error('Bu şirket için erişim yetkiniz yok.');
        }

        return requested;
    }

    const homeRootId = await findTenantRootId(homeTenantId);
    if (!homeRootId) {
        throw new Error('Bu şirket için erişim yetkiniz yok.');
    }

    const allowed = await narrowAssignmentToTree(allowedTenantIds, homeRootId);
    // Every assigned company vanished (deactivated / moved out of the tree):
    // fall back to the unrestricted rules instead of locking the account out.
    if (!allowed.length) return resolveTenantId(homeTenantId, null, requestedTenantId);

    // Without a selection the home tenant wins, but only if it was assigned —
    // otherwise the first assigned company becomes the default one.
    const target = requested || (allowed.includes(homeTenantId) ? homeTenantId : allowed[0]!);
    if (!allowed.includes(target)) {
        throw new Error('Bu şirket için erişim yetkiniz yok.');
    }

    return target;
};

export const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authStartedAt = Date.now();
    // Tokens are accepted exclusively from the HttpOnly cookie — never from
    // the JSON body. (Authorization: Bearer is still honored for API tooling
    // such as Swagger UI; browsers never store tokens anywhere JS can read.)
    const authHeader = req.headers.authorization;
    const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;
    const cookieToken = req.cookies?.[ACCESS_COOKIE];
    const token = cookieToken || headerToken;

    if (!token) {
        res.status(401).json({ error: 'Kimlik doğrulama reddedildi: Token bulunamadı.' });
        return;
    }

    // CSRF (double-submit cookie), on top of SameSite: cookie-authenticated
    // state-changing requests must echo the JS-readable csrf cookie in the
    // X-CSRF-Token header — a cross-site attacker's browser sends the auth
    // cookie but cannot read the csrf cookie to forge the header. Bearer-header
    // auth is inherently CSRF-proof and skips this.
    const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (cookieToken && isMutation) {
        const csrfCookie = req.cookies?.[CSRF_COOKIE];
        const csrfHeader = req.header('x-csrf-token');
        if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
            res.status(403).json({ error: 'CSRF doğrulaması başarısız. Sayfayı yenileyip tekrar deneyin.' });
            return;
        }
    }

    try {
        // Purpose-bound verification: only a token signed with the access secret
        // and carrying typ=access is accepted here — a refresh (or activation,
        // reset, deletion) token can never authorize an API request.
        const decoded = jwtTokenService.verifyToken('access', token);

        // The token being valid is not enough: the account's current state
        // (active / banned / deleted, password generation, company assignment)
        // still gates every authorized request. It is read through a short-lived
        // cache that every account mutation invalidates — see authIdentityCache.
        const employee = await getAuthIdentity(decoded.id);

        // These states mean the whole session is dead (refresh would fail
        // too), so the server clears its cookies. An *expired* access token, in
        // contrast, must NOT clear anything — the refresh cookie is still valid
        // and the client will silently renew.
        if (!employee || employee.deletedAt || employee.bannedAt) {
            clearAuthCookies(res);
            res.status(401).json({ error: 'Hesap bulunamadı veya silinmiş.' });
            return;
        }
        if (!employee.isActive) {
            clearAuthCookies(res);
            res.status(401).json({ error: 'Hesabınız pasif durumdadır. Sistem yöneticisi ile iletişime geçin.' });
            return;
        }
        // A password change bumps passwordChangedAt; any token minted before it
        // carries a stale pwdAt claim and dies here.
        if (decoded.pwdAt !== toPwdAtClaim(employee.passwordChangedAt)) {
            clearAuthCookies(res);
            res.status(401).json({ error: 'Parola değiştirildiği için oturum geçersiz. Lütfen tekrar giriş yapın.' });
            return;
        }

        const homeTenantId = decoded.tenantId;
        const tenantId = await resolveTenantId(
            homeTenantId,
            parseAllowedTenantIds(employee.allowedTenantIds),
            req.header('x-tenant-id'),
        );
        
        req.user = {
            id: decoded.id,
            tenantId,
            homeTenantId,
            email: decoded.email,
            firstName: employee.firstName,
            lastName: employee.lastName,
        };

        // Yanıtların Server-Timing başlığında görünsün: uç noktadaki yavaşlık
        // handler'da mı, kimlik katmanında mı — tarayıcıdan ayırt edilebilir.
        (req as any).authDurMs = Date.now() - authStartedAt;
        next();
    } catch (error) {
        res.status(401).json({ error: error instanceof Error ? error.message : 'Geçersiz veya süresi dolmuş token.' });
    }
};
