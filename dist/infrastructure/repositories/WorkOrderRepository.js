"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkOrderRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
class WorkOrderRepository {
    async createOrder(order) {
        const data = await prisma_client_1.default.workOrder.create({ data: order });
        return data;
    }
    async getOrderById(id) {
        const data = await prisma_client_1.default.workOrder.findUnique({ where: { id } });
        return data ? data : null;
    }
    async listOrders(tenantId, isBilled) {
        const where = { tenantId };
        if (isBilled !== undefined)
            where.isBilled = isBilled;
        const data = await prisma_client_1.default.workOrder.findMany({ where, orderBy: { createdAt: 'desc' } });
        return data;
    }
    async markAsBilled(id) {
        await prisma_client_1.default.workOrder.update({
            where: { id },
            data: { isBilled: true }
        });
    }
}
exports.WorkOrderRepository = WorkOrderRepository;
//# sourceMappingURL=WorkOrderRepository.js.map