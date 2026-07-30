import { Request, Response } from 'express';
import prisma from '../../infrastructure/database/prisma.client';
import { CreateEmployeeUseCase } from '../../application/use-cases/employee/CreateEmployeeUseCase';
import { GetEmployeeUseCase } from '../../application/use-cases/employee/GetEmployeeUseCase';
import { UpdateEmployeeUseCase } from '../../application/use-cases/employee/UpdateEmployeeUseCase';
import { IEmployeeRepository } from '../../domain/repositories/IEmployeeRepository';
import { IRoleRepository } from '../../domain/repositories/IRoleRepository';
import { ICryptoService } from '../../application/interfaces/ICryptoService';
import { assertPasswordPolicy } from '../../application/validation/password';
import { auditLog } from '../../infrastructure/services/AuditLogService';
import { sanitizeModuleKeys } from '../../shared/moduleCatalog';
import { getCompanyTreeTenantIds } from './serviceTenantScope';

// TS Hatasını çözmek için Request objesini genişletiyoruz
export interface AuthRequest extends Request {
    user?: {
        id: string;
        tenantId: string;
        homeTenantId: string;
        email: string;
    };
}

export class EmployeeController {
    constructor(
        private createEmployeeUseCase: CreateEmployeeUseCase,
        private getEmployeeUseCase: GetEmployeeUseCase,
        private updateEmployeeUseCase: UpdateEmployeeUseCase,
        private employeeRepository: IEmployeeRepository,
        private roleRepository: IRoleRepository,
        private cryptoService: ICryptoService
    ) {}

    // Attaching a role or a personal module package to a personnel record is
    // an admin act: only callers holding roles.manage may send roleId /
    // moduleKeys (the permission checkboxes on the employee endpoints alone
    // are not enough to hand out access).
    private async assertCanAssignRole(req: AuthRequest): Promise<string | null> {
        if (!req.body.roleId && req.body.moduleKeys === undefined) return null;
        const callerPermissions = await this.roleRepository.getEmployeePermissions(req.user!.id);
        if (!callerPermissions.includes('roles.manage')) {
            return 'Rol ve modül paketi atama yalnızca yönetici (rol yönetimi yetkisi) tarafından yapılabilir.';
        }
        return null;
    }

    /** undefined = leave untouched; empty selection clears to null (= sees all). */
    private normalizeModuleKeys(input: unknown): string[] | null | undefined {
        if (input === undefined) return undefined;
        const keys = sanitizeModuleKeys(input);
        return keys.length ? keys : null;
    }

    async create(req: AuthRequest, res: Response) {
        try {
            const roleAssignError = await this.assertCanAssignRole(req);
            if (roleAssignError) return res.status(403).json({ error: roleAssignError });

            const employeeData = {
                ...req.body,
                moduleKeys: this.normalizeModuleKeys(req.body.moduleKeys) ?? null,
                tenantId: req.user?.tenantId
            };
            const result = await this.createEmployeeUseCase.execute(employeeData);
            auditLog.log({
                action: 'employee.create',
                tenantId: req.user!.tenantId,
                employeeId: req.user!.id,
                entityType: 'Employee',
                entityId: result.id,
                ...auditLog.context(req),
            });

            // Eğer frontend'den bir roleId gönderildiyse, ilişkiyi kur
            if (req.body.roleId) {
                try {
                    await this.roleRepository.assignRoleToEmployee(result.id, req.body.roleId);
                } catch (roleError: any) {
                    console.error('Rol atama hatası:', roleError);
                    // Rol atama başarısız olsa bile personel oluşturuldu, uyarı gönder
                    return res.status(201).json({ 
                        ...result, 
                        roleWarning: 'Personel oluşturuldu fakat rol atama başarısız oldu.' 
                    });
                }
            }

            res.status(201).json(result);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async list(req: AuthRequest, res: Response) {
        try {
            // `light=1`: trimmed name/role listing for pickers & filters — skips the
            // employeeRoles join and heavy columns, so it answers in a fraction of
            // the full listing's time.
            // Personnel are shared company-wide: the same staff pool shows under
            // the main tenant and every sub-tenant.
            const treeTenantIds = await getCompanyTreeTenantIds(req.user!.tenantId);
            if (String(req.query.light || '') === '1') {
                const rows = await prisma.employee.findMany({
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
                return res.status(200).json(
                    rows.map(({ employeeRoles, ...rest }) => ({
                        ...rest,
                        roleName: employeeRoles?.[0]?.role?.roleName ?? rest.roleName,
                    })),
                );
            }
            const filters = {
                tenantId: req.user!.tenantId,
                tenantIds: treeTenantIds,
                isActive: req.query.isActive !== undefined ? req.query.isActive === 'true' : undefined,
                departmentId: req.query.departmentId as string,
                roleName: req.query.roleName as string,
                search: req.query.search as string
            };
            const results = await this.getEmployeeUseCase.execute(filters);
            const safeResults = results.map(({ passwordHash, ...rest }) => rest);
            res.status(200).json(safeResults);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async getById(req: AuthRequest, res: Response) {
        try {
            const id = req.params.id as string;
            const employee = await this.employeeRepository.findById(id);
            // Ownership check: an id outside the caller's company tree answers 404,
            // exactly like a non-existent id, so foreign records can't be read (IDOR).
            // Personnel are shared across the tree, so any tenant of it qualifies.
            const treeTenantIds = await getCompanyTreeTenantIds(req.user!.tenantId);
            if (!employee || !treeTenantIds.includes(employee.tenantId)) {
                return res.status(404).json({ error: 'Personel bulunamadı.' });
            }
            const { passwordHash, ...safeResult } = employee;
            res.status(200).json(safeResult);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }

    async update(req: AuthRequest, res: Response) {
        try {
            const roleAssignError = await this.assertCanAssignRole(req);
            if (roleAssignError) return res.status(403).json({ error: roleAssignError });

            const id = req.params.id as string;
            const { roleId, password, ...employeeData } = req.body;
            if ('moduleKeys' in employeeData) {
                employeeData.moduleKeys = this.normalizeModuleKeys(employeeData.moduleKeys) ?? null;
            }

            // Ownership check before any write — the row must belong to the
            // caller's company tree (prevents cross-company employee updates;
            // personnel are shared across the tree's tenants).
            const existing = await this.employeeRepository.findById(id);
            const treeTenantIds = await getCompanyTreeTenantIds(req.user!.tenantId);
            if (!existing || !treeTenantIds.includes(existing.tenantId)) {
                return res.status(404).json({ error: 'Personel bulunamadı.' });
            }

            if (password) {
                assertPasswordPolicy(password);
                employeeData.passwordHash = await this.cryptoService.hashPassword(password);
                // Invalidates every JWT issued before this change (pwdAt claim check).
                employeeData.passwordChangedAt = new Date();
            }

            const result = await this.updateEmployeeUseCase.execute(id, employeeData);

            if (roleId) {
                await this.roleRepository.assignRoleToEmployee(id, roleId);
            }

            auditLog.log({
                action: 'employee.update',
                tenantId: req.user!.tenantId,
                employeeId: req.user!.id,
                entityType: 'Employee',
                entityId: id,
                metadata: {
                    fields: Object.keys(employeeData),
                    passwordChanged: Boolean(password),
                    ...(roleId ? { roleId } : {}),
                },
                ...auditLog.context(req),
            });

            const { passwordHash, ...safeResult } = result;
            res.status(200).json(safeResult);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
