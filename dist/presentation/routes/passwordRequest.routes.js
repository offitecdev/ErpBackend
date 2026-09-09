"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const nanoid_1 = require("nanoid");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const EmployeeRepository_1 = require("../../infrastructure/repositories/EmployeeRepository");
const RoleRepository_1 = require("../../infrastructure/repositories/RoleRepository");
const BcryptCryptoService_1 = require("../../infrastructure/services/BcryptCryptoService");
const password_1 = require("../../application/validation/password");
const serviceTenantScope_1 = require("../controllers/serviceTenantScope");
const AuditLogService_1 = require("../../infrastructure/services/AuditLogService");
const AuthErrors_1 = require("../../application/errors/AuthErrors");
const RateLimitMiddleware_1 = require("../middlewares/RateLimitMiddleware");
const bcryptGate_1 = require("../../application/services/bcryptGate");
/* ── KENNWORTWUNSCH (17.08.2026) ─────────────────────────────────────────────
 *
 * Vorgabe: „Das Kennwort kann geändert werden, aber es braucht die Freigabe
 * einer verwaltenden Person." Also zwei Wege durch DIESELBE Maske:
 *
 *   • Wer verwaltet (roles.manage) → das Kennwort wird sofort gesetzt.
 *   • Alle anderen                 → es entsteht ein ANTRAG. Der Entwurf liegt
 *     bereits gehasht in der Zeile; Klartext wird nie gespeichert und ist nach
 *     dem Absenden auch dem Server nicht mehr bekannt. Erst die Freigabe
 *     schreibt den Hash auf das Konto.
 *
 * Das alte Kennwort muss in beiden Fällen stimmen — sonst könnte ein offen
 * gelassener Bildschirm zum Kontowechsel benutzt werden.
 */
const router = (0, express_1.Router)();
/* ── WARUM HIER EINE BREMSE STEHT ────────────────────────────────────────────
 *
 * Dieser Weg prüft das BISHERIGE Kennwort — und tat das ohne jede Begrenzung.
 * Wer eine Sitzung übernommen hat (offener Bildschirm, gestohlener Keks),
 * konnte hier beliebig oft raten, um das Kennwort der Person zu erfahren; das
 * ist etwas anderes als Zugriff zu haben, weil dasselbe Kennwort meist auch
 * anderswo gilt.
 *
 * Gezählt wird je PERSON, nicht je Anschluss: das Schutzgut ist das Konto, und
 * ein ganzes Büro sitzt hinter einer Adresse (dieselbe Überlegung wie bei den
 * Postwegen in auth.routes.ts).
 *
 * Ein GELUNGENER Wechsel kostet nichts (`skipSuccessfulRequests`) — sonst
 * sperrt sich aus, wer sein Kennwort mehrmals berechtigt ändert.
 */
const passwordAttemptLimiter = (0, RateLimitMiddleware_1.rateLimit)({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: 'Zu viele Versuche. Bitte versuchen Sie es später erneut.',
    skipSuccessfulRequests: true,
    keyBy: (req) => (req.user?.id ? `pwreq:${req.user.id}` : null),
});
const employeeRepo = new EmployeeRepository_1.EmployeeRepository();
const roleRepo = new RoleRepository_1.RoleRepository();
const cryptoService = new BcryptCryptoService_1.BcryptCryptoService();
const requestSelect = {
    id: true,
    employeeId: true,
    status: true,
    note: true,
    createdAt: true,
    decidedAt: true,
    decisionNote: true,
    employee: { select: { id: true, firstName: true, lastName: true, email: true, staffNumber: true } },
    decidedBy: { select: { id: true, firstName: true, lastName: true } },
};
const mapRequest = (row) => ({
    id: row.id,
    employeeId: row.employeeId,
    status: row.status,
    note: row.note ?? null,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt ?? null,
    decisionNote: row.decisionNote ?? null,
    employee: row.employee
        ? {
            id: row.employee.id,
            firstName: row.employee.firstName,
            lastName: row.employee.lastName,
            email: row.employee.email,
            staffNumber: row.employee.staffNumber ?? null,
        }
        : null,
    decidedBy: row.decidedBy
        ? { id: row.decidedBy.id, firstName: row.decidedBy.firstName, lastName: row.decidedBy.lastName }
        : null,
});
/** Trägt die anfragende Person die Verwaltung? Entscheidet den Weg unten. */
const callerManages = async (employeeId) => (await roleRepo.getEmployeePermissions(employeeId)).includes('roles.manage');
/**
 * POST /password-requests — { currentPassword, newPassword, note? }
 * Antwort: { applied: true } (sofort gesetzt) oder { applied: false, request }.
 */
