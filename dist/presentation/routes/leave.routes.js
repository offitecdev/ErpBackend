"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const LeaveController_1 = require("../controllers/LeaveController");
const CreateLeaveRequestUseCase_1 = require("../../application/use-cases/leave/CreateLeaveRequestUseCase");
const ApproveLeaveRequestUseCase_1 = require("../../application/use-cases/leave/ApproveLeaveRequestUseCase");
const ListLeavesUseCase_1 = require("../../application/use-cases/leave/ListLeavesUseCase");
const LeaveRequestRepository_1 = require("../../infrastructure/repositories/LeaveRequestRepository");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const router = (0, express_1.Router)();
const leaveRequestRepository = new LeaveRequestRepository_1.LeaveRequestRepository();
const createLeaveUseCase = new CreateLeaveRequestUseCase_1.CreateLeaveRequestUseCase(leaveRequestRepository);
const approveLeaveUseCase = new ApproveLeaveRequestUseCase_1.ApproveLeaveRequestUseCase(leaveRequestRepository);
const listLeavesUseCase = new ListLeavesUseCase_1.ListLeavesUseCase(leaveRequestRepository);
const leaveController = new LeaveController_1.LeaveController(createLeaveUseCase, approveLeaveUseCase, listLeavesUseCase);
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
router.get('/types', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const types = await prisma_client_1.default.leaveType.findMany({
            where: { tenantId }
        });
        res.status(200).json(types);
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
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
router.get('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('leaves.read'), (req, res) => leaveController.list(req, res));
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
router.post('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('leaves.create'), (req, res) => {
    req.body.employeeId = req.user?.id;
    leaveController.createLeaveRequest(req, res);
});
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
router.patch('/:id/evaluate', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('leaves.approve'), (req, res) => {
    req.body.managerId = req.user?.id;
    leaveController.evaluateLeaveRequest(req, res);
});
exports.default = router;
//# sourceMappingURL=leave.routes.js.map