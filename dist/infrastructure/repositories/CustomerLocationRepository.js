"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerLocationRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const CustomerLocation_1 = require("../../domain/entities/CustomerLocation");
const nanoid_1 = require("nanoid");
class CustomerLocationRepository {
    mapToEntity(data) {
        return new CustomerLocation_1.CustomerLocation(data.id, data.customerId, data.name, data.isPrimary, data.kind ?? "INSTALLATION", data.address, data.city, data.postalCode, data.country, data.phone, data.email, data.contactPerson, data.notes, data.createdAt, data.updatedAt);
    }
    async create(data) {
        const customerId = data.customerId;
        const makePrimary = data.isPrimary ?? false;
        const created = await prisma_client_1.default.$transaction(async (tx) => {
            // Enforce a single primary address per customer: setting this one
            // primary clears the flag on all of the customer's other locations.
            if (makePrimary) {
                await tx.customerLocation.updateMany({
                    where: { customerId, isPrimary: true },
                    data: { isPrimary: false },
                });
            }
            return tx.customerLocation.create({
                data: {
                    id: data.id || (0, nanoid_1.nanoid)(8),
                    customerId,
                    name: data.name,
                    kind: data.kind ?? "INSTALLATION",
                    address: data.address ?? null,
                    city: data.city ?? null,
                    postalCode: data.postalCode ?? null,
                    country: data.country ?? null,
                    phone: data.phone ?? null,
                    email: data.email ?? null,
                    contactPerson: data.contactPerson ?? null,
                    isPrimary: makePrimary,
                    notes: data.notes ?? null,
                }
            });
        });
        return this.mapToEntity(created);
    }
    async findById(id) {
        const data = await prisma_client_1.default.customerLocation.findUnique({ where: { id } });
        return data ? this.mapToEntity(data) : null;
    }
    async findByCustomerId(customerId) {
        const data = await prisma_client_1.default.customerLocation.findMany({
            where: { customerId },
            orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }]
        });
        return data.map(item => this.mapToEntity(item));
    }
    async update(id, data) {
        const { id: _id, customerId: _cid, createdAt: _ca, updatedAt: _ua, ...safeData } = data;
        const updated = await prisma_client_1.default.$transaction(async (tx) => {
            // Enforce a single primary address per customer: promoting this
            // location to primary demotes the customer's other primary locations.
            if (safeData.isPrimary === true) {
                const existing = await tx.customerLocation.findUnique({
                    where: { id },
                    select: { customerId: true },
                });
                if (existing) {
                    await tx.customerLocation.updateMany({
                        where: { customerId: existing.customerId, isPrimary: true, id: { not: id } },
                        data: { isPrimary: false },
                    });
                }
            }
            return tx.customerLocation.update({
                where: { id },
                data: safeData,
            });
        });
        return this.mapToEntity(updated);
    }
    async delete(id) {
        await prisma_client_1.default.customerLocation.delete({ where: { id } });
    }
}
exports.CustomerLocationRepository = CustomerLocationRepository;
//# sourceMappingURL=CustomerLocationRepository.js.map