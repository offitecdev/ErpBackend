"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmployeeService = void 0;
const prisma_client_1 = __importDefault(require("../../../infrastructure/database/prisma.client"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const nanoid_1 = require("nanoid");
class EmployeeService {
    async createEmployee(data) {
        const saltRounds = 12;
        const hashedPassword = await bcrypt_1.default.hash(data.password, saltRounds);
        return await prisma_client_1.default.employee.create({
            data: {
                id: (0, nanoid_1.nanoid)(8),
                tenantId: data.tenantId,
                firstName: data.firstName,
                lastName: data.lastName,
                email: data.email,
                passwordHash: hashedPassword,
                title: data.title,
                departmentid: data.departmentid
            }
        });
    }
    async verifyEmployeeLogin(email, plainPassword) {
        const employee = await prisma_client_1.default.employee.findUnique({ where: { email } });
        if (!employee)
            throw new Error("Kullanıcı bulunamadı.");
        const isPasswordValid = await bcrypt_1.default.compare(plainPassword, employee.passwordHash);
        if (!isPasswordValid)
            throw new Error("Hatalı parola.");
        return employee;
    }
}
exports.EmployeeService = EmployeeService;
//# sourceMappingURL=employee_service.js.map