"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const nanoid_1 = require("nanoid");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const moduleCatalog_1 = require("../../shared/moduleCatalog");
/**
 * Company categories ("Numara" profiles). Admin-only: every route requires
 * roles.manage. Profiles are scoped to the caller's company tree (root
 * tenant), so trees never see each other's categories.
 */
const router = (0, express_1.Router)();
router.use(AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('roles.manage'));
const callerRootId = async (homeTenantId) => {
    const rootId = await (0, AuthMiddleware_1.findTenantRootId)(homeTenantId);
    if (!rootId)
        throw new Error('Şirket ağacı çözümlenemedi.');
    return rootId;
};
const serializeProfile = (profile) => ({
    id: profile.id,
    profileNumber: profile.profileNumber,
    name: profile.name,
    moduleKeys: Array.isArray(profile.moduleKeys) ? profile.moduleKeys : [],
    tenantIds: (profile.tenants || []).map((tenant) => tenant.id),
});
router.get('/', async (req, res) => {
    try {
        const rootTenantId = await callerRootId(req.user.homeTenantId);
        const profiles = await prisma_client_1.default.moduleProfile.findMany({
            where: { rootTenantId },
            include: { tenants: { select: { id: true } } },
            orderBy: { profileNumber: 'asc' },
        });
        res.status(200).json(profiles.map(serializeProfile));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.post('/', async (req, res) => {
    try {
        const rootTenantId = await callerRootId(req.user.homeTenantId);
        const profileNumber = Number(req.body?.profileNumber);
        const name = String(req.body?.name || '').trim();
        if (!Number.isInteger(profileNumber) || profileNumber < 1) {
            return res.status(400).json({ error: 'Kategori numarası 1 veya daha büyük bir tam sayı olmalıdır.' });
        }
        if (!name)
            return res.status(400).json({ error: 'Kategori adı gereklidir.' });
        const profile = await prisma_client_1.default.moduleProfile.create({
            data: {
                id: (0, nanoid_1.nanoid)(8),
                rootTenantId,
                profileNumber,
                name,
                moduleKeys: (0, moduleCatalog_1.sanitizeModuleKeys)(req.body?.moduleKeys),
            },
            include: { tenants: { select: { id: true } } },
        });
        res.status(201).json(serializeProfile(profile));
    }
    catch (error) {
        if (error?.code === 'P2002') {
            return res.status(400).json({ error: 'Bu numarada bir kategori zaten var.' });
        }
        res.status(400).json({ error: error.message });
    }
});
router.patch('/:id', async (req, res) => {
    try {
        const rootTenantId = await callerRootId(req.user.homeTenantId);
        const existing = await prisma_client_1.default.moduleProfile.findFirst({
            where: { id: String(req.params.id || ''), rootTenantId },
        });
        if (!existing)
            return res.status(404).json({ error: 'Kategori bulunamadı.' });
        const data = {};
        if (req.body?.profileNumber !== undefined) {
            const profileNumber = Number(req.body.profileNumber);
            if (!Number.isInteger(profileNumber) || profileNumber < 1) {
                return res.status(400).json({ error: 'Kategori numarası 1 veya daha büyük bir tam sayı olmalıdır.' });
            }
            data.profileNumber = profileNumber;
        }
        if (req.body?.name !== undefined) {
            const name = String(req.body.name).trim();
            if (!name)
                return res.status(400).json({ error: 'Kategori adı gereklidir.' });
            data.name = name;
        }
        if (req.body?.moduleKeys !== undefined) {
            data.moduleKeys = (0, moduleCatalog_1.sanitizeModuleKeys)(req.body.moduleKeys);
        }
        const profile = await prisma_client_1.default.moduleProfile.update({
            where: { id: existing.id },
            data,
            include: { tenants: { select: { id: true } } },
        });
        res.status(200).json(serializeProfile(profile));
    }
    catch (error) {
        if (error?.code === 'P2002') {
            return res.status(400).json({ error: 'Bu numarada bir kategori zaten var.' });
        }
        res.status(400).json({ error: error.message });
    }
});
router.delete('/:id', async (req, res) => {
    try {
        const rootTenantId = await callerRootId(req.user.homeTenantId);
        const existing = await prisma_client_1.default.moduleProfile.findFirst({
            where: { id: String(req.params.id || ''), rootTenantId },
        });
        if (!existing)
            return res.status(404).json({ error: 'Kategori bulunamadı.' });
        await prisma_client_1.default.$transaction([
            prisma_client_1.default.tenant.updateMany({
                where: { moduleProfileId: existing.id },
                data: { moduleProfileId: null },
            }),
            prisma_client_1.default.moduleProfile.delete({ where: { id: existing.id } }),
        ]);
        res.status(200).json({ message: 'Kategori silindi.' });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
// Map one company to a category (or clear it with profileId: null).
router.patch('/assign/tenant', async (req, res) => {
    try {
        const rootTenantId = await callerRootId(req.user.homeTenantId);
        const tenantId = String(req.body?.tenantId || '');
        const profileId = req.body?.profileId ? String(req.body.profileId) : null;
        const tenantRootId = await (0, AuthMiddleware_1.findTenantRootId)(tenantId);
        if (!tenantId || tenantRootId !== rootTenantId) {
            return res.status(404).json({ error: 'Şirket bulunamadı.' });
        }
        if (profileId) {
            const profile = await prisma_client_1.default.moduleProfile.findFirst({ where: { id: profileId, rootTenantId } });
            if (!profile)
                return res.status(404).json({ error: 'Kategori bulunamadı.' });
        }
        await prisma_client_1.default.tenant.update({
            where: { id: tenantId },
            data: { moduleProfileId: profileId },
        });
        res.status(200).json({ message: 'Şirket kategorisi güncellendi.' });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=moduleProfile.routes.js.map