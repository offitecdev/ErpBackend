import { Router } from 'express';
import { nanoid } from 'nanoid';
import { requireAuth } from '../middlewares/AuthMiddleware';
import prisma from '../../infrastructure/database/prisma.client';

const router = Router();

// Create a personal notification (e.g. an urgent alert card archived from the
// floating alert deck lands in the recipient's notification list).
router.post('/', requireAuth, async (req, res) => {
    try {
        const user = (req as any).user!;
        const title = String(req.body?.title || '').trim();
        if (!title) return res.status(400).json({ error: 'Başlık gerekli.' });
        const notification = await (prisma as any).notification.create({
            data: {
                id: nanoid(12),
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
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

router.get('/', requireAuth, async (req, res) => {
    try {
        const user = (req as any).user!;
        const unreadOnly = String(req.query.unreadOnly || '') === 'true';
        const notifications = await (prisma as any).notification.findMany({
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
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

router.patch('/:id/read', requireAuth, async (req, res) => {
    try {
        const user = (req as any).user!;
        const notification = await (prisma as any).notification.findFirst({
            where: {
                id: String(req.params.id || ''),
                tenantId: user.tenantId,
                OR: [
                    { recipientEmployeeId: user.id },
                    { recipientEmployeeId: null },
                ],
            },
        });
        if (!notification) return res.status(404).json({ error: 'Bildirim bulunamadi.' });
        const updated = await (prisma as any).notification.update({
            where: { id: notification.id },
            data: { isRead: true, readAt: new Date() },
        });
        res.status(200).json(updated);
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

router.patch('/read-all', requireAuth, async (req, res) => {
    try {
        const user = (req as any).user!;
        await (prisma as any).notification.updateMany({
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
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

export default router;
