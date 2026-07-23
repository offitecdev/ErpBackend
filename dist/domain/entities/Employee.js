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
    constructor(id, tenantId, firstName, lastName, email, passwordHash, isActive, title, departmentId, roleName, phone, address, hireDate, terminationDate, annualLeaveEntitlement, profilePictureUrl, notes, createdAt, updatedAt, roleId, passwordChangedAt, deletedAt, bannedAt) {
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
    }
}
exports.Employee = Employee;
//# sourceMappingURL=Employee.js.map