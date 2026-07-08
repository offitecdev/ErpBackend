"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomerActivityRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const CustomerActivitiy_1 = require("../../domain/entities/CustomerActivitiy");
const nanoid_1 = require("nanoid");
class CustomerActivityRepository {
    mapToEntity(data) {
        return new CustomerActivitiy_1.CustomerActivity(data.id, data.customerId, data.employeeId, data.activityType, data.activityDate, data.description, data.referenceId);
    }
    async create(activityData) {
        const data = await prisma_client_1.default.customerActivity.create({
            data: {
                id: activityData.id || (0, nanoid_1.nanoid)(),
                customerId: activityData.customerId,
                employeeId: activityData.employeeId,
                activityType: activityData.activityType,
                activityDate: activityData.activityDate || new Date(),
                description: activityData.description || null,
                referenceId: activityData.referenceId || null
            }
        });
        return this.mapToEntity(data);
    }
    async getActivitiesByReference(referenceId) {
        const data = await prisma_client_1.default.customerActivity.findMany({
            where: { referenceId },
            orderBy: { activityDate: 'desc' }
        });
        if (data.length === 0)
            return [];
        const employeeIds = Array.from(new Set(data.map(d => d.employeeId)));
        const employees = await prisma_client_1.default.employee.findMany({
            where: { id: { in: employeeIds } },
            select: { id: true, firstName: true, lastName: true, email: true }
        });
        const empMap = new Map(employees.map(e => [e.id, e]));
        return data.map((d) => {
            const emp = empMap.get(d.employeeId);
            return {
                id: d.id,
                customerId: d.customerId,
                employeeId: d.employeeId,
                employeeName: emp ? `${emp.firstName} ${emp.lastName}` : null,
                employeeEmail: emp?.email ?? null,
                activityType: d.activityType,
                activityDate: d.activityDate,
                description: d.description,
                referenceId: d.referenceId,
            };
        });
    }
    async getCustomerActivities(customerId, filter) {
        const whereClause = { customerId };
        if (filter?.activityType) {
            whereClause.activityType = filter.activityType;
        }
        if (filter?.startDate || filter?.endDate) {
            whereClause.activityDate = {};
            if (filter.startDate) {
                whereClause.activityDate.gte = filter.startDate;
            }
            if (filter.endDate) {
                whereClause.activityDate.lte = filter.endDate;
            }
        }
        const data = await prisma_client_1.default.customerActivity.findMany({
            where: whereClause,
            orderBy: { activityDate: 'desc' }
        });
        return data.map((activity) => this.mapToEntity(activity));
    }
    async findById(id) {
        const data = await prisma_client_1.default.customerActivity.findUnique({ where: { id } });
        return data ? this.mapToEntity(data) : null;
    }
    async update(id, activity) {
        const data = {};
        if (activity.activityType !== undefined)
            data.activityType = activity.activityType;
        if (activity.description !== undefined)
            data.description = activity.description;
        if (activity.activityDate !== undefined)
            data.activityDate = activity.activityDate;
        const updated = await prisma_client_1.default.customerActivity.update({ where: { id }, data });
        return this.mapToEntity(updated);
    }
    async delete(id) {
        await prisma_client_1.default.customerActivity.delete({ where: { id } });
    }
}
exports.CustomerActivityRepository = CustomerActivityRepository;
//# sourceMappingURL=CustomerActivityRepository.js.map