"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectRepository = void 0;
const prisma_client_1 = __importDefault(require("../database/prisma.client"));
const documentNumber_1 = require("../../shared/documentNumber");
const articleStock_1 = require("../../shared/articleStock");
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
class ProjectRepository {
    async createProject(data) {
        return await prisma_client_1.default.$transaction(async (tx) => {
            // Proje kodunu (PR-2026-10001) BURADA üretiyoruz: her çağıranın
            // hatırlaması gereken bir alan olmaktan çıkıp tek bir boğazdan
            // geçiyor, böylece kodsuz proje oluşamıyor.
            const projectNumber = data.projectNumber
                || await (0, documentNumber_1.nextDocumentNumber)(data.tenantId, 'PROJECT', tx);
            // Projenin ADI KODUDUR. Çağıran açıkça bir ad vermedikçe (kullanıcı
            // sonradan yeniden adlandırabilir) ad koda eşitlenir; teklif kodu
            // artık proje adına kopyalanmaz.
            const project = await tx.project.create({
                data: { ...data, projectNumber, projectName: data.projectName || projectNumber }
            });
            if (data.tenderId) {
                await tx.tender.update({
                    where: { id: data.tenderId },
                    data: { projectId: project.id }
                });
            }
            return project;
        });
    }
    async updateProject(id, data) {
        return await prisma_client_1.default.project.update({
            where: { id },
            data: data
        });
    }
    async findById(id, tenantId) {
        return await prisma_client_1.default.project.findFirst({
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
        });
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
    async findDetailById(id, tenantId, view) {
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
        const reportSelect = withReportDetails
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
        const expenseSelect = withExpenseDetails
            ? { ...expenseSummarySelect, description: true }
            : expenseSummarySelect;
        const extraMaterialSelect = withExtraMaterialDetails
            ? {
                ...extraMaterialSummarySelect,
                description: true,
                article: { select: articleLiteSelect },
            }
            : extraMaterialSummarySelect;
        const appointmentSelect = withAppointmentPeople
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
        const tenderSelect = {
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
        return await prisma_client_1.default.project.findFirst({
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
        });
    }
    async findByToken(bookingToken) {
        return await prisma_client_1.default.project.findUnique({
            where: { bookingToken },
            include: {
                customer: true,
                tenant: true
            }
        });
    }
    async findAll(filter) {
        const where = { tenantId: filter.tenantId };
        if (filter.status)
            where.status = filter.status;
        if (filter.managerId)
            where.managerId = filter.managerId;
        if (filter.customerId)
            where.customerId = filter.customerId;
        if (filter.search) {
            where.OR = [
                { projectNumber: { contains: filter.search } },
                { projectName: { contains: filter.search } },
                { customer: { companyName: { contains: filter.search } } },
                { tender: { tenderNumber: { contains: filter.search } } },
                { tender: { legacyNumber: { contains: filter.search } } }
            ];
        }
        return await prisma_client_1.default.project.findMany({
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
                        orderDate: true,
                        parentSalesOrder: { select: { id: true, orderNumber: true } },
                        tender: { select: { id: true, tenderNumber: true, status: true, projectId: true, commissionNumber: true, salespersonName: true, createdBy: { select: { firstName: true, lastName: true } }, installationAddress: true } },
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
        });
    }
    // PDF 2.2.1: Canlı Maliyet (Actual Cost) Güncellemesi (Atomik Increment)
    async updateActualCost(id, additionalCost) {
        // Deprecated: current billing is calculated from offer budget, extra materials,
        // external expenses and daily overtime. Kept for legacy callers.
    }
    async addExpense(expense) {
        return await prisma_client_1.default.projectExpense.create({
            data: expense
        });
    }
    async createVariation(variationData) {
        return await prisma_client_1.default.projectVariation.create({
            data: variationData
        });
    }
    // Malzeme/ürün birleşmesi (2026-08-14): stok düşümü StockMovement/StockBalance
    // üzerinden yazılır (Article), skaler alan artırma/azaltma kalktı.
    async createExtraMaterial(data, employeeId, tenantId) {
        return await prisma_client_1.default.$transaction(async (tx) => {
            await (0, articleStock_1.adjustArticleStock)(tx, {
                tenantId,
                articleId: data.articleId,
                employeeId,
                quantity: Number(data.quantity || 0),
                direction: 'OUT',
                referenceId: data.projectId,
                description: 'Zusatzmaterial',
            });
            const created = await tx.projectExtraMaterial.create({
                data,
                include: { article: true }
            });
            // Eski istemci sözleşmesi: `material`/`materialId` adları korunur.
            return { ...created, materialId: created.articleId, material: created.article };
        });
    }
    async findVariationById(variationId) {
        return await prisma_client_1.default.projectVariation.findUnique({
            where: { id: variationId }
        });
    }
    async updateVariationStatus(variationId, status, resolverId) {
        return await prisma_client_1.default.projectVariation.update({
            where: { id: variationId },
            data: {
                status,
                resolvedById: resolverId,
                resolvedAt: new Date()
            }
        });
    }
    async getPendingVariations(projectId) {
        return await prisma_client_1.default.projectVariation.findMany({
            where: {
                projectId: projectId,
                status: 'PENDING'
            }
        });
    }
    async createPhase(phaseData) {
        return await prisma_client_1.default.projectPhase.create({
            data: phaseData
        });
    }
    async updatePhaseProgress(phaseId, progress) {
        return await prisma_client_1.default.projectPhase.update({
            where: { id: phaseId },
            data: { progressPercentage: progress }
        });
    }
    async getPhasesByProjectId(projectId) {
        return await prisma_client_1.default.projectPhase.findMany({
            where: { projectId: projectId }
        });
    }
    async getExpensesByProjectId(projectId) {
        return await prisma_client_1.default.projectExpense.findMany({
            where: { projectId: projectId }
        });
    }
}
exports.ProjectRepository = ProjectRepository;
//# sourceMappingURL=ProjectRepository.js.map