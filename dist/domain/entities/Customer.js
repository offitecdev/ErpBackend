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
    customerType;
    mobilePhone;
    website;
    language;
    vatNumber;
    customerSource;
    responsibleFirstName;
    responsibleLastName;
    status;
    priceList;
    addressName;
    postalCode;
    city;
    country;
    addressSupplement;
    state;
    constructor(id, tenantId, companyName, isActive, segment, taxOffice, taxNumber, 
    /** Sokak + bina numarası (birleşik "adres" alanı yoktur). */
    address, mainPhone, mainEmail, customerType = "PRIVATE", mobilePhone, website, language, vatNumber, customerSource, responsibleFirstName, responsibleLastName, status = "ACTIVE", priceList, addressName, postalCode, city, country, 
    /** Adres eki / daire — sokak satırının devamı, ayrı bir bileşen. */
    addressSupplement, 
    /** Eyalet / kanton / bölge. */
    state) {
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
        this.customerType = customerType;
        this.mobilePhone = mobilePhone;
        this.website = website;
        this.language = language;
        this.vatNumber = vatNumber;
        this.customerSource = customerSource;
        this.responsibleFirstName = responsibleFirstName;
        this.responsibleLastName = responsibleLastName;
        this.status = status;
        this.priceList = priceList;
        this.addressName = addressName;
        this.postalCode = postalCode;
        this.city = city;
        this.country = country;
        this.addressSupplement = addressSupplement;
        this.state = state;
    }
}
exports.Customer = Customer;
//# sourceMappingURL=Customer.js.map