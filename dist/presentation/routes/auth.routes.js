"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthController_1 = require("../controllers/AuthController");
const LoginUseCase_1 = require("../../application/use-cases/auth/LoginUseCase");
const QrLoginUseCase_1 = require("../../application/use-cases/auth/QrLoginUseCase");
const GetUserPermissionsUseCase_1 = require("../../application/use-cases/auth/GetUserPermissionsUseCase");
const EmployeeRepository_1 = require("../../infrastructure/repositories/EmployeeRepository");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
const BcryptCryptoService_1 = require("../../infrastructure/services/BcryptCryptoService");
const JwtTokenService_1 = require("../../infrastructure/services/JwtTokenService");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const CsrfMiddleware_1 = require("../middlewares/CsrfMiddleware");
const authCookies_1 = require("../utils/authCookies");
const RateLimitMiddleware_1 = require("../middlewares/RateLimitMiddleware");
const GetMeUseCase_1 = require("../../application/use-cases/auth/GetMeUseCase");
const RefreshTokenUseCase_1 = require("../../application/use-cases/auth/RefreshTokenUseCase");
const AccountActivationUseCases_1 = require("../../application/use-cases/auth/AccountActivationUseCases");
const PasswordResetUseCases_1 = require("../../application/use-cases/auth/PasswordResetUseCases");
const AccountDeletionUseCases_1 = require("../../application/use-cases/auth/AccountDeletionUseCases");
const AuthMailService_1 = require("../../infrastructure/services/AuthMailService");
const MfaUseCases_1 = require("../../application/use-cases/auth/MfaUseCases");
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
/* ── DER ZWEITE FAKTOR ───────────────────────────────────────────────────────
 * Eigener Zähler, aus zwei Gründen. Erstens gehört ein Vertipper im Codefeld
 * nicht in das Kennwort-Budget — sonst sperrt sich aus, wer sein Kennwort
 * kennt und den Sechser zweimal daneben tippt. Zweitens ist der eigentliche
 * Schutz ohnehin der Zähler JE KONTO in `MfaUseCases` (fünf Fehlversuche, dann
 * wachsende Wartezeit); dieser hier bremst nur das Skript auf EINEM Anschluss,
 * und darf deshalb grosszügiger sein. Gelungene Eingaben zählen nicht mit —
 * ein Grossraumbüro hinter einer Adresse meldet sich morgens gemeinsam an. */
