import prisma from "../database/prisma.client";
import { Project, ProjectExpense } from "../../domain/entities/Project";
import { nextDocumentNumber } from "../../shared/documentNumber";
import { adjustArticleStock } from "../../shared/articleStock";

export type ProjectDetailView =
    | "overview"
    | "details"
    | "planning"
    | "fieldReports"
    | "generalReport"
    | "delivery"
    | "signatures"
    | "expenses"
    | "materials"
    | "overtime"
    | "billing"
    | "addons";

// Malzeme/ürün birleşmesi (2026-08-14): "malzeme" satırları Article'a bağlıdır;
// istemci `article`/`articleId` okur.
const articleLiteSelect = {
    id: true,
    articleCode: true,
    name: true,
    salePrice: true,
};

const tenderMaterialUsageSelect = {
    id: true,
    articleId: true,
    quantity: true,
    unitCost: true,
    description: true,
    article: { select: articleLiteSelect },
};

const reportSummarySelect = {
    id: true,
    projectId: true,
    salesOrderId: true,
    appointmentId: true,
    reportDate: true,
    workDate: true,
    startedAt: true,
    overtimeMinutes: true,
    overtimeHourlyRate: true,
    overtimeCost: true,
    isSigned: true,
};

const expenseSummarySelect = {
    id: true,
    projectId: true,
    salesOrderId: true,
    appointmentId: true,
    expenseType: true,
    amount: true,
    expenseDate: true,
};

const extraMaterialSummarySelect = {
    id: true,
    projectId: true,
    salesOrderId: true,
    appointmentId: true,
    articleId: true,
    quantity: true,
    unitPrice: true,
    addedAt: true,
};

const appointmentSummarySelect = {
    id: true,
    tenantId: true,
    projectId: true,
    salesOrderId: true,
    assignedTechId: true,
    customerId: true,
    startTime: true,
    endTime: true,
    status: true,
    installationReminderSentAt: true,
};

// GET /projects is a table projection, not a project-detail response. Keep this
// contract deliberately small: every selected field is rendered by the project
// list (or is needed by one of the lightweight project pickers that shares the
// endpoint). In particular, never add sales-order/tender trees or technician
// assignments here; those belong to findById and the dedicated detail views.
const projectListSelect = {
    id: true,
    customerId: true,
    tenderId: true,
    managerId: true,
    projectNumber: true,
    projectName: true,
    status: true,
    plannedBudget: true,
    createdAt: true,
    customer: {
        select: {
            id: true,
            companyName: true,
        },
    },
    manager: {
        select: {
            id: true,
            firstName: true,
            lastName: true,
        },
    },
    tender: {
        select: {
            id: true,
            tenderNumber: true,
        },
    },
    appointments: {
        where: { status: "BOOKED" },
        orderBy: { startTime: "asc" as const },
        select: {
            id: true,
            startTime: true,
            status: true,
        },
    },
    _count: {
        select: {
            reports: true,
        },
    },
};

export class ProjectRepository {
    async createProject(data: Partial<Project>): Promise<Project> {
        return await prisma.$transaction(async (tx) => {
            // Proje kodunu (PR-2026-10001) BURADA üretiyoruz: her çağıranın
            // hatırlaması gereken bir alan olmaktan çıkıp tek bir boğazdan
            // geçiyor, böylece kodsuz proje oluşamıyor.
            const projectNumber = (data as any).projectNumber
                || await nextDocumentNumber((data as any).tenantId, 'PROJECT', tx);

            // Projenin ADI KODUDUR. Çağıran açıkça bir ad vermedikçe (kullanıcı
            // sonradan yeniden adlandırabilir) ad koda eşitlenir; teklif kodu
            // artık proje adına kopyalanmaz.
            const project = await tx.project.create({
                data: { ...(data as any), projectNumber, projectName: (data as any).projectName || projectNumber }
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
                            include: { article: { select: articleLiteSelect } },
                        },
                        positions: {
                            select: {
                                id: true,
                                positionNumber: true,
                                shortDescription: true,
                            }
                        }
                    }
                },
                salesOrders: {
                    orderBy: { createdAt: 'asc' },
                    include: {
                        customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true } },
                        parentSalesOrder: { select: { id: true, orderNumber: true } },
                        addonSalesOrders: { select: { id: true, orderNumber: true, revisionNumber: true, totalAmount: true, createdAt: true, orderDate: true } },
                        tender: {
                            select: {
                                id: true,
                                tenderNumber: true,
                                status: true,
                                projectId: true,
                                usedMaterials: {
                                    orderBy: { createdAt: 'desc' },
                                    include: { article: { select: articleLiteSelect } },
                                },
                                positions: {
                                    select: {
                                        id: true,
                                        positionNumber: true,
                                        shortDescription: true,
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
                        usedMaterials: { include: { article: true } },
                        images: { orderBy: { createdAt: 'asc' } }
                    }
                },
                projectVariations: {
                    orderBy: { createdAt: 'desc' },
                    include: { article: true }
                },
                extraMaterials: {
                    orderBy: { addedAt: 'desc' },
                    include: { article: true }
                }
            }
        }) as unknown as Project;
    }

