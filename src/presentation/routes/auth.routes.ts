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

// Throttle credential attempts per IP to blunt brute-force / enumeration.
const loginRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Çok fazla giriş denemesi. Lütfen bir süre sonra tekrar deneyin.',
});


const router = Router();

const employeeRepo              = new EmployeeRepository();
const roleRepo                  = new RoleRepository();
const cryptoService             = new BcryptCryptoService();
const tokenService              = new JwtTokenService();
const loginUseCase              = new LoginUseCase(employeeRepo, cryptoService, tokenService);
const getUserPermissionsUseCase = new GetUserPermissionsUseCase(roleRepo);
const getMeUseCase = new GetMeUseCase(employeeRepo);

const authController = new AuthController(loginUseCase, getUserPermissionsUseCase, getMeUseCase);
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
