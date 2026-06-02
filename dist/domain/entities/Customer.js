"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Customer = void 0;
class Customer {
    id;
    tenantId;
    companyName;
    isActive;
    segment;
    taxOffice;
    taxNumber;
    address;
    mainPhone;
    mainEmail;
    constructor(id, tenantId, companyName, isActive, segment, taxOffice, taxNumber, address, mainPhone, mainEmail) {
        this.id = id;
        this.tenantId = tenantId;
        this.companyName = companyName;
        this.isActive = isActive;
        this.segment = segment;
        this.taxOffice = taxOffice;
        this.taxNumber = taxNumber;
        this.address = address;
        this.mainPhone = mainPhone;
        this.mainEmail = mainEmail;
    }
}
exports.Customer = Customer;
//# sourceMappingURL=Customer.js.map