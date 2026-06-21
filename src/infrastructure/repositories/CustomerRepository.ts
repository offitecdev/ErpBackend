import prisma from "../database/prisma.client";
import { ICustomerRepository, ICustomerFilter, PaginatedResult } from "../../domain/repositories/ICustomerRepository";
import { Customer } from "../../domain/entities/Customer";
import { nanoid } from "nanoid";

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
            data.mainEmail
        )
    }   

    async createCustomer(customerData: Partial<Customer>): Promise<Customer> {
        const data = await prisma.customer.create({
            data: {
                id: customerData.id || nanoid(8),
                tenantId: customerData.tenantId!,
                companyName: customerData.companyName!,
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

    async update(id: string, customerData: Partial<Customer>): Promise<Customer> {
        const { id: _id, tenantId: _tid, ...safeData } = customerData;
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
            prisma.customer.findMany({
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

    


        async getCustomerDashboard(id: string, tenantId?: string): Promise<any> {
        const whereClause: any = { id };
        if (tenantId) whereClause.tenantId = tenantId;

        const dashboardData = await prisma.customer.findFirst({
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
            const documents = await prisma.document.findMany({
                where: { entityType: 'customer', relatedEntityId: id },
                orderBy: { fileName: 'asc' }
            });
            return { ...dashboardData, activities, documents };
        }

        return dashboardData;
    }
    
}
