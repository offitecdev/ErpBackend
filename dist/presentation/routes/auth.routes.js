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
// Throttle credential attempts per IP to blunt brute-force / enumeration.
const loginRateLimiter = (0, RateLimitMiddleware_1.rateLimit)({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Çok fazla giriş denemesi. Lütfen bir süre sonra tekrar deneyin.',
});
const router = (0, express_1.Router)();
const employeeRepo = new EmployeeRepository_1.EmployeeRepository();
const roleRepo = new RoleRepository_1.RoleRepository();
const cryptoService = new BcryptCryptoService_1.BcryptCryptoService();
const tokenService = new JwtTokenService_1.JwtTokenService();
const loginUseCase = new LoginUseCase_1.LoginUseCase(employeeRepo, cryptoService, tokenService);
const getUserPermissionsUseCase = new GetUserPermissionsUseCase_1.GetUserPermissionsUseCase(roleRepo);
const getMeUseCase = new GetMeUseCase_1.GetMeUseCase(employeeRepo);
const authController = new AuthController_1.AuthController(loginUseCase, getUserPermissionsUseCase, getMeUseCase);
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
router.post('/login', loginRateLimiter, (req, res) => authController.login(req, res));
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