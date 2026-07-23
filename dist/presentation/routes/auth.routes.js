"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthController_1 = require("../controllers/AuthController");
const LoginUseCase_1 = require("../../application/use-cases/auth/LoginUseCase");
const GetUserPermissionsUseCase_1 = require("../../application/use-cases/auth/GetUserPermissionsUseCase");
const EmployeeRepository_1 = require("../../infrastructure/repositories/EmployeeRepository");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
const BcryptCryptoService_1 = require("../../infrastructure/services/BcryptCryptoService");
const JwtTokenService_1 = require("../../infrastructure/services/JwtTokenService");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RateLimitMiddleware_1 = require("../middlewares/RateLimitMiddleware");
const GetMeUseCase_1 = require("../../application/use-cases/auth/GetMeUseCase");
const RefreshTokenUseCase_1 = require("../../application/use-cases/auth/RefreshTokenUseCase");
const AccountActivationUseCases_1 = require("../../application/use-cases/auth/AccountActivationUseCases");
const PasswordResetUseCases_1 = require("../../application/use-cases/auth/PasswordResetUseCases");
const AccountDeletionUseCases_1 = require("../../application/use-cases/auth/AccountDeletionUseCases");
const AuthMailService_1 = require("../../infrastructure/services/AuthMailService");
const ValidationMiddleware_1 = require("../middlewares/ValidationMiddleware");
const authSchemas_1 = require("../validation/authSchemas");
// Throttle credential attempts per IP to blunt brute-force / enumeration.
// Only failed attempts count, so normal logins never eat into the budget.
const loginRateLimiter = (0, RateLimitMiddleware_1.rateLimit)({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Çok fazla giriş denemesi. Lütfen bir süre sonra tekrar deneyin.',
    skipSuccessfulRequests: true,
});
// Separate limiter (own counter) for silent token refresh: the frontend calls
// this on every 401, so it must not share the login brute-force budget.
const refreshRateLimiter = (0, RateLimitMiddleware_1.rateLimit)({
    windowMs: 15 * 60 * 1000,
    max: 120,
    message: 'Çok fazla istek gönderildi. Lütfen bir süre sonra tekrar deneyin.',
    skipSuccessfulRequests: true,
});
// Tighter limit for the mail-sending flows (activation / reset / deletion
// requests) so they can't be abused to spam mailboxes.
const mailFlowRateLimiter = (0, RateLimitMiddleware_1.rateLimit)({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Çok fazla istek gönderildi. Lütfen bir süre sonra tekrar deneyin.',
});
const router = (0, express_1.Router)();
const employeeRepo = new EmployeeRepository_1.EmployeeRepository();
const roleRepo = new RoleRepository_1.RoleRepository();
const cryptoService = new BcryptCryptoService_1.BcryptCryptoService();
const tokenService = new JwtTokenService_1.JwtTokenService();
const authMailService = new AuthMailService_1.AuthMailService();
const loginUseCase = new LoginUseCase_1.LoginUseCase(employeeRepo, cryptoService, tokenService);
const getUserPermissionsUseCase = new GetUserPermissionsUseCase_1.GetUserPermissionsUseCase(roleRepo);
const getMeUseCase = new GetMeUseCase_1.GetMeUseCase(employeeRepo);
const refreshTokenUseCase = new RefreshTokenUseCase_1.RefreshTokenUseCase(employeeRepo, tokenService);
const requestActivationUseCase = new AccountActivationUseCases_1.RequestAccountActivationUseCase(employeeRepo, tokenService, authMailService);
const activateAccountUseCase = new AccountActivationUseCases_1.ActivateAccountUseCase(employeeRepo, tokenService);
const requestPasswordResetUseCase = new PasswordResetUseCases_1.RequestPasswordResetUseCase(employeeRepo, tokenService, authMailService);
const resetPasswordUseCase = new PasswordResetUseCases_1.ResetPasswordUseCase(employeeRepo, tokenService, cryptoService);
const requestAccountDeletionUseCase = new AccountDeletionUseCases_1.RequestAccountDeletionUseCase(employeeRepo, tokenService, authMailService);
const confirmAccountDeletionUseCase = new AccountDeletionUseCases_1.ConfirmAccountDeletionUseCase(employeeRepo, tokenService);
const authController = new AuthController_1.AuthController(loginUseCase, getUserPermissionsUseCase, getMeUseCase, refreshTokenUseCase, requestActivationUseCase, activateAccountUseCase, requestPasswordResetUseCase, resetPasswordUseCase, requestAccountDeletionUseCase, confirmAccountDeletionUseCase);
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
router.post('/login', loginRateLimiter, (0, ValidationMiddleware_1.validate)({ body: authSchemas_1.loginSchema }), (req, res) => authController.login(req, res));
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
router.post('/activation/request', mailFlowRateLimiter, (0, ValidationMiddleware_1.validate)({ body: authSchemas_1.emailRequestSchema }), (req, res) => authController.requestActivation(req, res));
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
router.post('/activation/confirm', mailFlowRateLimiter, (0, ValidationMiddleware_1.validate)({ body: authSchemas_1.tokenConfirmSchema }), (req, res) => authController.activate(req, res));
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
router.post('/password-reset/request', mailFlowRateLimiter, (0, ValidationMiddleware_1.validate)({ body: authSchemas_1.emailRequestSchema }), (req, res) => authController.requestPasswordReset(req, res));
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
router.post('/password-reset/confirm', mailFlowRateLimiter, (0, ValidationMiddleware_1.validate)({ body: authSchemas_1.passwordResetConfirmSchema }), (req, res) => authController.resetPassword(req, res));
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
router.post('/account-deletion/request', AuthMiddleware_1.requireAuth, mailFlowRateLimiter, (req, res) => authController.requestAccountDeletion(req, res));
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
router.post('/account-deletion/confirm', mailFlowRateLimiter, (0, ValidationMiddleware_1.validate)({ body: authSchemas_1.tokenConfirmSchema }), (req, res) => authController.confirmAccountDeletion(req, res));
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
router.get('/me/permissions', AuthMiddleware_1.requireAuth, (req, res) => authController.getPermissions(req, res));
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
router.get('/me', AuthMiddleware_1.requireAuth, (req, res) => authController.getMe(req, res));
exports.default = router;
//# sourceMappingURL=auth.routes.js.map