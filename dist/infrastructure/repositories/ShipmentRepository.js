"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShipmentRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const Logistics_1 = require("../../domain/entities/Logistics");
const nanoid_1 = require("nanoid");
class ShipmentRepository {
    mapToEntity(data) {
        return new Logistics_1.Shipment(data.id, data.tenantId, data.customerId, data.status, data.foNumber, data.cmrNumber, data.awNumber, data.projectId, data.carrierCompany, data.productDescription, data.quantity, data.unit, data.grossWeight, data.netWeight, data.dimensions, data.extraNotes, data.shipmentDate, data.eta, data.invoiceUrl, Boolean(data.autoMarkDelayed), data.requireInvoiceForPaid !== false, data.createdAt, data.updatedAt);
    }
    async create(data) {
        const created = await prisma_client_1.default.shipment.create({
            data: {
                id: data.id || (0, nanoid_1.nanoid)(10),
                tenantId: data.tenantId,
                customerId: data.customerId,
                projectId: data.projectId || null,
                status: data.status || 'UNPAID',
                foNumber: data.foNumber || null,
                cmrNumber: data.cmrNumber || null,
                awNumber: data.awNumber || null,
                carrierCompany: data.carrierCompany || null,
                productDescription: data.productDescription || null,
                quantity: data.quantity || null,
                unit: data.unit || null,
                grossWeight: data.grossWeight || null,
                netWeight: data.netWeight || null,
                dimensions: data.dimensions || null,
                extraNotes: data.extraNotes || null,
                shipmentDate: data.shipmentDate || null,
                eta: data.eta || null,
                invoiceUrl: data.invoiceUrl || null,
                autoMarkDelayed: data.autoMarkDelayed ?? false,
                requireInvoiceForPaid: data.requireInvoiceForPaid ?? true,
            }
        });
        return this.mapToEntity(created);
    }
    async update(id, data) {
        const updated = await prisma_client_1.default.shipment.update({
            where: { id },
            data: data
        });
        return this.mapToEntity(updated);
    }
    async markManyDelayed(ids) {
        if (ids.length === 0)
            return 0;
        const result = await prisma_client_1.default.shipment.updateMany({
            where: { id: { in: ids } },
            data: { status: 'DELAYED' },
        });
        return result.count;
    }
    async findById(id) {
        const data = await prisma_client_1.default.shipment.findUnique({
            where: { id },
            include: {
                customer: { select: { companyName: true, mainEmail: true } },
                project: { select: { projectName: true } }
            }
        });
        return data ? this.mapToEntity(data) : null;
    }
    async findAll(filter) {
        const where = { tenantId: filter.tenantId };
        if (filter.customerId)
            where.customerId = filter.customerId;
        if (filter.projectId)
            where.projectId = filter.projectId;
        if (filter.status)
            where.status = filter.status;
        if (filter.search) {
            where.OR = [
                { foNumber: { contains: filter.search } },
                { cmrNumber: { contains: filter.search } },
                { awNumber: { contains: filter.search } },
                { carrierCompany: { contains: filter.search } },
                { productDescription: { contains: filter.search } },
            ];
        }
        if (filter.isEtaPassed) {
            where.eta = { lt: new Date() };
            where.status = { notIn: ['PAID', 'CANCELLED'] };
        }
        const list = await prisma_client_1.default.shipment.findMany({
            where,
            include: {
                customer: { select: { companyName: true } },
                project: { select: { projectName: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        return list;
    }
    async delete(id) {
        await prisma_client_1.default.shipment.delete({ where: { id } });
    }
    async findByDocumentNumber(tenantId, docType, number, excludeId) {
        const where = { tenantId, [docType]: number };
        if (excludeId) {
            where.id = { not: excludeId };
        }
        const data = await prisma_client_1.default.shipment.findFirst({ where });
        return data ? this.mapToEntity(data) : null;
    }
}
exports.ShipmentRepository = ShipmentRepository;
//# sourceMappingURL=ShipmentRepository.js.map