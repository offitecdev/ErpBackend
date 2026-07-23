import prisma from "../database/prisma.client";
import { ICustomerRepository, ICustomerFilter, PaginatedResult } from "../../domain/repositories/ICustomerRepository";
import { Customer } from "../../domain/entities/Customer";
import { nanoid } from "nanoid";

// Lifecycle statuses that count as "inactive" for the legacy isActive flag.
// Active, Potential and Problematic customers remain active relationships.
const INACTIVE_CUSTOMER_STATUSES = new Set(["PASSIVE", "BLOCKED"]);
const deriveIsActive = (status: string) => !INACTIVE_CUSTOMER_STATUSES.has(status);

export class CustomerRepository implements ICustomerRepository {
    private mapToEntity(data: any): Customer {
        return new Customer(
            data.id,
            data.tenantId,
            data.companyName,
            data.isActive,
            data.segment,
            data.taxOffice,
            data.taxNumber,
            data.address,
            data.mainPhone,
            data.mainEmail,
            data.customerType ?? "PRIVATE",
            data.mobilePhone,
            data.website,
            data.language,
            data.vatNumber,
            data.customerSource,
            data.responsibleFirstName,
            data.responsibleLastName,
            data.status ?? "ACTIVE",
            data.priceList,
            data.addressName,
            data.postalCode,
            data.city,
            data.country
        )
    }

    async createCustomer(customerData: Partial<Customer>): Promise<Customer> {
        const status = customerData.status ?? "ACTIVE";
        const data = await prisma.customer.create({
            data: {
                id: customerData.id || nanoid(8),
                tenantId: customerData.tenantId!,
                companyName: customerData.companyName!,
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

    async update(id: string, customerData: Partial<Customer>): Promise<Customer> {
        const { id: _id, tenantId: _tid, ...safeData } = customerData;
        // When the status changes, keep the legacy isActive boolean consistent.
        if (typeof (safeData as any).status === "string" && (safeData as any).isActive === undefined) {
            (safeData as any).isActive = deriveIsActive((safeData as any).status);
        }
        const data = await prisma.customer.update({
            where: { id },
            data: safeData as any
        });
        return this.mapToEntity(data);
    }

    async delete(id: string, tenantId?: string): Promise<void> {
        const where: any = { id };
        if (tenantId) where.tenantId = tenantId;

        const customer = await prisma.customer.findFirst({ where });
        if (!customer) {
            throw new Error('Müşteri bulunamadı.');
        }

        // Block deletion when the customer still has business records that must be preserved.
        const [tenders, projects, salesOrders, invoices, shipments, serviceCalls, workOrders, maintenanceContracts] = await Promise.all([
            prisma.tender.count({ where: { customerId: id } }),
            prisma.project.count({ where: { customerId: id } }),
            prisma.salesOrder.count({ where: { customerId: id } }),
            prisma.invoice.count({ where: { customerId: id } }),
            prisma.shipment.count({ where: { customerId: id } }),
            prisma.serviceCall.count({ where: { customerId: id } }),
            prisma.workOrder.count({ where: { customerId: id } }),
            prisma.maintenanceContract.count({ where: { customerId: id } }),
        ]);

        const blockingTotal = tenders + projects + salesOrders + invoices + shipments + serviceCalls + workOrders + maintenanceContracts;
        if (blockingTotal > 0) {
            throw new Error('Bu müşteri silinemez: teklif, proje veya sipariş gibi bağlı kayıtlar bulunuyor. Önce ilişkili kayıtları kaldırın ya da müşteriyi pasif yapın.');
        }

        // Remove the purely CRM-owned child records, then the customer, atomically.
        await prisma.$transaction([
            prisma.customerNote.deleteMany({ where: { customerId: id } }),
            prisma.customerActivity.deleteMany({ where: { customerId: id } }),
            prisma.customerContact.deleteMany({ where: { customerId: id } }),
            prisma.customerLocation.deleteMany({ where: { customerId: id } }),
            prisma.appointment.deleteMany({ where: { customerId: id } }),
            prisma.offerScheduleSlot.deleteMany({ where: { customerId: id } }),
            prisma.document.deleteMany({ where: { entityType: 'customer', relatedEntityId: id } }),
            prisma.customer.delete({ where: { id } }),
        ]);
    }

    async findById(id: string): Promise<Customer | null> {
        const data = await prisma.customer.findUnique({
            where: { id },
        });
        return data ? this.mapToEntity(data) : null;
    }

    async findAll(filter: ICustomerFilter): Promise<Customer[] | PaginatedResult<Customer>> {
        const whereClause: any = {
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
        // Kolon bazlı filtreler — üstteki genel arama ile AND'lenir (MySQL collation
        // varsayılan olarak büyük/küçük harf duyarsız, ayrıca `mode` gerekmez).
        if (filter.companyName) whereClause.companyName = { contains: filter.companyName };
        if (filter.vatNumber) whereClause.vatNumber = { contains: filter.vatNumber };
        if (filter.email) whereClause.mainEmail = { contains: filter.email };

        // Sıralama — yalnızca izin verilen DB kolonları; sortBy yoksa alfabetik varsayılan.
        const sortDir: 'asc' | 'desc' = filter.sortDirection === 'asc' ? 'asc' : 'desc';
        let orderBy: any = { companyName: 'asc' };
        switch (filter.sortBy) {
            case 'companyName': orderBy = { companyName: sortDir }; break;
            case 'vatNumber': orderBy = { vatNumber: sortDir }; break;
            case 'status': orderBy = { status: sortDir }; break;
        }

        const page = filter.page && filter.page > 0 ? filter.page : undefined;
        const pageSize = filter.pageSize && filter.pageSize > 0 ? Math.min(filter.pageSize, 100) : undefined;
        const [data, total] = await Promise.all([
            prisma.customer.findMany({
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
                orderBy,
                ...(page && pageSize ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
            }),
            page && pageSize ? prisma.customer.count({ where: whereClause }) : Promise.resolve(0),
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

    


        async getCustomerDashboard(id: string, tenantId?: string, summaryOnly = false): Promise<any> {
        const whereClause: any = { id };
        if (tenantId) whereClause.tenantId = tenantId;

        if (summaryOnly) {
            return prisma.customer.findFirst({
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

        const dashboardData = await prisma.customer.findFirst({
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
            const employeeIds = Array.from(new Set((dashboardData.activities || []).map((activity: any) => activity.employeeId).filter(Boolean)));
            const employees = employeeIds.length > 0
                ? await prisma.employee.findMany({
                    where: { id: { in: employeeIds } },
                    select: { id: true, firstName: true, lastName: true, email: true }
                })
                : [];
            const employeeMap = new Map(employees.map((employee) => [employee.id, employee]));
            const activities = (dashboardData.activities || []).map((activity: any) => {
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
