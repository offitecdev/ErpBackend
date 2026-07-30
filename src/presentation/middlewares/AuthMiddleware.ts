import { Request, Response, NextFunction } from 'express';
import prisma from '../../infrastructure/database/prisma.client';
import { jwtTokenService, toPwdAtClaim } from '../../infrastructure/services/JwtTokenService';
import { ACCESS_COOKIE, CSRF_COOKIE, clearAuthCookies } from '../utils/authCookies';
import { parseAllowedTenantIds } from '../utils/tenantAccess';

declare module 'express-serve-static-core' {
    interface Request {
        user?: {
            id: string;
            tenantId: string;
            homeTenantId: string;
            email: string;
        };
    }
}

export const findTenantRootId = async (tenantId: string): Promise<string | null> => {
    const cached = tenantRootCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.rootId;
    }

    const first = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, parentTenantId: true, isActive: true },
    });

    if (!first?.isActive) return null;

    let current: { id: string; parentTenantId: string | null; isActive: boolean } = first;

    for (let depth = 0; current.parentTenantId && depth < 20; depth += 1) {
        const parent: { id: string; parentTenantId: string | null; isActive: boolean } | null = await prisma.tenant.findUnique({
            where: { id: current.parentTenantId },
            select: { id: true, parentTenantId: true, isActive: true },
        });
        if (!parent?.isActive) return null;
        current = parent;
    }

    tenantRootCache.set(tenantId, {
        rootId: current.id,
        expiresAt: Date.now() + TENANT_ROOT_CACHE_TTL_MS,
    });

    return current.id;
};

const TENANT_ROOT_CACHE_TTL_MS = 60_000;
const tenantRootCache = new Map<string, { rootId: string; expiresAt: number }>();

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

        // The token being valid is not enough: the account's current state is
        // checked in the database on every authorized request.
        const employee = await prisma.employee.findUnique({
            where: { id: decoded.id },
            select: {
                isActive: true,
                deletedAt: true,
                bannedAt: true,
                passwordChangedAt: true,
                // Company assignment: which tenants of the tree this account may use.
                allowedTenantIds: true,
            },
        });

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
            email: decoded.email
        };

        next();
    } catch (error) {
        res.status(401).json({ error: error instanceof Error ? error.message : 'Geçersiz veya süresi dolmuş token.' });
    }
};
