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
    addressSupplement;
    state;
    constructor(id, customerId, name, isPrimary, kind = "INSTALLATION", address, city, postalCode, country, phone, email, contactPerson, notes, createdAt, updatedAt, 
    /** Adres eki / daire — sokak satırının (`address`) devamı. */
    addressSupplement, 
    /** Eyalet / kanton / bölge. */
    state) {
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
        this.addressSupplement = addressSupplement;
        this.state = state;
    }
}
exports.CustomerLocation = CustomerLocation;
//# sourceMappingURL=CustomerLocation.js.map