import { Request, Response, NextFunction } from 'express';
import { jwtTokenService, toPwdAtClaim } from '../../infrastructure/services/JwtTokenService';
import { ACCESS_COOKIE, CSRF_COOKIE, clearAuthCookies } from '../utils/authCookies';
import { parseAllowedTenantIds } from '../utils/tenantAccess';
import { getAuthIdentity } from '../../shared/authIdentityCache';
import { mayReachWholeCompanyTree } from '../../shared/tenantSwitchAccess';
import { findTenantRootIdCached, getAllTenants } from '../../shared/tenantTree';

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
 * The employee's assigned companies, reduced to the ones that still exist and
 * are active. Empty result = no usable assignment left.
 *
 * IT NO LONGER FILTERS BY COMPANY TREE (Vorgabe 31.08.2026). Until then an
 * assignment could only ever NARROW the caller's own tree, so a company set up
 * as its own root — a second company group in the same installation — was
 * silently dropped here even after an administrator had explicitly ticked it.
 * The tick IS the decision now; see getAssignableTenantIds. The tree wall
 * stays exactly where it always was, one level down: it guards companies
 * NOBODY assigned (see resolveTenantId).
 */
const keepUsableAssignments = async (assigned: string[]): Promise<string[]> => {
    const tenants = await getAllTenants();
    const active = new Set(tenants.filter((tenant) => tenant.isActive).map((tenant) => tenant.id));
    return assigned.filter((tenantId) => active.has(tenantId));
};

/**
 * A company of a FOREIGN tree is never served — that is the hard boundary.
 * (An unassigned company of the caller's OWN tree is treated as a stale browser
 * selection by the callers below, not as an attack.)
 */
const assertSameCompanyTree = async (homeTenantId: string, requestedTenantId: string): Promise<void> => {
    const [homeRootId, requestedRootId] = await Promise.all([
        findTenantRootId(homeTenantId),
        findTenantRootId(requestedTenantId),
    ]);
    if (!homeRootId || homeRootId !== requestedRootId) {
        throw new Error('Bu şirket için erişim yetkiniz yok.');
    }
};

const resolveTenantId = async (
    employeeId: string,
    homeTenantId: string,
    allowedTenantIds: string[] | null,
    requestedTenantId?: string,
): Promise<string> => {
    const requested = requestedTenantId?.trim();

    // No company assignment saved = the OWN company, nothing else (31.08.2026).
    // Until then an unassigned account reached its whole company tree, which is
    // exactly how staff of one sub-company ended up seeing their sister
    // companies. Reaching a second company is now a deliberate act: an admin
    // ticks it under Personal → Person → Zugang.
    if (!allowedTenantIds?.length) {
        if (!requested || requested === homeTenantId) return homeTenantId;
        await assertSameCompanyTree(homeTenantId, requested);
        // The ROLE may open the whole own tree (31.08.2026): administrators and
        // every role carrying `canSwitchTenant` — the management and the
        // project leads — reach every company of their group without being
        // ticked into each one by hand. The tree boundary above still holds.
        if (await mayReachWholeCompanyTree(employeeId)) return requested;
        // In the own tree but not assigned: a stale selection left in the
        // browser. Serve the home company instead of failing every request —
        // the switcher list corrects the stored id on the next session load.
        return homeTenantId;
    }

    const homeRootId = await findTenantRootId(homeTenantId);
    if (!homeRootId) {
        throw new Error('Bu şirket için erişim yetkiniz yok.');
    }

    const allowed = await keepUsableAssignments(allowedTenantIds);
    // Every assigned company vanished (deactivated / deleted): fall back to the
    // unassigned rules instead of locking the account out.
    if (!allowed.length) return resolveTenantId(employeeId, homeTenantId, null, requestedTenantId);

    // Without a selection the home tenant wins, but only if it was assigned —
    // otherwise the first assigned company becomes the default one.
    const fallback = allowed.includes(homeTenantId) ? homeTenantId : allowed[0]!;
    if (!requested) return fallback;
    // An explicitly ticked company is served, whatever tree it sits in — an
    // administrator picked it by hand on the access page, which is a stronger
    // statement than the shape of the company tree (Vorgabe 31.08.2026).
    if (allowed.includes(requested)) return requested;
    // Not assigned. Same reasoning as above: a company of the own tree is a
    // stale browser selection, a company of a FOREIGN group is refused outright.
    await assertSameCompanyTree(homeTenantId, requested);
    // … unless the role opens the whole tree. It OUTRANKS the assignment
    // (Vorgabe 31.08.2026): a saved tick list narrows who counts as staff of a
    // company, never where an administrator or project lead may look.
    if (await mayReachWholeCompanyTree(employeeId)) return requested;
    return fallback;
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
            decoded.id,
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
