import prisma from "../database/prisma.client";
import { nanoid } from "nanoid";

export class MaterialRepository {
    async list(tenantId: string, options: { compact?: boolean } = {}) {
        return await prisma.material.findMany({
            where: { tenantId, isActive: true },
            orderBy: { name: 'asc' },
            ...(options.compact ? {
                select: {
                    id: true,
                    tenantId: true,
                    serialId: true,
                    name: true,
                    stockQuantity: true,
                    unitCost: true,
                    minStockLevel: true,
                    criticalStockLevel: true,
                    isActive: true,
                },
            } : {}),
        });
    }

    async findById(id: string) {
        return await prisma.material.findUnique({
            where: { id }
        });
    }

    async decrementStock(id: string, quantity: number) {
        return await prisma.material.update({
            where: { id },
            data: {
                stockQuantity: {
                    decrement: quantity
                }
            }
        });
    }

    async createMaterial(
        tenantId: string,
        name: string,
        serialId: string,
        unitCost: number,
        initialStock: number,
        imageUrl?: string | null,
        minStockLevel = 0,
        criticalStockLevel = 0
    ) {
        return await prisma.material.create({
            data: {
                id: nanoid(10),
                tenantId,
                name,
                serialId,
                unitCost,
                stockQuantity: initialStock,
                minStockLevel,
                criticalStockLevel,
                imageUrl: imageUrl || null,
                isActive: true
            } as any
        });
    }

    async updateMaterial(id: string, patch: any) {
        return await prisma.material.update({
            where: { id },
            data: patch
        });
    }

    async softDeleteMaterial(id: string) {
        return await prisma.material.update({
            where: { id },
            data: { isActive: false }
        });
    }
}
