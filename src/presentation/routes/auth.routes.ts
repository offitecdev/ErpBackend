import { Router } from 'express';
import { AuthController } from '../controllers/AuthController';
import { LoginUseCase } from '../../application/use-cases/auth/LoginUseCase';
import { GetUserPermissionsUseCase } from '../../application/use-cases/auth/GetUserPermissionsUseCase';
import { EmployeeRepository } from '../../infrastructure/repositories/EmployeeRepository';
import { RoleRepository } from '../../infrastructure/repositories/RoleRepository';
import { BcryptCryptoService } from '../../infrastructure/services/BcryptCryptoService';
import { JwtTokenService } from '../../infrastructure/services/JwtTokenService';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { rateLimit } from '../middlewares/RateLimitMiddleware';
import { GetMeUseCase } from '../../application/use-cases/auth/GetMeUseCase';
import { RefreshTokenUseCase } from '../../application/use-cases/auth/RefreshTokenUseCase';
import { RequestAccountActivationUseCase, ActivateAccountUseCase } from '../../application/use-cases/auth/AccountActivationUseCases';
import { RequestPasswordResetUseCase, ResetPasswordUseCase } from '../../application/use-cases/auth/PasswordResetUseCases';
import { RequestAccountDeletionUseCase, ConfirmAccountDeletionUseCase } from '../../application/use-cases/auth/AccountDeletionUseCases';
import { AuthMailService } from '../../infrastructure/services/AuthMailService';
import { validate } from '../middlewares/ValidationMiddleware';
import { loginSchema, emailRequestSchema, tokenConfirmSchema, passwordResetConfirmSchema } from '../validation/authSchemas';

// Throttle credential attempts per IP to blunt brute-force / enumeration.
// Only failed attempts count, so normal logins never eat into the budget.
const loginRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Çok fazla giriş denemesi. Lütfen bir süre sonra tekrar deneyin.',
    skipSuccessfulRequests: true,
});

// Separate limiter (own counter) for silent token refresh: the frontend calls
// this on every 401, so it must not share the login brute-force budget.
const refreshRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    message: 'Çok fazla istek gönderildi. Lütfen bir süre sonra tekrar deneyin.',
    skipSuccessfulRequests: true,
});

// Tighter limit for the mail-sending flows (activation / reset / deletion
// requests) so they can't be abused to spam mailboxes.
const mailFlowRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Çok fazla istek gönderildi. Lütfen bir süre sonra tekrar deneyin.',
});


const router = Router();

const employeeRepo              = new EmployeeRepository();
const roleRepo                  = new RoleRepository();
const cryptoService             = new BcryptCryptoService();
const tokenService              = new JwtTokenService();
const authMailService           = new AuthMailService();
const loginUseCase              = new LoginUseCase(employeeRepo, cryptoService, tokenService);
const getUserPermissionsUseCase = new GetUserPermissionsUseCase(roleRepo);
const getMeUseCase = new GetMeUseCase(employeeRepo);
const refreshTokenUseCase       = new RefreshTokenUseCase(employeeRepo, tokenService);
const requestActivationUseCase  = new RequestAccountActivationUseCase(employeeRepo, tokenService, authMailService);
const activateAccountUseCase    = new ActivateAccountUseCase(employeeRepo, tokenService);
const requestPasswordResetUseCase = new RequestPasswordResetUseCase(employeeRepo, tokenService, authMailService);
const resetPasswordUseCase      = new ResetPasswordUseCase(employeeRepo, tokenService, cryptoService);
const requestAccountDeletionUseCase = new RequestAccountDeletionUseCase(employeeRepo, tokenService, authMailService);
const confirmAccountDeletionUseCase = new ConfirmAccountDeletionUseCase(employeeRepo, tokenService);

const authController = new AuthController(
    loginUseCase,
    getUserPermissionsUseCase,
    getMeUseCase,
    refreshTokenUseCase,
    requestActivationUseCase,
    activateAccountUseCase,
    requestPasswordResetUseCase,
    resetPasswordUseCase,
    requestAccountDeletionUseCase,
    confirmAccountDeletionUseCase,
);
/**
 * @swagger
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Kullanıcı girişi (JWT token alır)
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *     responses:
 *       200:
 *         description: Başarılı giriş
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginResponse'
 *       400:
 *         description: Geçersiz kimlik bilgileri
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/login', loginRateLimiter, validate({ body: loginSchema }), (req, res) => authController.login(req, res));

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Refresh token ile yeni access + refresh token alır
 *     security: []
 *     description: Refresh token HttpOnly cookie üzerinden okunur; yeni tokenlar yine cookie olarak yazılır.
 *     responses:
 *       200:
 *         description: Token yenilendi (yeni cookie'ler yazıldı)
 *       401:
 *         description: Geçersiz veya süresi dolmuş refresh token (cookie'ler temizlenir)
 */
