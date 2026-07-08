"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MaterialRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const nanoid_1 = require("nanoid");
class MaterialRepository {
    async list(tenantId) {
        return await prisma_client_1.default.material.findMany({
            where: { tenantId, isActive: true },
            orderBy: { name: 'asc' }
        });
    }
    async findById(id) {
        return await prisma_client_1.default.material.findUnique({
            where: { id }
        });
    }
    async decrementStock(id, quantity) {
        return await prisma_client_1.default.material.update({
            where: { id },
            data: {
                stockQuantity: {
                    decrement: quantity
                }
            }
        });
    }
    async createMaterial(tenantId, name, serialId, unitCost, initialStock, imageUrl, minStockLevel = 0, criticalStockLevel = 0) {
        return await prisma_client_1.default.material.create({
            data: {
                id: (0, nanoid_1.nanoid)(10),
                tenantId,
                name,
                serialId,
                unitCost,
                stockQuantity: initialStock,
                minStockLevel,
                criticalStockLevel,
                imageUrl: imageUrl || null,
                isActive: true
            }
        });
    }
    async updateMaterial(id, patch) {
        return await prisma_client_1.default.material.update({
            where: { id },
            data: patch
        });
    }
    async softDeleteMaterial(id) {
        return await prisma_client_1.default.material.update({
            where: { id },
            data: { isActive: false }
        });
    }
}
exports.MaterialRepository = MaterialRepository;
//# sourceMappingURL=MaterialRepository.js.map