"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerContact = void 0;
class CustomerContact {
    id;
    customerId;
    firstName;
    lastName;
    isPrimaryContact;
    title;
    phone;
    email;
    mobilePhone;
    notes;
    tenantId;
    constructor(id, customerId, firstName, lastName, isPrimaryContact, title, phone, email, mobilePhone, notes, 
    // Denormalized owner tenant (mirrors the customer's tenantId); required
    // by the DB, filled by the create path.
    tenantId) {
        this.id = id;
        this.customerId = customerId;
        this.firstName = firstName;
        this.lastName = lastName;
        this.isPrimaryContact = isPrimaryContact;
        this.title = title;
        this.phone = phone;
        this.email = email;
        this.mobilePhone = mobilePhone;
        this.notes = notes;
        this.tenantId = tenantId;
    }
}
exports.CustomerContact = CustomerContact;
//# sourceMappingURL=CustomerContact.js.map