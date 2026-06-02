"use strict";
// ============================================================
// DOSYA: src/domain/entities/Logistics.ts
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.Shipment = void 0;
class Shipment {
    id;
    tenantId;
    customerId;
    status;
    foNumber;
    cmrNumber;
    awNumber;
    projectId;
    carrierCompany;
    productDescription;
    quantity;
    unit;
    grossWeight;
    netWeight;
    dimensions;
    extraNotes;
    shipmentDate;
    eta;
    invoiceUrl;
    autoMarkDelayed;
    requireInvoiceForPaid;
    createdAt;
    updatedAt;
    constructor(id, tenantId, customerId, status, foNumber, cmrNumber, awNumber, projectId, carrierCompany, productDescription, quantity, unit, grossWeight, netWeight, dimensions, extraNotes, shipmentDate, eta, invoiceUrl, autoMarkDelayed = false, requireInvoiceForPaid = true, createdAt, updatedAt) {
        this.id = id;
        this.tenantId = tenantId;
        this.customerId = customerId;
        this.status = status;
        this.foNumber = foNumber;
        this.cmrNumber = cmrNumber;
        this.awNumber = awNumber;
        this.projectId = projectId;
        this.carrierCompany = carrierCompany;
        this.productDescription = productDescription;
        this.quantity = quantity;
        this.unit = unit;
        this.grossWeight = grossWeight;
        this.netWeight = netWeight;
        this.dimensions = dimensions;
        this.extraNotes = extraNotes;
        this.shipmentDate = shipmentDate;
        this.eta = eta;
        this.invoiceUrl = invoiceUrl;
        this.autoMarkDelayed = autoMarkDelayed;
        this.requireInvoiceForPaid = requireInvoiceForPaid;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }
}
exports.Shipment = Shipment;
//# sourceMappingURL=Logistics.js.map