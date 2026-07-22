import { Request, Response } from 'express';
import prisma from '../../infrastructure/database/prisma.client';
import { CreateEmployeeUseCase } from '../../application/use-cases/employee/CreateEmployeeUseCase';
import { GetEmployeeUseCase } from '../../application/use-cases/employee/GetEmployeeUseCase';
import { UpdateEmployeeUseCase } from '../../application/use-cases/employee/UpdateEmployeeUseCase';
import { IEmployeeRepository } from '../../domain/repositories/IEmployeeRepository';
import { IRoleRepository } from '../../domain/repositories/IRoleRepository';
import { ICryptoService } from '../../application/interfaces/ICryptoService';

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

    async create(req: AuthRequest, res: Response) {
        try {
            const employeeData = {
                ...req.body,
                tenantId: req.user?.tenantId
            };
            const result = await this.createEmployeeUseCase.execute(employeeData);
            
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
            if (String(req.query.light || '') === '1') {
                const rows = await prisma.employee.findMany({
                    where: {
                        tenantId: req.user!.tenantId,
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
            if (!employee) {
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
            const id = req.params.id as string;
            const { roleId, password, ...employeeData } = req.body;

            if (password) {
                employeeData.passwordHash = await this.cryptoService.hashPassword(password);
            }

            const result = await this.updateEmployeeUseCase.execute(id, employeeData);
            
            if (roleId) {
                await this.roleRepository.assignRoleToEmployee(id, roleId);
            }

            const { passwordHash, ...safeResult } = result;
            res.status(200).json(safeResult);
        } catch (error: any) {
            res.status(400).json({ error: error.message });
        }
    }
}
