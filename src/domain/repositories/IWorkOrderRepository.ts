import { WorkOrder } from "../entities/WorkOrder";

export interface IWorkOrderRepository {
    createOrder(order: Partial<WorkOrder>): Promise<WorkOrder>;
    getOrderById(id: string): Promise<WorkOrder | null>;
    listOrders(tenantId: string, isBilled?: boolean): Promise<WorkOrder[]>;
    markAsBilled(id: string): Promise<void>;
}