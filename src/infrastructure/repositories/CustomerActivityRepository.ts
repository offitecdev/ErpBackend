import prisma from "../database/prisma.client";
import {ICustomerActivityRepository , ITimeLineFilter} from "../../domain/repositories/ICustomerActivityRepository";
import {CustomerActivity} from "../../domain/entities/CustomerActivitiy";
import { nanoid } from "nanoid";

export class CustomerActivityRepository implements ICustomerActivityRepository{
    private mapToEntity(data:any) : CustomerActivity{
        return new CustomerActivity(
            data.id,
            data.customerId,
            data.employeeId,
            data.activityType,
            data.activityDate,
            data.description,
            data.referenceId
        ); 
    }

    async create(activityData : Partial<CustomerActivity>): Promise<CustomerActivity> {
        const data = await prisma.customerActivity.create({
            data : {
                id : activityData.id || nanoid(),
                customerId : activityData.customerId!,
                employeeId : activityData.employeeId!,
                activityType : activityData.activityType!,
                activityDate : activityData.activityDate || new Date(),
                description : activityData.description || null,
                referenceId : activityData.referenceId || null
            }
        });
        return this.mapToEntity(data);
    }

    async getActivitiesByReference(referenceId: string): Promise<any[]> {
        const data = await prisma.customerActivity.findMany({
            where: { referenceId },
            orderBy: { activityDate: 'desc' }
        });
        if (data.length === 0) return [];

        const employeeIds = Array.from(new Set(data.map(d => d.employeeId)));
        const employees = await prisma.employee.findMany({
            where: { id: { in: employeeIds } },
            select: { id: true, firstName: true, lastName: true, email: true }
        });
        const empMap = new Map(employees.map(e => [e.id, e]));

        return data.map((d: any) => {
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

    async getCustomerActivities(customerId: string, filter?: ITimeLineFilter): Promise<CustomerActivity[]> {
        const whereClause : any = { customerId };

        if(filter?.activityType){   
            whereClause.activityType = filter.activityType;
        }

        if(filter?.startDate || filter?.endDate){
            whereClause.activityDate = {};
            if(filter.startDate){
                whereClause.activityDate.gte = filter.startDate;
            }
            if(filter.endDate){ 
                whereClause.activityDate.lte = filter.endDate;    
            }
        }

        const data = await prisma.customerActivity.findMany({
            where : whereClause,
            orderBy : {activityDate : 'desc'}
        });

        return data.map((activity) => this.mapToEntity(activity));
    }

    async findById(id: string): Promise<CustomerActivity | null> {
        const data = await prisma.customerActivity.findUnique({ where: { id } });
        return data ? this.mapToEntity(data) : null;
    }

    async update(id: string, activity: Partial<CustomerActivity>): Promise<CustomerActivity> {
        const data: any = {};
        if (activity.activityType !== undefined) data.activityType = activity.activityType;
        if (activity.description !== undefined) data.description = activity.description;
        if (activity.activityDate !== undefined) data.activityDate = activity.activityDate;
        const updated = await prisma.customerActivity.update({ where: { id }, data });
        return this.mapToEntity(updated);
    }

    async delete(id: string): Promise<void> {
        await prisma.customerActivity.delete({ where: { id } });
    }
}