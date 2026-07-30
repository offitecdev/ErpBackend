"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmployeeController = void 0;
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const password_1 = require("../../application/validation/password");
const AuditLogService_1 = require("../../infrastructure/services/AuditLogService");
const moduleCatalog_1 = require("../../shared/moduleCatalog");
const serviceTenantScope_1 = require("./serviceTenantScope");
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
    // Attaching a role or a personal module package to a personnel record is
    // an admin act: only callers holding roles.manage may send roleId /
    // moduleKeys (the permission checkboxes on the employee endpoints alone
    // are not enough to hand out access).
    async assertCanAssignRole(req) {
        if (!req.body.roleId && req.body.moduleKeys === undefined)
            return null;
        const callerPermissions = await this.roleRepository.getEmployeePermissions(req.user.id);
        if (!callerPermissions.includes('roles.manage')) {
            return 'Rol ve modül paketi atama yalnızca yönetici (rol yönetimi yetkisi) tarafından yapılabilir.';
        }
        return null;
    }
    /** undefined = leave untouched; empty selection clears to null (= sees all). */
    normalizeModuleKeys(input) {
        if (input === undefined)
            return undefined;
        const keys = (0, moduleCatalog_1.sanitizeModuleKeys)(input);
        return keys.length ? keys : null;
    }
    async create(req, res) {
        try {
            const roleAssignError = await this.assertCanAssignRole(req);
            if (roleAssignError)
                return res.status(403).json({ error: roleAssignError });
            const employeeData = {
                ...req.body,
                moduleKeys: this.normalizeModuleKeys(req.body.moduleKeys) ?? null,
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
            res.status(400).json({ error: error.message });
        }
    }
    async list(req, res) {
        try {
            // `light=1`: trimmed name/role listing for pickers & filters — skips the
            // employeeRoles join and heavy columns, so it answers in a fraction of
            // the full listing's time.
            // Personnel are shared company-wide: the same staff pool shows under
            // the main tenant and every sub-tenant.
            const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(req.user.tenantId);
            if (String(req.query.light || '') === '1') {
                const rows = await prisma_client_1.default.employee.findMany({
                    where: {
                        tenantId: { in: treeTenantIds },
                        ...(req.query.isActive !== undefined ? { isActive: req.query.isActive === 'true' } : {}),
                    },
                    select: {
                        id: true,
                        firstName: true,
                        lastName: true,
                        email: true,
                        roleName: true,
                        title: true,
                        // Some employees only carry their role via the RBAC join.
                        employeeRoles: { select: { role: { select: { roleName: true } } }, take: 1 },
                    },
                    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
                });
                return res.status(200).json(rows.map(({ employeeRoles, ...rest }) => ({
                    ...rest,
                    roleName: employeeRoles?.[0]?.role?.roleName ?? rest.roleName,
                })));
            }
            const filters = {
                tenantId: req.user.tenantId,
                tenantIds: treeTenantIds,
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
            res.status(400).json({ error: error.message });
        }
    }
    async getById(req, res) {
        try {
            const id = req.params.id;
            const employee = await this.employeeRepository.findById(id);
            // Ownership check: an id outside the caller's company tree answers 404,
            // exactly like a non-existent id, so foreign records can't be read (IDOR).
            // Personnel are shared across the tree, so any tenant of it qualifies.
            const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(req.user.tenantId);
            if (!employee || !treeTenantIds.includes(employee.tenantId)) {
                return res.status(404).json({ error: 'Personel bulunamadı.' });
            }
            const { passwordHash, ...safeResult } = employee;
            res.status(200).json(safeResult);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async update(req, res) {
        try {
            const roleAssignError = await this.assertCanAssignRole(req);
            if (roleAssignError)
                return res.status(403).json({ error: roleAssignError });
            const id = req.params.id;
            const { roleId, password, ...employeeData } = req.body;
            if ('moduleKeys' in employeeData) {
                employeeData.moduleKeys = this.normalizeModuleKeys(employeeData.moduleKeys) ?? null;
            }
            // Ownership check before any write — the row must belong to the
            // caller's company tree (prevents cross-company employee updates;
            // personnel are shared across the tree's tenants).
            const existing = await this.employeeRepository.findById(id);
            const treeTenantIds = await (0, serviceTenantScope_1.getCompanyTreeTenantIds)(req.user.tenantId);
            if (!existing || !treeTenantIds.includes(existing.tenantId)) {
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
            res.status(400).json({ error: error.message });
        }
    }
}
exports.EmployeeController = EmployeeController;
//# sourceMappingURL=EmployeeController.js.map