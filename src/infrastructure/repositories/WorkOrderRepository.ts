import prisma from "../database/prisma.client";
import { IWorkOrderRepository } from "../../domain/repositories/IWorkOrderRepository";
import { WorkOrder } from "../../domain/entities/WorkOrder";

export class WorkOrderRepository implements IWorkOrderRepository {
    async createOrder(order: Partial<WorkOrder>): Promise<WorkOrder> {
        const data = await prisma.workOrder.create({ data: order as any });
        return data as unknown as WorkOrder;
    }

    async getOrderById(id: string): Promise<WorkOrder | null> {
        const data = await prisma.workOrder.findUnique({ where: { id } });
        return data ? data as unknown as WorkOrder : null;
    }

    async listOrders(tenantId: string, isBilled?: boolean): Promise<WorkOrder[]> {
        const where: any = { tenantId };
        if (isBilled !== undefined) where.isBilled = isBilled;
        const data = await prisma.workOrder.findMany({ where, orderBy: { createdAt: 'desc' } });
        return data as unknown as WorkOrder[];
    }

    async markAsBilled(id: string): Promise<void> {
        await prisma.workOrder.update({
            where: { id },
            data: { isBilled: true }
        });
    }
}