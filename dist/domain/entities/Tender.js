"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Tender = void 0;
class Tender {
    id;
    tenantId;
    customerId;
    tenderNumber;
    version;
    format;
    status;
    createdByEmployeeId;
    createdAt;
    projectId;
    validUntil;
    offerMailSentAt;
    offerAcceptedAt;
    offerMailRecipient;
    offerAcceptanceToken;
    sourceCreatedAt;
    orderDate;
    billingAddress;
    deliveryAddress;
    internalDeliveryDate;
    priceList;
    paymentTerms;
    commissionNumber;
    salespersonName;
    sourceStatus;
    sourceCompany;
    shippingTerms;
    shippingWeight;
    fiscalPosition;
    salesTeam;
    onlineSignature;
    onlinePayment;
    coverLetter;
    closingNote;
    closingImages;
    sourceTotal;
    sourceNetAmount;
    sourceTaxAmount;
    sourceRecurringTotal;
    sourceMargin;
    billingSameAsInstallation;
    installationAddress;
    directDiscount;
    currency;
    directDiscountLabel;
    extraDiscount;
    extraDiscountLabel;
    totalDiscounts;
    paymentStages;
    customerReference;
    legacyNumber;
    constructor(id, tenantId, customerId, tenderNumber, version, format, status, createdByEmployeeId, createdAt, projectId, validUntil, offerMailSentAt, offerAcceptedAt, offerMailRecipient, offerAcceptanceToken, sourceCreatedAt, orderDate, billingAddress, deliveryAddress, internalDeliveryDate, priceList, paymentTerms, commissionNumber, salespersonName, sourceStatus, sourceCompany, shippingTerms, shippingWeight, fiscalPosition, salesTeam, onlineSignature, onlinePayment, coverLetter, closingNote, closingImages, sourceTotal, sourceNetAmount, sourceTaxAmount, sourceRecurringTotal, sourceMargin, billingSameAsInstallation, installationAddress, directDiscount, currency, directDiscountLabel, extraDiscount, extraDiscountLabel, 
    /** JSON [{name, kind, value}] — belge düzeyi yığılmış iskontolar. */
    totalDiscounts, paymentStages, 
    /** Kundenreferenz — "Referenz" on the offer PDF (customer-supplied). */
    customerReference, 
    /**
     * AN-2026-10001 serisinden ÖNCEKİ kod (A-2026-4474, TKF-…, ya da CSV/XML
     * içe aktarımının dış referansı). Yalnızca arama ve içe aktarım
     * eşleşmesi için tutulur; ekranda gösterilen kod `tenderNumber`dır.
     */
    legacyNumber) {
        this.id = id;
        this.tenantId = tenantId;
        this.customerId = customerId;
        this.tenderNumber = tenderNumber;
        this.version = version;
        this.format = format;
        this.status = status;
        this.createdByEmployeeId = createdByEmployeeId;
        this.createdAt = createdAt;
        this.projectId = projectId;
        this.validUntil = validUntil;
        this.offerMailSentAt = offerMailSentAt;
        this.offerAcceptedAt = offerAcceptedAt;
        this.offerMailRecipient = offerMailRecipient;
        this.offerAcceptanceToken = offerAcceptanceToken;
        this.sourceCreatedAt = sourceCreatedAt;
        this.orderDate = orderDate;
        this.billingAddress = billingAddress;
        this.deliveryAddress = deliveryAddress;
        this.internalDeliveryDate = internalDeliveryDate;
        this.priceList = priceList;
        this.paymentTerms = paymentTerms;
        this.commissionNumber = commissionNumber;
        this.salespersonName = salespersonName;
        this.sourceStatus = sourceStatus;
        this.sourceCompany = sourceCompany;
        this.shippingTerms = shippingTerms;
        this.shippingWeight = shippingWeight;
        this.fiscalPosition = fiscalPosition;
        this.salesTeam = salesTeam;
        this.onlineSignature = onlineSignature;
        this.onlinePayment = onlinePayment;
        this.coverLetter = coverLetter;
        this.closingNote = closingNote;
        this.closingImages = closingImages;
        this.sourceTotal = sourceTotal;
        this.sourceNetAmount = sourceNetAmount;
        this.sourceTaxAmount = sourceTaxAmount;
        this.sourceRecurringTotal = sourceRecurringTotal;
        this.sourceMargin = sourceMargin;
        this.billingSameAsInstallation = billingSameAsInstallation;
        this.installationAddress = installationAddress;
        this.directDiscount = directDiscount;
        this.currency = currency;
        this.directDiscountLabel = directDiscountLabel;
        this.extraDiscount = extraDiscount;
        this.extraDiscountLabel = extraDiscountLabel;
        this.totalDiscounts = totalDiscounts;
        this.paymentStages = paymentStages;
        this.customerReference = customerReference;
        this.legacyNumber = legacyNumber;
    }
}
exports.Tender = Tender;
//# sourceMappingURL=Tender.js.map