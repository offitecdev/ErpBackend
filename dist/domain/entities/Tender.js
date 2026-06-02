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
    constructor(id, tenantId, customerId, tenderNumber, version, format, status, createdByEmployeeId, createdAt, projectId, validUntil, offerMailSentAt, offerAcceptedAt, offerMailRecipient, offerAcceptanceToken) {
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
    }
}
exports.Tender = Tender;
//# sourceMappingURL=Tender.js.map