router.post('/', AuthMiddleware_1.requireAuth, passwordAttemptLimiter, async (req, res) => {
    try {
        const user = req.user;
        const currentPassword = String(req.body?.currentPassword || '');
        const newPassword = String(req.body?.newPassword || '');
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Bisheriges und neues Kennwort sind beide erforderlich.' });
        }
        (0, password_1.assertPasswordPolicy)(newPassword);
        const employee = await prisma_client_1.default.employee.findFirst({
            where: { id: user.id, deletedAt: null },
            select: { id: true, tenantId: true, passwordHash: true },
        });
        if (!employee)
            return res.status(404).json({ error: 'Person nicht gefunden.' });
        /* Alle drei bcrypt-Arbeiten laufen unter der Schranke: ein Vergleich
           und ein Hash kosten je ~250-400 ms Threadpool, und dieser Weg konnte
           sie unbegrenzt oft anfordern (bcryptGate.ts).

           Der ZWEITE Vergleich steht bewusst hinter dem `return` des ersten:
           wer das bisherige Kennwort nicht kennt, zahlt einen Vergleich, nicht
           zwei. */
        const ok = await (0, bcryptGate_1.runBcryptGuarded)(user.id, () => cryptoService.comparePassword(currentPassword, employee.passwordHash));
        if (!ok)
            return res.status(400).json({ error: 'Das bisherige Kennwort stimmt nicht.' });
        if (await (0, bcryptGate_1.runBcryptGuarded)(user.id, () => cryptoService.comparePassword(newPassword, employee.passwordHash))) {
            return res.status(400).json({ error: 'Das neue Kennwort ist mit dem bisherigen identisch.' });
        }
        const newPasswordHash = await (0, bcryptGate_1.runBcryptGuarded)(user.id, () => cryptoService.hashPassword(newPassword));
        if (await callerManages(user.id)) {
            await employeeRepo.update(user.id, { passwordHash: newPasswordHash, passwordChangedAt: new Date() });
            AuditLogService_1.auditLog.log({
                action: 'password.change.self',
                tenantId: user.tenantId,
                employeeId: user.id,
                entityType: 'Employee',
                entityId: user.id,
                ...AuditLogService_1.auditLog.context(req),
            });
            return res.status(200).json({ applied: true, request: null });
        }
        // Ein zweiter Antrag ersetzt den ersten — sonst stünden zwei Entwürfe
        // nebeneinander und die Freigabe wäre eine Ratesache.
        await prisma_client_1.default.passwordChangeRequest.deleteMany({ where: { employeeId: user.id, status: 'PENDING' } });
        const created = await prisma_client_1.default.passwordChangeRequest.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId: employee.tenantId,
                employeeId: user.id,
                newPasswordHash,
                status: 'PENDING',
                note: String(req.body?.note || '').trim() || null,
            },
            select: requestSelect,
        });
        AuditLogService_1.auditLog.log({
            action: 'password.change.requested',
            tenantId: user.tenantId,
            employeeId: user.id,
            entityType: 'PasswordChangeRequest',
            entityId: created.id,
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(201).json({ applied: false, request: mapRequest(created) });
    }
    catch (error) {
        // Eine überlastete Schranke ist kein Eingabefehler, sondern ein
        // "zu viel" — eigener Statuscode mit Wartezeit (wie bei der Anmeldung).
        if (error instanceof AuthErrors_1.TooManyAttemptsError) {
            res.setHeader('Retry-After', String(error.retryAfterSeconds));
            return res.status(429).json({ error: error.message });
        }
        res.status(400).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'password-requests') });
    }
});
/** GET /password-requests/mine — der eigene Stand (offen oder zuletzt entschieden). */
router.get('/mine', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const rows = await prisma_client_1.default.passwordChangeRequest.findMany({
            where: { employeeId: req.user.id },
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: requestSelect,
        });
        res.status(200).json({ data: rows.map(mapRequest) });
    }
    catch (error) {
        res.status(400).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'password-requests') });
    }
});
/** GET /password-requests?status=PENDING — die Freigabeliste.
    SEIT DEM 27.08.2026 auch für die Projektleitung (Vorgabe: «Kennwörter
    ändern dürfen nur Projektleitung und Administrator»): `employees.update`
    genügt — das Recht trägt, wer die Personalliste auf Stufe «bearbeiten»
    führt. */