const mfaRateLimiter = (0, RateLimitMiddleware_1.rateLimit)({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: 'Çok fazla deneme. Lütfen bir süre sonra tekrar deneyin.',
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
/* ── DIE POSTWEGE (Aktivierung / Kennwort / Löschung) ────────────────────────
 *
 * Hier stand EIN Zähler für alle sechs Wege: 5 Anfragen je Anschluss und
 * Viertelstunde, ohne `skipSuccessfulRequests`. Das war an drei Stellen falsch:
 *
 *  • Ein ganzes Büro sitzt hinter EINER Adresse. Fünf Kennwortanfragen je
 *    Viertelstunde galten damit für die Firma, nicht für die Person.
 *  • Die BESTÄTIGUNGEN teilten sich denselben Zähler. Wer seinen Link ein paar
 *    Mal falsch anklickte, konnte den richtigen nicht mehr bestätigen.
 *  • Das eigentliche Schutzgut — ein einzelnes Postfach — war gar nicht
 *    geschützt: über wechselnde Adressen liess sich dieselbe Person weiter
 *    zuschütten.
 *
 * Jetzt sind es drei Zähler mit je eigener Aufgabe.
 */
/** Grobe Bremse gegen Massenversand von EINEM Anschluss. Grosszügig — sie soll
    das Büro nicht treffen, sondern das Skript. */
const mailFlowIpRateLimiter = (0, RateLimitMiddleware_1.rateLimit)({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: 'Çok fazla istek gönderildi. Lütfen bir süre sonra tekrar deneyin.',
});
/** Der eigentliche Schutz: je EMPFÄNGERPOSTFACH, quer über alle Anschlüsse.
    Steht hinter `validate`, damit die Adresse geprüft und getrimmt ist. */
const mailRecipientRateLimiter = (0, RateLimitMiddleware_1.rateLimit)({
    windowMs: 15 * 60 * 1000,
    max: 3,
    message: 'Bu adres için çok fazla istek gönderildi. Lütfen bir süre sonra tekrar deneyin.',
    keyBy: (req) => {
        const email = String(req.body?.email || '').trim().toLowerCase();
        return email ? `mail:${email}` : null;
    },
});
/** Kontolöschung: kein Feld im Körper, die Person steht im Zugangstoken. */
const mailSelfRateLimiter = (0, RateLimitMiddleware_1.rateLimit)({
    windowMs: 15 * 60 * 1000,
    max: 3,
    message: 'Çok fazla istek gönderildi. Lütfen bir süre sonra tekrar deneyin.',
    keyBy: (req) => (req.user?.id ? `self:${req.user.id}` : null),
});
/** BESTÄTIGUNGEN haben ihren eigenen Zähler, und ein GELUNGENER Klick kostet
    nichts: sonst sperrt sich aus, wer einen alten Link erwischt hat und dann
    den richtigen öffnet. */
const tokenConfirmRateLimiter = (0, RateLimitMiddleware_1.rateLimit)({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: 'Çok fazla deneme. Lütfen bir süre sonra tekrar deneyin.',
    skipSuccessfulRequests: true,
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
const qrLoginUseCase = new QrLoginUseCase_1.QrLoginUseCase(tokenService);
const verifyMfaCodeUseCase = new MfaUseCases_1.VerifyMfaCodeUseCase(tokenService);
const authController = new AuthController_1.AuthController(loginUseCase, getUserPermissionsUseCase, getMeUseCase, refreshTokenUseCase, requestActivationUseCase, activateAccountUseCase, requestPasswordResetUseCase, resetPasswordUseCase, requestAccountDeletionUseCase, confirmAccountDeletionUseCase, qrLoginUseCase, verifyMfaCodeUseCase);
/** Der Keks vor der Sitzung: reine Zufallsbytes, kein Datenbankzugriff. Die
    Grenze ist entsprechend grosszügig und soll nur ein Skript bremsen. */
const csrfIssueRateLimiter = (0, RateLimitMiddleware_1.rateLimit)({
    windowMs: 15 * 60 * 1000,
    max: 240,
    message: 'Çok fazla istek gönderildi. Lütfen bir süre sonra tekrar deneyin.',
});
/**
 * @swagger
 * /auth/csrf:
 *   get:
 *     tags: [Auth]
 *     summary: Setzt den CSRF-Keks für die Wege VOR der Anmeldung
 *     description: >
 *       Anmeldung, QR-Anmeldung, Erneuerung und Abmeldung liegen ausserhalb von
 *       requireAuth. Unter OFFITEC_COOKIE_SAMESITE=none werden sie trotzdem auf
 *       die Doppelvorlage geprüft — dafür braucht die Anmeldeseite einen Keks,
 *       bevor es eine Sitzung gibt. Unter SameSite=Lax ist der Aufruf harmlos
 *       und schadet nicht.
 *     security: []
 *     responses:
 *       200:
 *         description: Keks gesetzt; derselbe Wert steht im Rumpf
 */
router.get('/csrf', csrfIssueRateLimiter, (_req, res) => {
    res.status(200).json({ csrfToken: (0, authCookies_1.issueCsrfCookie)(res) });
});
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
router.post('/login', loginRateLimiter, CsrfMiddleware_1.requireCsrfOnPublicAuth, (0, ValidationMiddleware_1.validate)({ body: authSchemas_1.loginSchema }), (req, res) => authController.login(req, res));
/**
 * @swagger
 * /auth/mfa/verify:
 *   post:
 *     tags: [Auth]
 *     summary: "Zweiter Faktor: den Einmalcode der Authenticator-App einlösen"
 *     description: >
 *       Zweite Hälfte der Anmeldung. `POST /auth/login` beantwortet die
 *       richtige Kennworteingabe mit `mfaRequired` und setzt den HttpOnly-Keks
 *       `ofi_mfa`; hier wird der sechsstellige Code dazu eingereicht. Stimmt er,
 *       entstehen die Sitzungskeks — vorher gibt es keine Sitzung.
 *       Bei der ersten Anmeldung einer Person (`stage=enroll`) bestätigt
 *       derselbe Aufruf zugleich die Einrichtung.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code:
 *                 type: string
 *                 example: "482193"
 *     responses:
 *       200:
 *         description: Angemeldet (Keks gesetzt)
 *       400:
 *         description: Code falsch oder bereits verbraucht — dieselbe Eingabe darf wiederholt werden
 *       401:
 *         description: Zwischentoken abgelaufen oder Konto nicht mehr anmeldbar — von vorne beginnen
 *       429:
 *         description: Zu viele Fehlversuche
 */
router.post('/mfa/verify', mfaRateLimiter, CsrfMiddleware_1.requireCsrfOnPublicAuth, (0, ValidationMiddleware_1.validate)({ body: authSchemas_1.mfaVerifySchema }), (req, res) => authController.verifyMfa(req, res));
/**
 * @swagger
 * /auth/qr-login:
 *   post:
 *     tags: [Auth]
 *     summary: Anmeldung mit dem Personal-QR-Code
 *     description: >
 *       Der QR-Code des Personalmoduls (ein Code je Person) meldet an; derselbe
 *       Code stempelt am Tablet ein und aus.
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
 *         description: Angemeldet
 *       400:
 *         description: QR-Code ungültig
 */
// Teilt den Brute-Force-Zähler der Kennwortanmeldung: ein QR-Schlüssel ist eine
// Zugangsangabe wie ein Kennwort und darf nicht schneller geraten werden dürfen.
router.post('/qr-login', loginRateLimiter, CsrfMiddleware_1.requireCsrfOnPublicAuth, (req, res) => authController.qrLogin(req, res));
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
router.post('/refresh', refreshRateLimiter, CsrfMiddleware_1.requireCsrfOnPublicAuth, (req, res) => authController.refresh(req, res));
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
router.post('/logout', CsrfMiddleware_1.requireCsrfOnPublicAuth, (req, res) => authController.logout(req, res));
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
router.post('/activation/request', mailFlowIpRateLimiter, (0, ValidationMiddleware_1.validate)({ body: authSchemas_1.emailRequestSchema }), mailRecipientRateLimiter, (req, res) => authController.requestActivation(req, res));
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
router.post('/activation/confirm', tokenConfirmRateLimiter, (0, ValidationMiddleware_1.validate)({ body: authSchemas_1.tokenConfirmSchema }), (req, res) => authController.activate(req, res));
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
router.post('/password-reset/request', mailFlowIpRateLimiter, (0, ValidationMiddleware_1.validate)({ body: authSchemas_1.emailRequestSchema }), mailRecipientRateLimiter, (req, res) => authController.requestPasswordReset(req, res));
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
router.post('/password-reset/confirm', tokenConfirmRateLimiter, (0, ValidationMiddleware_1.validate)({ body: authSchemas_1.passwordResetConfirmSchema }), (req, res) => authController.resetPassword(req, res));
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
router.post('/account-deletion/request', AuthMiddleware_1.requireAuth, mailFlowIpRateLimiter, mailSelfRateLimiter, (req, res) => authController.requestAccountDeletion(req, res));
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
router.post('/account-deletion/confirm', tokenConfirmRateLimiter, (0, ValidationMiddleware_1.validate)({ body: authSchemas_1.tokenConfirmSchema }), (req, res) => authController.confirmAccountDeletion(req, res));
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