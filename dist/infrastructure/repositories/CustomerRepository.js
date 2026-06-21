"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const Customer_1 = require("../../domain/entities/Customer");
const nanoid_1 = require("nanoid");
class CustomerRepository {
    mapToEntity(data) {
        return new Customer_1.Customer(data.id, data.tenantId, data.companyName, data.isActive, data.segment, data.taxOffice, data.taxNumber, data.address, data.mainPhone, data.mainEmail);
    }
    async createCustomer(customerData) {
        const data = await prisma_client_1.default.customer.create({
            data: {
                id: customerData.id || (0, nanoid_1.nanoid)(8),
                tenantId: customerData.tenantId,
                companyName: customerData.companyName,
                segment: customerData.segment ?? null,
                taxOffice: customerData.taxOffice ?? null,
                taxNumber: customerData.taxNumber ?? null,
                address: customerData.address ?? null,
                mainPhone: customerData.mainPhone ?? null,
                mainEmail: customerData.mainEmail ?? null,
                isActive: customerData.isActive ?? true,
            }
        });
        return this.mapToEntity(data);
    }
    async update(id, customerData) {
        const { id: _id, tenantId: _tid, ...safeData } = customerData;
        const data = await prisma_client_1.default.customer.update({
            where: { id },
            data: safeData
        });
        return this.mapToEntity(data);
    }
    async delete(id, tenantId) {
        const where = { id };
        if (tenantId)
            where.tenantId = tenantId;
        const customer = await prisma_client_1.default.customer.findFirst({ where });
        if (!customer) {
            throw new Error('Müşteri bulunamadı.');
        }
        // Block deletion when the customer still has business records that must be preserved.
        const [tenders, projects, salesOrders, invoices, shipments, serviceCalls, workOrders, maintenanceContracts] = await Promise.all([
            prisma_client_1.default.tender.count({ where: { customerId: id } }),
            prisma_client_1.default.project.count({ where: { customerId: id } }),
            prisma_client_1.default.salesOrder.count({ where: { customerId: id } }),
            prisma_client_1.default.invoice.count({ where: { customerId: id } }),
            prisma_client_1.default.shipment.count({ where: { customerId: id } }),
            prisma_client_1.default.serviceCall.count({ where: { customerId: id } }),
            prisma_client_1.default.workOrder.count({ where: { customerId: id } }),
            prisma_client_1.default.maintenanceContract.count({ where: { customerId: id } }),
        ]);
        const blockingTotal = tenders + projects + salesOrders + invoices + shipments + serviceCalls + workOrders + maintenanceContracts;
        if (blockingTotal > 0) {
            throw new Error('Bu müşteri silinemez: teklif, proje veya sipariş gibi bağlı kayıtlar bulunuyor. Önce ilişkili kayıtları kaldırın ya da müşteriyi pasif yapın.');
        }
        // Remove the purely CRM-owned child records, then the customer, atomically.
        await prisma_client_1.default.$transaction([
            prisma_client_1.default.customerNote.deleteMany({ where: { customerId: id } }),
            prisma_client_1.default.customerActivity.deleteMany({ where: { customerId: id } }),
            prisma_client_1.default.customerContact.deleteMany({ where: { customerId: id } }),
            prisma_client_1.default.appointment.deleteMany({ where: { customerId: id } }),
            prisma_client_1.default.offerScheduleSlot.deleteMany({ where: { customerId: id } }),
            prisma_client_1.default.document.deleteMany({ where: { entityType: 'customer', relatedEntityId: id } }),
            prisma_client_1.default.customer.delete({ where: { id } }),
        ]);
    }
    async findById(id) {
        const data = await prisma_client_1.default.customer.findUnique({
            where: { id },
        });
        return data ? this.mapToEntity(data) : null;
    }
    async findAll(filter) {
        const whereClause = {
            tenantId: filter.tenantId
        };
        if (filter.isActive !== undefined) {
            whereClause.isActive = filter.isActive;
        }
        if (filter.segment) {
            whereClause.segment = filter.segment;
        }
        if (filter.search) {
            whereClause.OR = [
                { companyName: { contains: filter.search } },
                { taxNumber: { contains: filter.search } },
                { mainEmail: { contains: filter.search } }
            ];
        }
        const page = filter.page && filter.page > 0 ? filter.page : undefined;
        const pageSize = filter.pageSize && filter.pageSize > 0 ? Math.min(filter.pageSize, 100) : undefined;
        const [data, total] = await Promise.all([
            prisma_client_1.default.customer.findMany({
                where: whereClause,
                select: {
                    id: true,
                    tenantId: true,
                    companyName: true,
                    isActive: true,
                    segment: true,
                    taxOffice: true,
                    taxNumber: true,
                    address: true,
                    mainPhone: true,
                    mainEmail: true,
                },
                orderBy: { companyName: 'asc' },
                ...(page && pageSize ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
            }),
            page && pageSize ? prisma_client_1.default.customer.count({ where: whereClause }) : Promise.resolve(0),
        ]);
        const items = data.map(d => this.mapToEntity(d));
        if (page && pageSize) {
            return {
                items,
                total,
                page,
                pageSize,
                totalPages: Math.max(1, Math.ceil(total / pageSize)),
            };
        }
        return items;
    }
    async getCustomerDashboard(id, tenantId) {
        const whereClause = { id };
        if (tenantId)
            whereClause.tenantId = tenantId;
        const dashboardData = await prisma_client_1.default.customer.findFirst({
            where: whereClause,
            include: {
                contacts: true,
                notes: {
                    orderBy: { createdAt: 'desc' },
                    include: { createdBy: { select: { firstName: true, lastName: true } } }
                },
                activities: {
                    orderBy: { activityDate: 'desc' },
                    take: 10 // Son 10 aktiviteyi getir
                },
                // YENİ EKLENEN KISIM: Müşterinin Teklifleri
                tenders: {
                    orderBy: { createdAt: 'desc' },
                    select: {
                        id: true,
                        tenderNumber: true,
                        version: true,
                        status: true,
                        format: true,
                        createdAt: true
                    }
                }
            }
        });
        if (dashboardData) {
            const employeeIds = Array.from(new Set((dashboardData.activities || []).map((activity) => activity.employeeId).filter(Boolean)));
            const employees = employeeIds.length > 0
                ? await prisma_client_1.default.employee.findMany({
                    where: { id: { in: employeeIds } },
                    select: { id: true, firstName: true, lastName: true, email: true }
                })
                : [];
            const employeeMap = new Map(employees.map((employee) => [employee.id, employee]));
            const activities = (dashboardData.activities || []).map((activity) => {
                const employee = employeeMap.get(activity.employeeId);
                return {
                    ...activity,
                    employeeName: employee ? `${employee.firstName} ${employee.lastName}` : null,
                    employeeEmail: employee?.email ?? null
                };
            });
            const documents = await prisma_client_1.default.document.findMany({
                where: { entityType: 'customer', relatedEntityId: id },
                orderBy: { fileName: 'asc' }
            });
            return { ...dashboardData, activities, documents };
        }
        return dashboardData;
    }
}
exports.CustomerRepository = CustomerRepository;
//# sourceMappingURL=CustomerRepository.js.map