router.get('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['roles.manage', 'employees.update']), async (req, res) => {
    try {
        // Kennwortwünsche gehören der Firma, unter der sie gestellt wurden.
        const treeTenantIds = await (0, serviceTenantScope_1.getPersonnelTenantScope)(req.user.tenantId);
        const status = String(req.query.status || 'PENDING').toUpperCase();
        const rows = await prisma_client_1.default.passwordChangeRequest.findMany({
            where: {
                tenantId: { in: treeTenantIds },
                ...(status === 'ALL' ? {} : { status }),
            },
            orderBy: { createdAt: 'desc' },
            take: 100,
            select: requestSelect,
        });
        res.status(200).json({ data: rows.map(mapRequest) });
    }
    catch (error) {
        res.status(400).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'password-requests') });
    }
});
/** POST /password-requests/:id/decide — { approve, note? }. Entscheiden darf,
    wer Kennwörter führen darf: Administrator (roles.manage) und Projektleitung
    (employees.update). */
router.post('/:id/decide', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['roles.manage', 'employees.update']), async (req, res) => {
    try {
        const user = req.user;
        const id = String(req.params.id || '');
        const approve = Boolean(req.body?.approve);
        const treeTenantIds = await (0, serviceTenantScope_1.getPersonnelTenantScope)(user.tenantId);
        const request = await prisma_client_1.default.passwordChangeRequest.findFirst({
            where: { id, tenantId: { in: treeTenantIds } },
            select: { id: true, employeeId: true, status: true, newPasswordHash: true },
        });
        if (!request)
            return res.status(404).json({ error: 'Antrag nicht gefunden.' });
        if (request.status !== 'PENDING')
            return res.status(400).json({ error: 'Dieser Antrag ist bereits entschieden.' });
        if (approve) {
            // Der Entwurf ist bereits ein Hash — er wandert unverändert auf das
            // Konto. `passwordChangedAt` macht jedes ältere Token ungültig.
            await employeeRepo.update(request.employeeId, {
                passwordHash: request.newPasswordHash,
                passwordChangedAt: new Date(),
            });
        }
        const updated = await prisma_client_1.default.passwordChangeRequest.update({
            where: { id },
            data: {
                status: approve ? 'APPROVED' : 'REJECTED',
                decidedAt: new Date(),
                decidedById: user.id,
                decisionNote: String(req.body?.note || '').trim() || null,
                // Der Entwurf hat seinen Zweck erfüllt; ein abgelehnter Hash
                // soll nicht in der Tabelle liegen bleiben.
                ...(approve ? {} : { newPasswordHash: '' }),
            },
            select: requestSelect,
        });
        AuditLogService_1.auditLog.log({
            action: approve ? 'password.change.approved' : 'password.change.rejected',
            tenantId: user.tenantId,
            employeeId: user.id,
            entityType: 'PasswordChangeRequest',
            entityId: id,
            ...AuditLogService_1.auditLog.context(req),
        });
        res.status(200).json({ request: mapRequest(updated) });
    }
    catch (error) {
        res.status(400).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'password-requests') });
    }
});
exports.default = router;
//# sourceMappingURL=passwordRequest.routes.js.map