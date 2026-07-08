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
    constructor(id, customerId, firstName, lastName, isPrimaryContact, title, phone, email, mobilePhone, notes) {
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
    }
}
exports.CustomerContact = CustomerContact;
//# sourceMappingURL=CustomerContact.js.map