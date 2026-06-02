"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateEmployeeUseCase = void 0;
class CreateEmployeeUseCase {
    employeeRepository;
    cryptoService;
    constructor(employeeRepository, cryptoService) {
        this.employeeRepository = employeeRepository;
        this.cryptoService = cryptoService;
    }
    async execute(data) {
        if (!data.tenantId)
            throw new Error("Tenant ID gereklidir.");
        if (!data.firstName)
            throw new Error("Ad alanı gereklidir.");
        if (!data.lastName)
            throw new Error("Soyad alanı gereklidir.");
        if (!data.email)
            throw new Error("E-posta alanı gereklidir.");
        if (!data.password)
            throw new Error("Şifre alanı gereklidir.");
        const existing = await this.employeeRepository.findByEmail(data.email);
        if (existing) {
            throw new Error("Bu e-posta adresi zaten kullanımda.");
        }
        const hashedPassword = await this.cryptoService.hashPassword(data.password);
        return await this.employeeRepository.create({
            tenantId: data.tenantId,
            firstName: data.firstName,
            lastName: data.lastName,
            email: data.email,
            passwordHash: hashedPassword,
            title: data.title,
            departmentId: data.departmentId,
            roleName: data.roleName,
            phone: data.phone,
            address: data.address,
            isActive: data.isActive ?? true,
            hireDate: data.hireDate ? new Date(data.hireDate) : null,
            terminationDate: data.terminationDate ? new Date(data.terminationDate) : null,
            annualLeaveEntitlement: data.annualLeaveEntitlement ?? 14,
            profilePictureUrl: data.profilePictureUrl,
            notes: data.notes,
        });
    }
}
exports.CreateEmployeeUseCase = CreateEmployeeUseCase;
//# sourceMappingURL=CreateEmployeeUseCase.js.map