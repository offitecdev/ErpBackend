"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerLocation = void 0;
class CustomerLocation {
    id;
    customerId;
    name;
    isPrimary;
    kind;
    address;
    city;
    postalCode;
    country;
    phone;
    email;
    contactPerson;
    notes;
    createdAt;
    updatedAt;
    constructor(id, customerId, name, isPrimary, kind = "INSTALLATION", address, city, postalCode, country, phone, email, contactPerson, notes, createdAt, updatedAt) {
        this.id = id;
        this.customerId = customerId;
        this.name = name;
        this.isPrimary = isPrimary;
        this.kind = kind;
        this.address = address;
        this.city = city;
        this.postalCode = postalCode;
        this.country = country;
        this.phone = phone;
        this.email = email;
        this.contactPerson = contactPerson;
        this.notes = notes;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }
}
exports.CustomerLocation = CustomerLocation;
//# sourceMappingURL=CustomerLocation.js.map