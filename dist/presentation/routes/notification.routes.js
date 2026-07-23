"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const nanoid_1 = require("nanoid");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const router = (0, express_1.Router)();
// Create a personal notification (e.g. an urgent alert card archived from the
// floating alert deck lands in the recipient's notification list).
router.post('/', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const user = req.user;
        const title = String(req.body?.title || '').trim();
        if (!title)
            return res.status(400).json({ error: 'Başlık gerekli.' });
        const notification = await prisma_client_1.default.notification.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId: user.tenantId,
                recipientEmployeeId: user.id,
                type: String(req.body?.type || 'ALERT'),
                title,
                message: String(req.body?.message || ''),
                linkUrl: req.body?.linkUrl ? String(req.body.linkUrl) : null,
                isRead: Boolean(req.body?.isRead) || false,
                readAt: req.body?.isRead ? new Date() : null,
            },
        });
        res.status(201).json(notification);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.get('/', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const user = req.user;
        const unreadOnly = String(req.query.unreadOnly || '') === 'true';
        const notifications = await prisma_client_1.default.notification.findMany({
            where: {
                tenantId: user.tenantId,
                ...(unreadOnly ? { isRead: false } : {}),
                OR: [
                    { recipientEmployeeId: user.id },
                    { recipientEmployeeId: null },
                ],
            },
            orderBy: { createdAt: 'desc' },
            take: Math.min(Number(req.query.limit || 30), 100),
        });
        res.status(200).json(notifications);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.patch('/:id/read', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const user = req.user;
        const notification = await prisma_client_1.default.notification.findFirst({
            where: {
                id: String(req.params.id || ''),
                tenantId: user.tenantId,
                OR: [
                    { recipientEmployeeId: user.id },
                    { recipientEmployeeId: null },
                ],
            },
        });
        if (!notification)
            return res.status(404).json({ error: 'Bildirim bulunamadi.' });
        const updated = await prisma_client_1.default.notification.update({
            where: { id: notification.id },
            data: { isRead: true, readAt: new Date() },
        });
        res.status(200).json(updated);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
router.patch('/read-all', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const user = req.user;
        await prisma_client_1.default.notification.updateMany({
            where: {
                tenantId: user.tenantId,
                isRead: false,
                OR: [
                    { recipientEmployeeId: user.id },
                    { recipientEmployeeId: null },
                ],
            },
            data: { isRead: true, readAt: new Date() },
        });
        res.status(200).json({ message: 'Bildirimler okundu.' });
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=notification.routes.js.map