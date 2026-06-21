import prisma from "../database/prisma.client";
import { nanoid } from "nanoid";

export class MaterialRepository {
    async list(tenantId: string) {
        return await prisma.material.findMany({
            where: { tenantId, isActive: true },
            orderBy: { name: 'asc' }
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

    async createMaterial(tenantId: string, name: string, serialId: string, unitCost: number, initialStock: number, imageUrl?: string | null) {
        return await prisma.material.create({
            data: {
                id: nanoid(10),
                tenantId,
                name,
                serialId,
                unitCost,
                stockQuantity: initialStock,
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
