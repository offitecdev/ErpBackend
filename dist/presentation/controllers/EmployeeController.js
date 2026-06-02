"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmployeeController = void 0;
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
    async create(req, res) {
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
            const filters = {
                tenantId: req.user.tenantId,
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
            if (!employee) {
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
            const id = req.params.id;
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
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}
exports.EmployeeController = EmployeeController;
//# sourceMappingURL=EmployeeController.js.map