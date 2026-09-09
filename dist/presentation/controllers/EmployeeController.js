"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmployeeController = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const password_1 = require("../../application/validation/password");
const AuditLogService_1 = require("../../infrastructure/services/AuditLogService");
const serviceTenantScope_1 = require("./serviceTenantScope");
const staffDirectoryCache_1 = require("../../shared/staffDirectoryCache");
const tenantAccess_1 = require("../utils/tenantAccess");
const AuthErrors_1 = require("../../application/errors/AuthErrors");
/* ── WAS EINE ANFRAGE AM PERSONALDATENSATZ ÄNDERN DARF ───────────────────────
 *
 * `employeeCreateSchema` / `employeeUpdateSchema` sind bewusst OFFEN
 * (`z.looseObject`): unbekannte Felder reisen durch, damit die Anwendungsfälle
 * sich nehmen, was sie brauchen. `CreateEmployeeUseCase` tut das auch — der
 * Änderungsweg tat es NICHT: er reichte `req.body` als Ganzes an
 * `EmployeeRepository.update` weiter, und das streift nur `id`, `tenantId` und
 * `roleId` ab. Alles andere ging unbesehen an Prisma.
 *
 * Damit konnte, wer `employees.update` trug (Personalwesen, Projektleitung),
 * an EINEM fremden Konto — auch dem der Administration — Felder setzen, die
 * kein Formular je anbietet:
 *
 *   passwordHash        ein selbst gewählter Hash, an der Kennwortrichtlinie
 *                       und an `assertPasswordPolicy` vorbei
 *   qrToken             der eigene QR-Wert auf fremdem Konto → Anmeldung als
 *                       diese Person (siehe /auth/qr-login)
 *   bannedAt/deletedAt  ein gesperrtes oder gelöschtes Konto wieder öffnen
 *   passwordChangedAt   die Uhr, an der alte Sitzungen sterben, verstellen
 *
 * Deshalb wird jetzt AUSGEWÄHLT statt ausgeschlossen. Die Liste ist genau der
 * Vertrag, den die Schnittstellenbeschreibung nennt (UpdateEmployeeRequest);
 * `password` steht absichtlich NICHT darin — es läuft weiter durch
 * `assertPasswordPolicy` und wird gehasht, nie roh übernommen.
 *
 * Wer ein Feld ergänzt, prüfe zuerst: kann man damit einen ZUGANG verändern?
 * Dann gehört es nicht hierher, sondern auf einen eigenen, geprüften Weg
 * (Kennwort → /password-requests, Sperren → /employees/:id/ban, Rolle und
 * Firmen → /employees/:id/authorization, QR-Ausweis → /personnel/staff/:id/qr).
 */
