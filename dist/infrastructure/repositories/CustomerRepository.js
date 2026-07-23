"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const Customer_1 = require("../../domain/entities/Customer");
const nanoid_1 = require("nanoid");
// Lifecycle statuses that count as "inactive" for the legacy isActive flag.
// Active, Potential and Problematic customers remain active relationships.
const INACTIVE_CUSTOMER_STATUSES = new Set(["PASSIVE", "BLOCKED"]);
const deriveIsActive = (status) => !INACTIVE_CUSTOMER_STATUSES.has(status);
class CustomerRepository {
    mapToEntity(data) {
        return new Customer_1.Customer(data.id, data.tenantId, data.companyName, data.isActive, data.segment, data.taxOffice, data.taxNumber, data.address, data.mainPhone, data.mainEmail, data.customerType ?? "PRIVATE", data.mobilePhone, data.website, data.language, data.vatNumber, data.customerSource, data.responsibleFirstName, data.responsibleLastName, data.status ?? "ACTIVE", data.priceList, data.addressName, data.postalCode, data.city, data.country);
    }
    async createCustomer(customerData) {
        const status = customerData.status ?? "ACTIVE";
        const data = await prisma_client_1.default.customer.create({
            data: {
                id: customerData.id || (0, nanoid_1.nanoid)(8),
                tenantId: customerData.tenantId,
                companyName: customerData.companyName,
                segment: customerData.segment ?? null,
                customerType: customerData.customerType ?? "PRIVATE",
                taxOffice: customerData.taxOffice ?? null,
                taxNumber: customerData.taxNumber ?? null,
                addressName: customerData.addressName ?? null,
                address: customerData.address ?? null,
                postalCode: customerData.postalCode ?? null,
                city: customerData.city ?? null,
                country: customerData.country ?? null,
                mainPhone: customerData.mainPhone ?? null,
                mobilePhone: customerData.mobilePhone ?? null,
                mainEmail: customerData.mainEmail ?? null,
                website: customerData.website ?? null,
                language: customerData.language ?? null,
                vatNumber: customerData.vatNumber ?? null,
                priceList: customerData.priceList ?? null,
                customerSource: customerData.customerSource ?? null,
                responsibleFirstName: customerData.responsibleFirstName ?? null,
                responsibleLastName: customerData.responsibleLastName ?? null,
                status,
                // Keep the legacy boolean in sync with the lifecycle status.
                isActive: customerData.isActive ?? deriveIsActive(status),
            }
        });
        return this.mapToEntity(data);
    }
    async update(id, customerData) {
        const { id: _id, tenantId: _tid, ...safeData } = customerData;
        // When the status changes, keep the legacy isActive boolean consistent.
        if (typeof safeData.status === "string" && safeData.isActive === undefined) {
            safeData.isActive = deriveIsActive(safeData.status);
        }
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
            prisma_client_1.default.customerLocation.deleteMany({ where: { customerId: id } }),
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
        if (filter.status) {
            whereClause.status = filter.status;
        }
        if (filter.search) {
            whereClause.OR = [
                { companyName: { contains: filter.search } },
                { taxNumber: { contains: filter.search } },
                { vatNumber: { contains: filter.search } },
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
                    customerType: true,
                    taxOffice: true,
                    taxNumber: true,
                    addressName: true,
                    address: true,
                    postalCode: true,
                    city: true,
                    country: true,
                    mainPhone: true,
                    mobilePhone: true,
                    mainEmail: true,
                    website: true,
                    language: true,
                    vatNumber: true,
                    priceList: true,
                    customerSource: true,
                    responsibleFirstName: true,
                    responsibleLastName: true,
                    status: true,
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
    async getCustomerDashboard(id, tenantId, summaryOnly = false) {
        const whereClause = { id };
        if (tenantId)
            whereClause.tenantId = tenantId;
        if (summaryOnly) {
            return prisma_client_1.default.customer.findFirst({
                where: whereClause,
                select: {
                    id: true,
                    companyName: true,
                    customerType: true,
                    vatNumber: true,
                    priceList: true,
                    mainEmail: true,
                    mainPhone: true,
                    mobilePhone: true,
                    website: true,
                    language: true,
                    responsibleFirstName: true,
                    responsibleLastName: true,
                    addressName: true,
                    address: true,
                    postalCode: true,
                    city: true,
                    country: true,
                    status: true,
                    isActive: true,
                }
            });
        }
        const dashboardData = await prisma_client_1.default.customer.findFirst({
            where: whereClause,
            include: {
                contacts: true,
                locations: {
                    orderBy: [{ isPrimary: 'desc' }, { name: 'asc' }]
                },
                notes: {
                    orderBy: { createdAt: 'desc' },
                    include: { createdBy: { select: { firstName: true, lastName: true } } }
                },
                activities: {
                    orderBy: { activityDate: 'desc' },
                    take: 10 // Son 10 aktiviteyi getir
                },
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
            // Offers are loaded independently by the customer page and documents
            // are not rendered there. Keeping both out of this LCP-critical query
            // avoids redundant relation scans and a sequential document lookup.
            return { ...dashboardData, activities };
        }
        return dashboardData;
    }
}
exports.CustomerRepository = CustomerRepository;
//# sourceMappingURL=CustomerRepository.js.map