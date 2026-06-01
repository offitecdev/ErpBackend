import { Router } from 'express';
import { LeaveController } from '../controllers/LeaveController';
import { CreateLeaveRequestUseCase } from '../../application/use-cases/leave/CreateLeaveRequestUseCase';
import { ApproveLeaveRequestUseCase } from '../../application/use-cases/leave/ApproveLeaveRequestUseCase';
import { ListLeavesUseCase } from '../../application/use-cases/leave/ListLeavesUseCase';
import { LeaveRequestRepository } from '../../infrastructure/repositories/LeaveRequestRepository';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import prisma from '../../infrastructure/database/prisma.client';

const router = Router();

const leaveRequestRepository = new LeaveRequestRepository();
const createLeaveUseCase     = new CreateLeaveRequestUseCase(leaveRequestRepository);
const approveLeaveUseCase    = new ApproveLeaveRequestUseCase(leaveRequestRepository);
const listLeavesUseCase      = new ListLeavesUseCase(leaveRequestRepository);
const leaveController        = new LeaveController(createLeaveUseCase, approveLeaveUseCase, listLeavesUseCase);

/**
 * @swagger
 * /leaves/types:
 *   get:
 *     tags: [Leaves]
 *     summary: İzin türlerini listele
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: İzin türleri listesi
 *       401:
 *         description: Yetkisiz
 */
router.get(
    '/types',
    requireAuth,
    async (req, res) => {
        try {
            const tenantId = req.user!.tenantId;
            const types = await prisma.leaveType.findMany({
                where: { tenantId }
            });
            res.status(200).json(types);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    },
);

/**
 * @swagger
 * /leaves:
 *   get:
 *     tags: [Leaves]
 *     summary: İzin taleplerini listele
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Durum filtresi (Pending, Approved, Rejected)
 *       - in: query
 *         name: all
 *         schema:
 *           type: boolean
 *         description: true ise tüm tenant izinleri, false/yoksa sadece kendi izinleri
 *     responses:
 *       200:
 *         description: İzin listesi
 *       401:
 *         description: Yetkisiz
 */
router.get(
    '/',
    requireAuth,
    requirePermission('leaves.read'),
    (req, res) => leaveController.list(req, res),
);

/**
 * @swagger
 * /leaves:
 *   post:
 *     tags: [Leaves]
 *     summary: Yeni izin talebi oluştur
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateLeaveRequest'
 *     responses:
 *       201:
 *         description: İzin talebi oluşturuldu
 *       400:
 *         description: Geçersiz veri
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Yetkisiz
 *       403:
 *         description: Erişim reddedildi
 */
router.post(
    '/',
    requireAuth,
    requirePermission('leaves.create'),
    (req, res) => {
        req.body.employeeId = req.user?.id;
        leaveController.createLeaveRequest(req, res);
    },
);

/**
 * @swagger
 * /leaves/{id}/evaluate:
 *   patch:
 *     tags: [Leaves]
 *     summary: İzin talebini onayla veya reddet
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: İzin talebi ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/EvaluateLeaveRequest'
 *     responses:
 *       200:
 *         description: İşlem tamamlandı
 *       400:
 *         description: Geçersiz veri
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Yetkisiz
 *       403:
 *         description: Erişim reddedildi
 */
router.patch(
    '/:id/evaluate',
    requireAuth,
    requirePermission('leaves.approve'),
    (req, res) => {
        req.body.managerId = req.user?.id;
        leaveController.evaluateLeaveRequest(req, res);
    },
);

export default router;