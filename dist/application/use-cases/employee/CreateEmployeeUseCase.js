"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateEmployeeUseCase = void 0;
const password_1 = require("../../validation/password");
const AuthErrors_1 = require("../../errors/AuthErrors");
class CreateEmployeeUseCase {
    employeeRepository;
    cryptoService;
    constructor(employeeRepository, cryptoService) {
        this.employeeRepository = employeeRepository;
        this.cryptoService = cryptoService;
    }
    async execute(data) {
        if (!data.tenantId)
            throw new AuthErrors_1.PublicError("Tenant ID gereklidir.");
        if (!data.firstName)
            throw new AuthErrors_1.PublicError("Ad alanı gereklidir.");
        if (!data.lastName)
            throw new AuthErrors_1.PublicError("Soyad alanı gereklidir.");
        if (!data.email)
            throw new AuthErrors_1.PublicError("E-posta alanı gereklidir.");
        if (!data.password)
            throw new AuthErrors_1.PublicError("Şifre alanı gereklidir.");
        (0, password_1.assertPasswordPolicy)(data.password);
        const existing = await this.employeeRepository.findByEmail(data.email);
        // Banned accounts keep their row forever, so a banned e-mail can never
        // re-register (soft-deleted rows also keep the address occupied).
        if (existing?.bannedAt) {
            throw new AuthErrors_1.PublicError("Bu e-posta adresi engellenmiş; bu adresle kayıt yapılamaz.");
        }
        if (existing) {
            throw new AuthErrors_1.PublicError("Bu e-posta adresi zaten kullanımda.");
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
            moduleKeys: data.moduleKeys ?? null,
            allowedTenantIds: data.allowedTenantIds ?? null,
        });
    }
}
exports.CreateEmployeeUseCase = CreateEmployeeUseCase;
//# sourceMappingURL=CreateEmployeeUseCase.js.map