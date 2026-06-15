import prisma from "../database/prisma.client";
import { Project, ProjectExpense } from "../../domain/entities/Project";

export class ProjectRepository {
    async createProject(data: Partial<Project>): Promise<Project> {
        return await prisma.$transaction(async (tx) => {
            const project = await tx.project.create({
                data: data as any
            });

            if ((data as any).tenderId) {
                await tx.tender.update({
                    where: { id: (data as any).tenderId },
                    data: { projectId: project.id }
                });
            }

            return project as unknown as Project;
        });
    }

    async updateProject(id: string, data: Partial<Project>): Promise<Project> {
        return await prisma.project.update({
            where: { id },
            data: data as any
        }) as unknown as Project;
    }

    async findById(id: string, tenantId?: string): Promise<Project | null> {
        return await (prisma as any).project.findFirst({
            where: tenantId ? { id, tenantId } : { id },
            include: {
                customer: true,
                manager: { select: { id: true, firstName: true, lastName: true, email: true } },
                tender: {
                    select: {
                        id: true,
                        tenderNumber: true,
                        status: true,
                        projectId: true,
                        usedMaterials: {
                            orderBy: { createdAt: 'desc' },
                            include: { material: true },
                        },
                        positions: {
                            select: {
                                id: true,
                                positionNumber: true,
                                shortDescription: true,
                                materialMappings: {
                                    select: {
                                        id: true,
                                        materialId: true,
                                        quantityMultiplier: true,
                                        discount: true,
                                        material: {
                                            select: {
                                                id: true,
                                                serialId: true,
                                                name: true,
                                                stockQuantity: true,
                                                unitCost: true,
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                salesOrders: {
                    orderBy: { createdAt: 'asc' },
                    include: {
                        customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true } },
                        parentSalesOrder: { select: { id: true, orderNumber: true } },
                        addonSalesOrders: { select: { id: true, orderNumber: true, revisionNumber: true, totalAmount: true, createdAt: true } },
                        tender: {
                            select: {
                                id: true,
                                tenderNumber: true,
                                status: true,
                                projectId: true,
                                usedMaterials: {
                                    orderBy: { createdAt: 'desc' },
                                    include: { material: true },
                                },
                                positions: {
                                    select: {
                                        id: true,
                                        positionNumber: true,
                                        shortDescription: true,
                                        materialMappings: {
                                            select: {
                                                id: true,
                                                materialId: true,
                                                quantityMultiplier: true,
                                                discount: true,
                                                material: {
                                                    select: {
                                                        id: true,
                                                        serialId: true,
                                                        name: true,
                                                        stockQuantity: true,
                                                        unitCost: true,
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                    },
                },
                phases: true,
                expenses: { orderBy: { expenseDate: 'desc' } },
                appointments: {
                    orderBy: { startTime: 'asc' },
                    include: {
                        assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } },
                        technicianAssignments: {
                            orderBy: { assignedAt: 'asc' },
                            include: { technician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } } },
                        },
                    },
                },
                reports: {
                    orderBy: { reportDate: 'desc' },
                    include: {
                        employee: { select: { id: true, firstName: true, lastName: true, email: true } },
                        usedMaterials: { include: { article: true, material: true } }
                    }
                },
                projectVariations: {
                    orderBy: { createdAt: 'desc' },
                    include: { material: true }
                },
                extraMaterials: {
                    orderBy: { addedAt: 'desc' },
                    include: { material: true }
                }
            }
        }) as unknown as Project;
    }

    async findByToken(bookingToken: string): Promise<Project | null> {
        return await prisma.project.findUnique({
            where: { bookingToken },
            include: {
                customer: true,
                tenant: true
            }
        }) as unknown as Project;
    }

    async findAll(filter: any): Promise<Project[]> {
        const where: any = { tenantId: filter.tenantId };
        if (filter.status) where.status = filter.status;
        if (filter.managerId) where.managerId = filter.managerId;
        if (filter.search) {
            where.OR = [
                { projectName: { contains: filter.search } },
                { customer: { companyName: { contains: filter.search } } },
                { tender: { tenderNumber: { contains: filter.search } } }
            ];
        }
        
        return await (prisma as any).project.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
                customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true } },
                manager: { select: { id: true, firstName: true, lastName: true, email: true } },
                tender: { select: { id: true, tenderNumber: true, status: true } },
                salesOrders: {
                    orderBy: { createdAt: 'asc' },
                    select: {
                        id: true,
                        orderNumber: true,
                        orderType: true,
                        status: true,
                        totalAmount: true,
                        parentSalesOrderId: true,
                        revisionNumber: true,
                        createdAt: true,
                        parentSalesOrder: { select: { id: true, orderNumber: true } },
                        tender: { select: { id: true, tenderNumber: true, status: true, projectId: true } },
                    },
                },
                appointments: {
                    orderBy: { startTime: 'asc' },
                    include: {
                        assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } },
                        technicianAssignments: {
                            orderBy: { assignedAt: 'asc' },
                            include: { technician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } } },
                        },
                    },
                },
                _count: { select: { reports: true, expenses: true, projectVariations: true, salesOrders: true } }
            }
        }) as unknown as Project[];
    }

    async listMaterials(tenantId: string): Promise<any[]> {
        return await prisma.material.findMany({
            where: { tenantId, isActive: true },
            orderBy: { name: 'asc' }
        });
    }

    // PDF 2.2.1: Canlı Maliyet (Actual Cost) Güncellemesi (Atomik Increment)
    async updateActualCost(id: string, additionalCost: number): Promise<void> {
        // Deprecated: current billing is calculated from offer budget, extra materials,
        // external expenses and daily overtime. Kept for legacy callers.
    }

    async addExpense(expense: Partial<ProjectExpense>): Promise<any> {
        return await prisma.projectExpense.create({
            data: expense as any
        });
    }

    async createVariation(variationData: any): Promise<any> {
        return await prisma.projectVariation.create({
            data: variationData
        });
    }

    async createExtraMaterial(data: any): Promise<any> {
        return await prisma.$transaction(async (tx) => {
            await tx.material.update({
                where: { id: data.materialId },
                data: { stockQuantity: { decrement: Number(data.quantity || 0) } },
            });
            return await (tx as any).projectExtraMaterial.create({
                data,
                include: { material: true }
            });
        });
    }

    async findVariationById(variationId: string): Promise<any> {
        return await prisma.projectVariation.findUnique({
            where: { id: variationId }
        });
    }

    async updateVariationStatus(variationId: string, status: string, resolverId: string): Promise<any> {
        return await prisma.projectVariation.update({
            where: { id: variationId },
            data: {
                status,
                resolvedById: resolverId,
                resolvedAt: new Date()
            }
        });
    }

    async getPendingVariations(projectId: string): Promise<any[]> {
        return await prisma.projectVariation.findMany({
            where: {
                projectId: projectId,
                status: 'PENDING'
            }
        });
    }

    async createPhase(phaseData: any): Promise<any> {
        return await prisma.projectPhase.create({
            data: phaseData
        });
    }

    async updatePhaseProgress(phaseId: string, progress: number): Promise<any> {
        return await prisma.projectPhase.update({
            where: { id: phaseId },
            data: { progressPercentage: progress }
        });
    }

    async getPhasesByProjectId(projectId: string): Promise<any[]> {
        return await prisma.projectPhase.findMany({
            where: { projectId: projectId }
        });
    }

    async getExpensesByProjectId(projectId: string): Promise<any[]> {
        return await prisma.projectExpense.findMany({
            where: { projectId: projectId }
        });
    }
}
