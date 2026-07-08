import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../../infrastructure/database/prisma.client';

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

const findTenantRootId = async (tenantId: string): Promise<string | null> => {
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

const resolveTenantId = async (homeTenantId: string, requestedTenantId?: string): Promise<string> => {
    const requested = requestedTenantId?.trim();
    if (!requested || requested === homeTenantId) return homeTenantId;

    const [homeRootId, requestedRootId] = await Promise.all([
        findTenantRootId(homeTenantId),
        findTenantRootId(requested),
    ]);

    if (!homeRootId || homeRootId !== requestedRootId) {
        throw new Error('Bu şirket için erişim yetkiniz yok.');
    }

    return requested;
};

export const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Kimlik doğrulama reddedildi: Token bulunamadı.' });
        return;
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
        res.status(401).json({ error: 'Kimlik doğrulama reddedildi: Token bulunamadı.' });
        return;
    }

    try {
        const secret = process.env.OFFITEC_JWT_SECRET;
        if (!secret) throw new Error('JWT Secret tanımlı değil!');

        // Pin the algorithm so a forged token can't downgrade to "none" or a
        // different scheme; only our own HS256-signed tokens are accepted.
        const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
        if (!decoded || typeof decoded !== 'object' || !decoded.id || !decoded.tenantId || !decoded.email) {
            res.status(401).json({ error: 'Geçersiz token içeriği.' });
            return;
        }
        const homeTenantId = decoded.tenantId as string;
        const tenantId = await resolveTenantId(homeTenantId, req.header('x-tenant-id'));
        
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
