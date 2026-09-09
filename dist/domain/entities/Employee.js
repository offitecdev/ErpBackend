"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Employee = void 0;
class Employee {
    id;
    tenantId;
    firstName;
    lastName;
    email;
    passwordHash;
    isActive;
    title;
    departmentId;
    roleName;
    phone;
    address;
    hireDate;
    terminationDate;
    annualLeaveEntitlement;
    profilePictureUrl;
    notes;
    createdAt;
    updatedAt;
    roleId;
    passwordChangedAt;
    deletedAt;
    bannedAt;
    moduleKeys;
    allowedTenantIds;
    deactivatedAt;
    totpSecret;
    totpEnabledAt;
    totpLastStep;
    constructor(id, tenantId, firstName, lastName, email, passwordHash, isActive, title, departmentId, roleName, phone, address, hireDate, terminationDate, annualLeaveEntitlement, profilePictureUrl, notes, createdAt, updatedAt, roleId, passwordChangedAt, deletedAt, bannedAt, 
    /// Personal module package; null = no restriction.
    moduleKeys, 
    /// Companies of the tree the employee may work in; null = no restriction.
    allowedTenantIds, 
    /// Gesetzt, sobald die VERWALTUNG das Konto stillgelegt hat (pasif,
    /// gesperrt, gelöscht). Nur ein Konto OHNE diese Marke darf sich per
    /// Aktivierungslink selbst freischalten — siehe AccountActivationUseCases.
    deactivatedAt, 
    /// ── ZWEITER FAKTOR (TOTP / Aegis) ───────────────────────────────────
    /// Das gemeinsame Geheimnis mit der Authenticator-App — VERSCHLÜSSELT,
    /// so wie es in der Spalte steht (siehe totpCrypto.ts); wer damit
    /// rechnen will, muss es erst entschlüsseln.
    totpSecret, 
    /// Zeitpunkt der ersten bestätigten Codeeingabe. null = noch nicht
    /// eingerichtet, die Anmeldung führt dann durch die Einrichtung.
    totpEnabledAt, 
    /// Zuletzt angenommenes Zeitfenster — ein Code gilt genau einmal.
    totpLastStep) {
        this.id = id;
        this.tenantId = tenantId;
        this.firstName = firstName;
        this.lastName = lastName;
        this.email = email;
        this.passwordHash = passwordHash;
        this.isActive = isActive;
        this.title = title;
        this.departmentId = departmentId;
        this.roleName = roleName;
        this.phone = phone;
        this.address = address;
        this.hireDate = hireDate;
        this.terminationDate = terminationDate;
        this.annualLeaveEntitlement = annualLeaveEntitlement;
        this.profilePictureUrl = profilePictureUrl;
        this.notes = notes;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
        this.roleId = roleId;
        this.passwordChangedAt = passwordChangedAt;
        this.deletedAt = deletedAt;
        this.bannedAt = bannedAt;
        this.moduleKeys = moduleKeys;
        this.allowedTenantIds = allowedTenantIds;
        this.deactivatedAt = deactivatedAt;
        this.totpSecret = totpSecret;
        this.totpEnabledAt = totpEnabledAt;
        this.totpLastStep = totpLastStep;
    }
}
exports.Employee = Employee;
//# sourceMappingURL=Employee.js.map