    /**
     * Read model for the project-detail UI.
     *
     * The legacy findById method intentionally stays untouched because service,
     * mutation and PDF flows still consume its complete graph. This method is used
     * only when the UI supplies a `view` and avoids reading unrelated LONGTEXT
     * columns and relation trees (offer positions, report images/signatures and
     * material images) until the section that needs them is opened.
     */
    async findDetailById(id: string, tenantId: string, view: ProjectDetailView): Promise<Project | null> {
        const withAppointmentPeople = view === "details" || view === "planning" || view === "fieldReports" || view === "generalReport";
        const withReportDetails = [
            "fieldReports",
            "generalReport",
            "delivery",
            "signatures",
            "expenses",
            "materials",
            "overtime",
        ].includes(view);
        const withReportMaterials = view === "fieldReports" || view === "generalReport";
        const withReportAssets = view === "generalReport" || view === "delivery" || view === "signatures";
        // "expenses" is the read model behind the single costs tab: one table that
        // stacks external expenses, extra materials and extra work per order, plus
        // the tender-included material list underneath it.
        const withExpenseDetails = view === "fieldReports" || view === "generalReport" || view === "expenses";
        const withExtraMaterialDetails = view === "fieldReports" || view === "generalReport" || view === "materials" || view === "expenses";
        const withTenderMaterials = view === "planning" || view === "fieldReports" || view === "generalReport" || view === "materials" || view === "expenses";

        const reportSelect: any = withReportDetails
            ? {
                id: true,
                projectId: true,
                salesOrderId: true,
                appointmentId: true,
                employeeId: true,
                reportDate: true,
                reportType: true,
                workDate: true,
                startedAt: true,
                endedAt: true,
                workedMinutes: true,
                plannedMinutesForDay: true,
                overtimeMinutes: true,
                overtimeHourlyRate: true,
                overtimeCost: true,
                operationsDone: true,
                technicalNotes: true,
                isSigned: true,
                signedAt: true,
                hoursApprovedAt: true,
                hoursApprovedById: true,
                autoApproved: true,
                employee: { select: { id: true, firstName: true, lastName: true, email: true } },
                ...(withReportMaterials ? {
                    usedMaterials: {
                        select: {
                            id: true,
                            reportId: true,
                            articleId: true,
                            quantity: true,
                            costAtTime: true,
                            article: { select: { id: true, articleCode: true, name: true, baseCost: true, unit: true } },
                        },
                    },
                } : {}),
                ...(withReportAssets ? {
                    customerSignature: true,
                    // Zweite Signatur des Rapports (Techniker) — sie hängt an
                    // denselben schweren Ansichten wie die Kundensignatur.
                    technicianSignature: true,
                    technicianSignedAt: true,
                    images: {
                        orderBy: { createdAt: "asc" },
                        select: {
                            id: true,
                            reportId: true,
                            imageData: true,
                            caption: true,
                            uploadedById: true,
                            createdAt: true,
                        },
                    },
                } : {}),
            }
            : reportSummarySelect;

        const expenseSelect: any = withExpenseDetails
            ? { ...expenseSummarySelect, description: true }
            : expenseSummarySelect;
        const extraMaterialSelect: any = withExtraMaterialDetails
            ? {
                ...extraMaterialSummarySelect,
                description: true,
                article: { select: articleLiteSelect },
            }
            : extraMaterialSummarySelect;
        const appointmentSelect: any = withAppointmentPeople
            ? {
                ...appointmentSummarySelect,
                notes: true,
                isLocked: true,
                assignedTechnician: {
                    select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true },
                },
                technicianAssignments: {
                    orderBy: { assignedAt: "asc" },
                    select: {
                        id: true,
                        appointmentId: true,
                        technicianId: true,
                        assignedAt: true,
                        technician: {
                            select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true },
                        },
                    },
                },
            }
            : appointmentSummarySelect;
        const tenderSelect: any = {
            id: true,
            tenderNumber: true,
            status: true,
            projectId: true,
            // Kommissionsnummer — the project screen lists the commission of every
            // attached order, so it travels with each sales order's tender too
            // (this select is shared by both the project tender and the orders').
            commissionNumber: true,
            // Verkäufer for the billing tab's invoice fields: the tender's
            // salesperson, falling back to whoever created the tender.
            salespersonName: true,
            createdBy: { select: { firstName: true, lastName: true } },
            // Projektadresse (Montageadresse) — the overview prints it as the
            // very first line, above the customer/order row.
            installationAddress: true,
            ...(withTenderMaterials ? {
                usedMaterials: {
                    orderBy: { createdAt: "desc" },
                    select: tenderMaterialUsageSelect,
                },
            } : {}),
        };

        return await (prisma as any).project.findFirst({
            where: { id, tenantId },
            select: {
                id: true,
                tenantId: true,
                customerId: true,
                tenderId: true,
                managerId: true,
                projectNumber: true,
                projectName: true,
                status: true,
                plannedBudget: true,
                actualCost: true,
                overtimeHourlyRate: true,
                overtimeTolerancePercent: true,
                startDate: true,
                endDate: true,
                bookingToken: true,
                createdAt: true,
                updatedAt: true,
                customer: {
                    select: {
                        id: true,
                        companyName: true,
                        mainEmail: true,
                        mainPhone: true,
                        address: true,
                        language: true,
                    },
                },
                manager: { select: { id: true, firstName: true, lastName: true, email: true } },
                tender: { select: tenderSelect },
                salesOrders: {
                    orderBy: { createdAt: "asc" },
                    select: {
                        id: true,
                        tenantId: true,
                        customerId: true,
                        tenderId: true,
                        projectId: true,
                        parentSalesOrderId: true,
                        revisionNumber: true,
                        orderNumber: true,
                        orderType: true,
                        status: true,
                        totalAmount: true,
                        createdByEmployeeId: true,
                        createdAt: true,
                        updatedAt: true,
                        orderDate: true,
                        // Auftragsbestätigung: Einleitungstext und «Gültig bis»
                        // reisen mit, damit das Fenster der Auftragskarte ohne
                        // zweiten Abruf aufgeht (wie beim Verkäufertext).
                        confirmationNote: true,
                        confirmationValidUntil: true,
                        customer: {
                            select: {
                                id: true,
                                companyName: true,
                                mainEmail: true,
                                mainPhone: true,
                                address: true,
                                language: true,
                            },
                        },
                        parentSalesOrder: { select: { id: true, orderNumber: true } },
                        addonSalesOrders: {
                            select: {
                                id: true,
                                orderNumber: true,
                                revisionNumber: true,
                                totalAmount: true,
                                createdAt: true,
                                orderDate: true,
                            },
                        },
                        tender: { select: tenderSelect },
                        createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                    },
                },
                appointments: {
                    orderBy: { startTime: "asc" },
                    select: appointmentSelect,
                },
                reports: {
                    orderBy: { reportDate: "desc" },
                    select: reportSelect,
                },
                expenses: {
                    orderBy: { expenseDate: "desc" },
                    select: expenseSelect,
                },
                extraMaterials: {
                    orderBy: { addedAt: "desc" },
                    select: extraMaterialSelect,
                },
            },
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
        if (filter.customerId) where.customerId = filter.customerId;
        if (filter.search) {
            where.OR = [
                { projectNumber: { contains: filter.search } },
                { projectName: { contains: filter.search } },
                { customer: { companyName: { contains: filter.search } } },
                { tender: { tenderNumber: { contains: filter.search } } },
                { tender: { legacyNumber: { contains: filter.search } } }
            ];
        }
        
        return await (prisma as any).project.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            select: projectListSelect,
        }) as unknown as Project[];
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

    // Malzeme/ürün birleşmesi (2026-08-14): stok düşümü StockMovement/StockBalance
    // üzerinden yazılır (Article), skaler alan artırma/azaltma kalktı.
    async createExtraMaterial(data: any, employeeId: string, tenantId: string): Promise<any> {
        return await prisma.$transaction(async (tx) => {
            await adjustArticleStock(tx as any, {
                tenantId,
                articleId: data.articleId,
                employeeId,
                quantity: Number(data.quantity || 0),
                direction: 'OUT',
                referenceId: data.projectId,
                description: 'Zusatzmaterial',
            });
            const created = await (tx as any).projectExtraMaterial.create({
                data,
                include: { article: true }
            });
            // Eski istemci sözleşmesi: `material`/`materialId` adları korunur.
            return { ...created, materialId: created.articleId, material: created.article };
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