const WRITABLE_EMPLOYEE_FIELDS = [
    'firstName',
    'lastName',
    'email',
    'title',
    'departmentId',
    'roleName',
    'phone',
    'address',
    'isActive',
    'hireDate',
    'terminationDate',
    'annualLeaveEntitlement',
    'profilePictureUrl',
    'notes',
];
const pickWritableEmployeeFields = (body) => {
    const picked = {};
    for (const field of WRITABLE_EMPLOYEE_FIELDS) {
        if (body?.[field] !== undefined)
            picked[field] = body[field];
    }
    return picked;
};
class EmployeeController {
    createEmployeeUseCase;
    getEmployeeUseCase;
    updateEmployeeUseCase;
    employeeRepository;
    roleRepository;
    cryptoService;
    constructor(createEmployeeUseCase, getEmployeeUseCase, updateEmployeeUseCase, employeeRepository, roleRepository, cryptoService) {
        this.createEmployeeUseCase = createEmployeeUseCase;
        this.getEmployeeUseCase = getEmployeeUseCase;
        this.updateEmployeeUseCase = updateEmployeeUseCase;
        this.employeeRepository = employeeRepository;
        this.roleRepository = roleRepository;
        this.cryptoService = cryptoService;
    }
    // Attaching a role or a company assignment to a personnel record is an admin
    // act: only callers holding roles.manage may send roleId / allowedTenantIds
    // (the permission checkboxes on the employee endpoints alone are not enough
    // to hand out access).
    async assertCanAssignRole(req) {
        if (!req.body.roleId && req.body.allowedTenantIds === undefined)
            return null;
        const callerPermissions = await this.roleRepository.getEmployeePermissions(req.user.id);
        if (!callerPermissions.includes('roles.manage')) {
            return 'Rol ve şirket atama yalnızca yönetici (rol yönetimi yetkisi) tarafından yapılabilir.';
        }
        return null;
    }
    /**
     * Company assignment: which companies the staff member works in. It does
     * two things at once — it opens the company switcher AND puts the person
     * into that company's staff list (see getPersonnelTenantScope).
     *
     * undefined = leave untouched; an empty selection clears to null, which
     * means the ONE company the person was created under (since 31.08.2026 —
     * it used to mean "every company of the tree"). Only companies of the
     * caller's own subtree may be handed out, so a sub-company can never grant
     * access to a sister company.
     */
    async normalizeAllowedTenantIds(input, callerTenantId, callerHomeTenantId, callerEmployeeId) {
        if (input === undefined)
            return undefined;
        const tenantIds = (0, tenantAccess_1.parseAllowedTenantIds)(input);
        if (!tenantIds)
            return null;
        // Der Zuteilende MUSS genannt werden: nur die feste Administratorrolle
        // teilt über die Firmengruppe hinaus zu (siehe getAssignableTenantIds).
        const assignable = await (0, serviceTenantScope_1.getAssignableTenantIds)(callerTenantId, callerHomeTenantId, callerEmployeeId);
        const outside = tenantIds.filter((tenantId) => !assignable.includes(tenantId));
        if (outside.length) {
            throw new AuthErrors_1.PublicError('Seçilen şirketlerden biri size açık değil.');
        }
        return tenantIds;
    }
    async create(req, res) {
        try {
            const roleAssignError = await this.assertCanAssignRole(req);
            if (roleAssignError)
                return res.status(403).json({ error: roleAssignError });
            // NIEMALS `...req.body`: das Schema ist bewusst offen (looseObject),
            // also landete früher jedes mitgeschickte Feld hier — siehe die
            // Begründung an WRITABLE_EMPLOYEE_FIELDS.
            const employeeData = {
                ...pickWritableEmployeeFields(req.body),
                password: req.body.password,
                // Accessible pages are a property of the ROLE (RoleModuleConfig),
                // never of the individual — a personal package is not accepted.
                moduleKeys: undefined,
                allowedTenantIds: await this.normalizeAllowedTenantIds(req.body.allowedTenantIds, req.user.tenantId, req.user.homeTenantId, req.user.id) ?? null,
                tenantId: req.user?.tenantId
            };
            const result = await this.createEmployeeUseCase.execute(employeeData);
            AuditLogService_1.auditLog.log({
                action: 'employee.create',
                tenantId: req.user.tenantId,
                employeeId: req.user.id,
                entityType: 'Employee',
                entityId: result.id,
                ...AuditLogService_1.auditLog.context(req),
            });
            // Eğer frontend'den bir roleId gönderildiyse, ilişkiyi kur
            if (req.body.roleId) {
                try {
                    await this.roleRepository.assignRoleToEmployee(result.id, req.body.roleId);
                }
                catch (roleError) {
                    console.error('Rol atama hatası:', roleError);
                    // Rol atama başarısız olsa bile personel oluşturuldu, uyarı gönder
                    return res.status(201).json({
                        ...result,
                        roleWarning: 'Personel oluşturuldu fakat rol atama başarısız oldu.'
                    });
                }
            }
            res.status(201).json(result);
        }
        catch (error) {
            res.status(400).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'employees') });
        }
    }
    /** Trimmed name/role/e-mail rows for pickers & filters: skips the heavy
        columns, so it answers in a fraction of the full listing's time.

        ONE statement on purpose. The nested `employeeRoles → role` select this
        used to carry made Prisma issue three SEQUENTIAL queries (employees,
        then EmployeeRole, then Role); against the remote database that is three
        round trips and the pickers measured ~750 ms. The role now arrives via a
        correlated subquery — same "first role wins" semantics as the former
        `take: 1`, one trip.

        On top of that the result is briefly cached: the list is identical for
        everyone in the same company and barely ever changes, but a picker
        fetched it on EVERY open. The cache key carries the tenant ids, so two
        companies never share an entry. `EmployeeRepository` drops the cache on every write, so
        the TTL is only a ceiling for changes made outside this process. */
    async lightStaffRows(treeTenantIds, isActive, hideDeleted = false) {
        if (treeTenantIds.length === 0)
            return [];
        // Der Schlüssel trägt ALLE Eingaben der Abfrage; die Mandanten werden
        // sortiert, damit dieselbe Menge in anderer Reihenfolge denselben
        // Eintrag trifft.
        const cacheKey = JSON.stringify([[...treeTenantIds].sort(), isActive ?? null, hideDeleted]);
        return (0, staffDirectoryCache_1.getCachedStaffDirectory)(cacheKey, () => this.loadLightStaffRows(treeTenantIds, isActive, hideDeleted));
    }
    async loadLightStaffRows(treeTenantIds, isActive, hideDeleted = false) {
        const conditions = [
            (0, serviceTenantScope_1.employeeScopeSql)(treeTenantIds),
        ];
        if (isActive !== undefined)
            conditions.push(client_1.Prisma.sql `e.isActive = ${isActive}`);
        if (hideDeleted)
            conditions.push(client_1.Prisma.sql `e.deletedAt IS NULL`);
        const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT e.id, e.firstName, e.lastName, e.email, e.title,
                   COALESCE(
                       (SELECT r.roleName
                          FROM EmployeeRole er
                          JOIN Role r ON r.id = er.roleId
                         WHERE er.employeeId = e.id
                         LIMIT 1),
                       e.roleName
                   ) AS roleName
            FROM Employee e
            WHERE ${client_1.Prisma.join(conditions, ' AND ')}
            ORDER BY e.firstName ASC, e.lastName ASC
        `);
        return rows.map((row) => ({
            id: row.id,
            firstName: row.firstName,
            lastName: row.lastName,
            email: row.email,
            title: row.title ?? null,
            roleName: row.roleName ?? null,
        }));
    }
    /* GET /employees/directory — the company phone-book: who can be invited to a
       meeting, put on an appointment or CC'd on a mail. Every signed-in employee
       needs it, so it is NOT gated behind the HR permission `employees.view`;
       without that split a salesperson simply saw no colleagues in the pickers.
       Only name, role/title and the work e-mail leave the server here — never
       HR data (salary, leave, notes, password state). */
    async directory(req, res) {
        try {
            const scopeTenantIds = await (0, serviceTenantScope_1.getPersonnelTenantScope)(req.user.tenantId);
            const isActive = req.query.isActive !== undefined ? req.query.isActive === 'true' : true;
            // A directory never suggests someone who has left: soft-deleted
            // records stay out, unlike in the HR listing where admins need them.
            return res.status(200).json(await this.lightStaffRows(scopeTenantIds, isActive, true));
        }
        catch (error) {
            return res.status(400).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'employees') });
        }
    }
    async list(req, res) {
        try {
            // Personnel belong to the SELECTED company only — a person shows up
            // under the company they were created in and nowhere else.
            const scopeTenantIds = await (0, serviceTenantScope_1.getPersonnelTenantScope)(req.user.tenantId);
            if (String(req.query.light || '') === '1') {
                return res.status(200).json(await this.lightStaffRows(scopeTenantIds, req.query.isActive !== undefined ? req.query.isActive === 'true' : undefined));
            }
            const filters = {
                tenantId: req.user.tenantId,
                tenantIds: scopeTenantIds,
                isActive: req.query.isActive !== undefined ? req.query.isActive === 'true' : undefined,
                departmentId: req.query.departmentId,
                roleName: req.query.roleName,
                search: req.query.search
            };
            const results = await this.getEmployeeUseCase.execute(filters);
            const safeResults = results.map(({ passwordHash, ...rest }) => rest);
            res.status(200).json(safeResults);
        }
        catch (error) {
            res.status(400).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'employees') });
        }
    }
    async getById(req, res) {
        try {
            const id = req.params.id;
            const employee = await this.employeeRepository.findById(id);
            // Ownership check: an id outside the SELECTED company answers 404,
            // exactly like a non-existent id, so foreign records can't be read (IDOR).
            // A sister company's staff are foreign records too — see
            // getPersonnelTenantScope.
            const scopeTenantIds = await (0, serviceTenantScope_1.getPersonnelTenantScope)(req.user.tenantId);
            if (!employee || !(0, serviceTenantScope_1.isEmployeeInScope)(employee, scopeTenantIds)) {
                return res.status(404).json({ error: 'Personel bulunamadı.' });
            }
            const { passwordHash, ...safeResult } = employee;
            res.status(200).json(safeResult);
        }
        catch (error) {
            res.status(400).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'employees') });
        }
    }
    async update(req, res) {
        try {
            const roleAssignError = await this.assertCanAssignRole(req);
            if (roleAssignError)
                return res.status(403).json({ error: roleAssignError });
            const id = req.params.id;
            const { roleId, password } = req.body;
            // Nur die Felder des Vertrags. `moduleKeys` bleibt draussen (die
            // Seiten hängen an der ROLLE), und ebenso alles, was den Zugang
            // selbst betrifft — siehe WRITABLE_EMPLOYEE_FIELDS.
            const employeeData = pickWritableEmployeeFields(req.body);
            if ('allowedTenantIds' in req.body) {
                employeeData.allowedTenantIds =
                    await this.normalizeAllowedTenantIds(req.body.allowedTenantIds, req.user.tenantId, req.user.homeTenantId, req.user.id) ?? null;
            }
            // Ownership check before any write — the row must belong to the
            // SELECTED company (prevents cross-company employee updates; a
            // sister company's staff are not editable from here).
            const existing = await this.employeeRepository.findById(id);
            const scopeTenantIds = await (0, serviceTenantScope_1.getPersonnelTenantScope)(req.user.tenantId);
            if (!existing || !(0, serviceTenantScope_1.isEmployeeInScope)(existing, scopeTenantIds)) {
                return res.status(404).json({ error: 'Personel bulunamadı.' });
            }
            if (password) {
                (0, password_1.assertPasswordPolicy)(password);
                employeeData.passwordHash = await this.cryptoService.hashPassword(password);
                // Invalidates every JWT issued before this change (pwdAt claim check).
                employeeData.passwordChangedAt = new Date();
            }
            const result = await this.updateEmployeeUseCase.execute(id, employeeData);
            if (roleId) {
                await this.roleRepository.assignRoleToEmployee(id, roleId);
            }
            AuditLogService_1.auditLog.log({
                action: 'employee.update',
                tenantId: req.user.tenantId,
                employeeId: req.user.id,
                entityType: 'Employee',
                entityId: id,
                metadata: {
                    fields: Object.keys(employeeData),
                    passwordChanged: Boolean(password),
                    ...(roleId ? { roleId } : {}),
                },
                ...AuditLogService_1.auditLog.context(req),
            });
            const { passwordHash, ...safeResult } = result;
            res.status(200).json(safeResult);
        }
        catch (error) {
            res.status(400).json({ error: (0, AuthErrors_1.toPublicMessage)(error, 'employees') });
        }
    }
}
exports.EmployeeController = EmployeeController;
//# sourceMappingURL=EmployeeController.js.map