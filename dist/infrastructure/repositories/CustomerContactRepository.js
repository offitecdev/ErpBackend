"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerContactRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const CustomerContact_1 = require("../../domain/entities/CustomerContact");
const nanoid_1 = require("nanoid");
class CustomerContactRepository {
    mapToEntity(data) {
        return new CustomerContact_1.CustomerContact(data.id, data.customerId, data.firstName, data.lastName, data.isPrimaryContact, data.title, data.phone, data.email);
    }
    async create(contactData) {
        const data = await prisma_client_1.default.customerContact.create({
            data: {
                id: contactData.id || (0, nanoid_1.nanoid)(8),
                customerId: contactData.customerId,
                firstName: contactData.firstName,
                lastName: contactData.lastName,
                title: contactData.title || null,
                phone: contactData.phone || null,
                email: contactData.email || null,
                isPrimaryContact: contactData.isPrimaryContact ?? false
            }
        });
        return this.mapToEntity(data);
    }
    async findById(id) {
        const data = await prisma_client_1.default.customerContact.findUnique({
            where: { id }
        });
        return data ? this.mapToEntity(data) : null;
    }
    async findByCustomerId(customerId) {
        const data = await prisma_client_1.default.customerContact.findMany({
            where: { customerId }
        });
        return data.map(item => this.mapToEntity(item));
    }
    async update(id, contactData) {
        const { id: _id, customerId: _cid, ...safeData } = contactData;
        const data = await prisma_client_1.default.customerContact.update({
            where: { id },
            data: safeData
        });
        return this.mapToEntity(data);
    }
    async delete(id) {
        await prisma_client_1.default.customerContact.delete({
            where: { id }
        });
    }
}
exports.CustomerContactRepository = CustomerContactRepository;
//# sourceMappingURL=CustomerContactRepository.js.map