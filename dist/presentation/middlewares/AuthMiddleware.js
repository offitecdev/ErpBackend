"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const findTenantRootId = async (tenantId) => {
    const cached = tenantRootCache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.rootId;
    }
    const first = await prisma_client_1.default.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, parentTenantId: true, isActive: true },
    });
    if (!first?.isActive)
        return null;
    let current = first;
    for (let depth = 0; current.parentTenantId && depth < 20; depth += 1) {
        const parent = await prisma_client_1.default.tenant.findUnique({
            where: { id: current.parentTenantId },
            select: { id: true, parentTenantId: true, isActive: true },
        });
        if (!parent?.isActive)
            return null;
        current = parent;
    }
    tenantRootCache.set(tenantId, {
        rootId: current.id,
        expiresAt: Date.now() + TENANT_ROOT_CACHE_TTL_MS,
    });
    return current.id;
};
const TENANT_ROOT_CACHE_TTL_MS = 60_000;
const tenantRootCache = new Map();
const resolveTenantId = async (homeTenantId, requestedTenantId) => {
    const requested = requestedTenantId?.trim();
    if (!requested || requested === homeTenantId)
        return homeTenantId;
    const [homeRootId, requestedRootId] = await Promise.all([
        findTenantRootId(homeTenantId),
        findTenantRootId(requested),
    ]);
    if (!homeRootId || homeRootId !== requestedRootId) {
        throw new Error('Bu şirket için erişim yetkiniz yok.');
    }
    return requested;
};
const requireAuth = async (req, res, next) => {
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
        if (!secret)
            throw new Error('JWT Secret tanımlı değil!');
        const decoded = jsonwebtoken_1.default.verify(token, secret);
        const homeTenantId = decoded.tenantId;
        const tenantId = await resolveTenantId(homeTenantId, req.header('x-tenant-id'));
        req.user = {
            id: decoded.id,
            tenantId,
            homeTenantId,
            email: decoded.email
        };
        next();
    }
    catch (error) {
        res.status(401).json({ error: error instanceof Error ? error.message : 'Geçersiz veya süresi dolmuş token.' });
    }
};
exports.requireAuth = requireAuth;
//# sourceMappingURL=AuthMiddleware.js.map