router.post('/refresh', refreshRateLimiter, (req, res) => authController.refresh(req, res));

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Oturumu kapatır (HttpOnly auth cookie'lerini temizler)
 *     security: []
 *     responses:
 *       200:
 *         description: Çıkış yapıldı
 */
router.post('/logout', (req, res) => authController.logout(req, res));

/**
 * @swagger
 * /auth/activation/request:
 *   post:
 *     tags: [Auth]
 *     summary: Pasif hesap için aktivasyon bağlantısı gönderir (hesap var/yok bilgisi sızdırmaz)
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: İstek alındı
 */
router.post('/activation/request', mailFlowRateLimiter, validate({ body: emailRequestSchema }), (req, res) => authController.requestActivation(req, res));

/**
 * @swagger
 * /auth/activation/confirm:
 *   post:
 *     tags: [Auth]
 *     summary: Aktivasyon token'ı ile hesabı etkinleştirir
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Hesap etkinleştirildi
 *       400:
 *         description: Geçersiz veya süresi dolmuş token
 */
router.post('/activation/confirm', mailFlowRateLimiter, validate({ body: tokenConfirmSchema }), (req, res) => authController.activate(req, res));

/**
 * @swagger
 * /auth/password-reset/request:
 *   post:
 *     tags: [Auth]
 *     summary: Parola sıfırlama bağlantısı gönderir (hesap var/yok bilgisi sızdırmaz)
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *     responses:
 *       200:
 *         description: İstek alındı
 */
router.post('/password-reset/request', mailFlowRateLimiter, validate({ body: emailRequestSchema }), (req, res) => authController.requestPasswordReset(req, res));

/**
 * @swagger
 * /auth/password-reset/confirm:
 *   post:
 *     tags: [Auth]
 *     summary: Sıfırlama token'ı ile yeni parola belirler (önceki tüm token'ları geçersiz kılar)
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, newPassword]
 *             properties:
 *               token:
 *                 type: string
 *               newPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: Parola güncellendi
 *       400:
 *         description: Geçersiz veya süresi dolmuş token
 */
router.post('/password-reset/confirm', mailFlowRateLimiter, validate({ body: passwordResetConfirmSchema }), (req, res) => authController.resetPassword(req, res));

/**
 * @swagger
 * /auth/account-deletion/request:
 *   post:
 *     tags: [Auth]
 *     summary: Giriş yapmış kullanıcıya hesap silme onay bağlantısı gönderir
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Onay bağlantısı gönderildi
 *       401:
 *         description: Yetkisiz
 */
router.post('/account-deletion/request', requireAuth, mailFlowRateLimiter, (req, res) => authController.requestAccountDeletion(req, res));

/**
 * @swagger
 * /auth/account-deletion/confirm:
 *   post:
 *     tags: [Auth]
 *     summary: Silme token'ı ile hesabı kalıcı olarak pasifleştirir (soft delete)
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token]
 *             properties:
 *               token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Hesap silindi
 *       400:
 *         description: Geçersiz veya süresi dolmuş token
 */
router.post('/account-deletion/confirm', mailFlowRateLimiter, validate({ body: tokenConfirmSchema }), (req, res) => authController.confirmAccountDeletion(req, res));

/**
 * @swagger
 * /auth/me/permissions:
 *   get:
 *     tags: [Auth]
 *     summary: Giriş yapan kullanıcının yetkilerini getir
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Yetki listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 permissions:
 *                   type: array
 *                   items:
 *                     type: string
 *       401:
 *         description: Yetkisiz
 */
router.get('/me/permissions', requireAuth, (req, res) => authController.getPermissions(req, res));

/**
 * @swagger
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Giriş yapan kullanıcının bilgilerini getir
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Kullanıcı bilgileri
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Employee'
 *       401:
 *         description: Yetkisiz
 */
router.get('/me', requireAuth, (req, res) => authController.getMe(req, res));

export default router;
