import { Router } from 'express';
import { AttendanceController } from '../controllers/AttendanceController';
import { CheckInUseCase } from '../../application/use-cases/attandance/CheckInUseCase';
import { CheckOutUseCase } from '../../application/use-cases/attandance/CheckOutUseCase';
import { StartBreakUseCase } from '../../application/use-cases/attandance/StartBreakUseCase';
import { EndBreakUseCase } from '../../application/use-cases/attandance/EndBreakUseCase';
import { ListAttendanceUseCase } from '../../application/use-cases/attandance/ListAttendanceUseCase';
import { UpdateAttendanceUseCase } from '../../application/use-cases/attandance/UpdateAttendanceUseCase';
import { GetMeUseCase } from '../../application/use-cases/auth/GetMeUseCase';
import { AttendanceLogRepository } from '../../infrastructure/repositories/AttendanceLogRepository';
import { EmployeeRepository } from '../../infrastructure/repositories/EmployeeRepository';
import { TenantRepository } from '../../infrastructure/repositories/TenantRepository';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requirePermission } from '../middlewares/RbacMiddleware';
import { parseWorkSchedule } from '../../application/utils/workSchedule';
import { AttendanceLog } from '../../domain/entities/AttendanceLog';

const router = Router();

const attendanceRepo = new AttendanceLogRepository();
const employeeRepo = new EmployeeRepository();
const tenantRepo = new TenantRepository();
const checkOutUseCase = new CheckOutUseCase(attendanceRepo, employeeRepo, tenantRepo);
const checkInUseCase = new CheckInUseCase(attendanceRepo, employeeRepo, tenantRepo, checkOutUseCase);
const startBreakUseCase = new StartBreakUseCase(attendanceRepo);
const endBreakUseCase = new EndBreakUseCase(attendanceRepo);
const listAttendanceUseCase = new ListAttendanceUseCase(attendanceRepo);
const updateAttendanceUseCase = new UpdateAttendanceUseCase(attendanceRepo);
const getMeUseCase = new GetMeUseCase(employeeRepo);
const attendanceController = new AttendanceController(
    checkInUseCase,
    checkOutUseCase,
    startBreakUseCase,
    endBreakUseCase,
    listAttendanceUseCase,
    updateAttendanceUseCase,
    getMeUseCase
);

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
router.post(
    '/check-in',
    requireAuth,
    (req, res) => attendanceController.checkIn(req, res)
);

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
router.post(
    '/check-out',
    requireAuth,
    (req, res) => attendanceController.checkOut(req, res)
);

router.post('/break/start', requireAuth, (req, res) => attendanceController.startBreak(req, res));

router.post('/break/end', requireAuth, (req, res) => attendanceController.endBreak(req, res));

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
router.get(
    '/',
    requireAuth,
    requirePermission('attendance.read'),
    (req, res) => attendanceController.list(req, res)
);

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
router.patch(
    '/:id',
    requireAuth,
    requirePermission('attendance.update'),
    (req, res) => attendanceController.update(req, res)
);

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
router.get(
    '/work-schedule',
    requireAuth,
    async (req, res) => {
        try {
            if (!req.user?.tenantId) {
                return res.status(401).json({ error: 'Yetkisiz erişim.' });
            }
            const tenant = await tenantRepo.findById(req.user.tenantId);
            const schedule = parseWorkSchedule(tenant?.workScheduleJson ?? null);
            return res.status(200).json({ schedule });
        } catch {
            return res.status(500).json({ error: 'Çizelge yüklenemedi.' });
        }
    }
);

function attendanceLogToJson(r: AttendanceLog) {
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

router.get(
    '/me/today',
    requireAuth,
    async (req, res) => {
        try {
            if (!req.user || !req.user.id || !req.user.tenantId) {
                return res.status(401).json({ error: 'Yetkisiz erişim.' });
            }
            const userId: string = req.user.id;

            const today = new Date().toISOString().split('T')[0];

            const tenant = await tenantRepo.findById(req.user.tenantId);
            const stationQrPayload =
                (tenant?.checkInQrSecret ?? '').trim() || null;

            const recentRaw = await attendanceRepo.findByEmployeeId(userId);
            const recentLogs = recentRaw.map((r: Record<string, unknown>) => ({
                id: r.id,
                logDate: r.logDate,
                checkInTime: r.checkInTime,
                checkOutTime: r.checkOutTime,
                netWorkSeconds: r.netWorkSeconds ?? null,
            }));

            const todayRecord = await attendanceRepo.findByEmployeeAndDate(
                userId,
                today as string
            );

            if (!todayRecord) {
                return res.status(200).json({ stationQrPayload, recentLogs });
            }

            return res.status(200).json({
                ...attendanceLogToJson(todayRecord),
                stationQrPayload,
                recentLogs,
            });
        } catch (error) {
            return res.status(500).json({ error: 'Durum kontrol edilemedi' });
        }
    }
);

export default router;
