"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AttendanceController_1 = require("../controllers/AttendanceController");
const CheckInUseCase_1 = require("../../application/use-cases/attandance/CheckInUseCase");
const CheckOutUseCase_1 = require("../../application/use-cases/attandance/CheckOutUseCase");
const StartBreakUseCase_1 = require("../../application/use-cases/attandance/StartBreakUseCase");
const EndBreakUseCase_1 = require("../../application/use-cases/attandance/EndBreakUseCase");
const ListAttendanceUseCase_1 = require("../../application/use-cases/attandance/ListAttendanceUseCase");
const UpdateAttendanceUseCase_1 = require("../../application/use-cases/attandance/UpdateAttendanceUseCase");
const GetMeUseCase_1 = require("../../application/use-cases/auth/GetMeUseCase");
const AttendanceLogRepository_1 = require("../../infrastructure/repositories/AttendanceLogRepository");
const EmployeeRepository_1 = require("../../infrastructure/repositories/EmployeeRepository");
const TenantRepository_1 = require("../../infrastructure/repositories/TenantRepository");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const workSchedule_1 = require("../../application/utils/workSchedule");
const router = (0, express_1.Router)();
const attendanceRepo = new AttendanceLogRepository_1.AttendanceLogRepository();
const employeeRepo = new EmployeeRepository_1.EmployeeRepository();
const tenantRepo = new TenantRepository_1.TenantRepository();
const checkOutUseCase = new CheckOutUseCase_1.CheckOutUseCase(attendanceRepo, employeeRepo, tenantRepo);
const checkInUseCase = new CheckInUseCase_1.CheckInUseCase(attendanceRepo, employeeRepo, tenantRepo, checkOutUseCase);
const startBreakUseCase = new StartBreakUseCase_1.StartBreakUseCase(attendanceRepo);
const endBreakUseCase = new EndBreakUseCase_1.EndBreakUseCase(attendanceRepo);
const listAttendanceUseCase = new ListAttendanceUseCase_1.ListAttendanceUseCase(attendanceRepo);
const updateAttendanceUseCase = new UpdateAttendanceUseCase_1.UpdateAttendanceUseCase(attendanceRepo);
const getMeUseCase = new GetMeUseCase_1.GetMeUseCase(employeeRepo);
const attendanceController = new AttendanceController_1.AttendanceController(checkInUseCase, checkOutUseCase, startBreakUseCase, endBreakUseCase, listAttendanceUseCase, updateAttendanceUseCase, getMeUseCase);
/**
 * @swagger
 * /attendance/check-in:
 *   post:
 *     tags: [Attendance]
 *     summary: Personel giriş kaydı oluştur
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Giriş kaydedildi
 *       400:
 *         description: Hata (zaten giriş yapılmış vb.)
 */
router.post('/check-in', AuthMiddleware_1.requireAuth, (req, res) => attendanceController.checkIn(req, res));
/**
 * @swagger
 * /attendance/check-out:
 *   post:
 *     tags: [Attendance]
 *     summary: Personel çıkış kaydı oluştur
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Çıkış kaydedildi
 *       400:
 *         description: Hata (giriş bulunamadı vb.)
 */
router.post('/check-out', AuthMiddleware_1.requireAuth, (req, res) => attendanceController.checkOut(req, res));
router.post('/break/start', AuthMiddleware_1.requireAuth, (req, res) => attendanceController.startBreak(req, res));
router.post('/break/end', AuthMiddleware_1.requireAuth, (req, res) => attendanceController.endBreak(req, res));
/**
 * @swagger
 * /attendance:
 *   get:
 *     tags: [Attendance]
 *     summary: Devam kayıtlarını listele (tarih bazlı)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date
 *         schema:
 *           type: string
 *           format: date
 *         description: Tarih filtresi (YYYY-MM-DD)
 *     responses:
 *       200:
 *         description: Devam listesi
 *       401:
 *         description: Yetkisiz
 */
router.get('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('attendance.read'), (req, res) => attendanceController.list(req, res));
/**
 * @swagger
 * /attendance/{id}:
 *   patch:
 *     tags: [Attendance]
 *     summary: Devam kaydını manuel düzelt (İK yetkisi)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               checkInTime:
 *                 type: string
 *                 format: date-time
 *               checkOutTime:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Kayıt güncellendi (audit loglu)
 *       400:
 *         description: Hata
 */
router.patch('/:id', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('attendance.update'), (req, res) => attendanceController.update(req, res));
/**
 * @swagger
 * /attendance/me/today:
 *   get:
 *     tags: [Attendance]
 *     summary: Giriş yapan kullanıcının bugünkü giriş-çıkış bilgisini getir
 *     security:
 *       - bearerAuth: []
 */
/**
 * Personelin görebileceği mesai çizelgesi (QR sırları dönmez)
 */
router.get('/work-schedule', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        if (!req.user?.tenantId) {
            return res.status(401).json({ error: 'Yetkisiz erişim.' });
        }
        const tenant = await tenantRepo.findById(req.user.tenantId);
        const schedule = (0, workSchedule_1.parseWorkSchedule)(tenant?.workScheduleJson ?? null);
        return res.status(200).json({ schedule });
    }
    catch {
        return res.status(500).json({ error: 'Çizelge yüklenemedi.' });
    }
});
function attendanceLogToJson(r) {
    return {
        id: r.id,
        employeeId: r.employeeId,
        logDate: r.logDate,
        checkInTime: r.checkInTime,
        checkOutTime: r.checkOutTime,
        breakPeriodsJson: r.breakPeriodsJson,
        netWorkSeconds: r.netWorkSeconds,
    };
}
router.get('/me/today', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        if (!req.user || !req.user.id || !req.user.tenantId) {
            return res.status(401).json({ error: 'Yetkisiz erişim.' });
        }
        const userId = req.user.id;
        const today = new Date().toISOString().split('T')[0];
        const tenant = await tenantRepo.findById(req.user.tenantId);
        const stationQrPayload = (tenant?.checkInQrSecret ?? '').trim() || null;
        const recentRaw = await attendanceRepo.findByEmployeeId(userId);
        const recentLogs = recentRaw.map((r) => ({
            id: r.id,
            logDate: r.logDate,
            checkInTime: r.checkInTime,
            checkOutTime: r.checkOutTime,
            netWorkSeconds: r.netWorkSeconds ?? null,
        }));
        const todayRecord = await attendanceRepo.findByEmployeeAndDate(userId, today);
        if (!todayRecord) {
            return res.status(200).json({ stationQrPayload, recentLogs });
        }
        return res.status(200).json({
            ...attendanceLogToJson(todayRecord),
            stationQrPayload,
            recentLogs,
        });
    }
    catch (error) {
        return res.status(500).json({ error: 'Durum kontrol edilemedi' });
    }
});
exports.default = router;
//# sourceMappingURL=attendance.routes.js.map