"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectController = void 0;
const client_1 = require("@prisma/client");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const projectEventNotifications_1 = require("../../infrastructure/services/projectEventNotifications");
const articleStock_1 = require("../../shared/articleStock");
const SmtpMailService_1 = require("../../infrastructure/services/SmtpMailService");
const MailDispatchService_1 = require("../../infrastructure/services/outlook/MailDispatchService");
const calendarMailService_1 = require("../../infrastructure/services/calendarMailService");
const LocalFileStorage_1 = require("../../infrastructure/services/LocalFileStorage");
const serviceTenantScope_1 = require("./serviceTenantScope");
const calendarLabelCatalog_1 = require("../../application/services/calendarLabelCatalog");
const technicianSchedule_1 = require("./technicianSchedule");
const appointmentSeries_1 = require("./appointmentSeries");
const nanoid_1 = require("nanoid");
const documentNumber_1 = require("../../shared/documentNumber");
const smtp = new SmtpMailService_1.SmtpMailService();
/**
 * DIE ADRESSE, DIE DER BROWSER BEKOMMT (01.09.2026).
 *
 * Der Verweis in der Zeile ist eine Ablage-Adresse, nie die des Browsers —
 * `displayUrl()` entscheidet, welcher Name hinausgeht. Zwei sind daran
 * gescheitert: `pub-*.r2.dev` und der presignte S3-Endpunkt
 * `*.r2.cloudflarestorage.com`. Beide kommen im Netz der Benutzerin nicht an;
 * Name, Groesse und «2/4» standen da, das Blatt blieb weiss. Es geht die
 * eigene Domain am Eimer hinaus (`assets.demo.offitec.ch`, R2_PUBLIC_URL).
 *
 * `downloadName` bleibt weg: damit setzt R2 `Content-Disposition: attachment`,
 * und ein Rahmen, der herunterlaedt statt anzuzeigen, ist wieder weiss.
 */
const appointmentDocumentDto = async (document) => {
    const { fileRef, ...metadata } = document;
    const url = await LocalFileStorage_1.appointmentDocumentStorage.displayUrl(String(fileRef || ''), {
        contentType: document?.contentType || undefined,
    });
    if (!url) {
        throw Object.assign(new Error('Belge deposu yapılandırılmamış; belge için URL oluşturulamadı.'), { status: 503 });
    }
    return { ...metadata, url };
};
/**
 * DER AUFTRAG IST WEG → DIE OFFERTE IST WIEDER EIN ENTWURF (Benutzerregel
 * 29.08.2026: «wird das Projekt gelöscht, verschwindet es aus den Aufträgen und
 * wird wieder ein Entwurf»).
 *
 * `createFromTender` stempelt beim Eröffnen DREI Dinge auf die Offerte —
 * `status: 'Approved'`, `sourceStatus: 'Verkaufsauftrag'` und `projectId` —,
 * und genau diese drei werden hier zurückgenommen. Alle drei müssen weg:
 *
 *  • `status` sperrt die Offerte gegen jede Bearbeitung (überall im
 *    TenderController steht `if (tender.status !== 'Draft')`), sie wäre also
 *    unbrauchbar und trotzdem auftragslos.
 *  • `projectId` UND `sourceStatus` entscheiden zusammen, in welchem Topf die
 *    Offertliste die Zeile zeigt (`TenderRepository.buildLeanWhere`:
 *    `orderState = 'draft'` verlangt `projectId IS NULL` UND einen
 *    sourceStatus ausserhalb von ORDER_SOURCE_VALUES). Bliebe eines von
 *    beiden stehen, stünde die Offerte weiter unter «Auftrag» — bei einem
 *    Auftrag, den es nicht mehr gibt.
 *
 * `Tender.projectId` ist übrigens KEIN Fremdschlüssel (die Beziehung hängt an
 * `Project.tenderId`), das Löschen des Projekts räumt die Spalte also NICHT
 * von selbst auf — sie zeigt danach auf eine Zeile, die es nicht mehr gibt.
 */
const revertTendersToDraft = async (tx, tenantId, employeeId, tenderIds, description) => {
    const ids = [...new Set(tenderIds.filter(Boolean))];
    if (!ids.length)
        return;
    // Die alten Zustände für das Protokoll — vor dem Überschreiben gelesen.
    const before = await tx.tender.findMany({
        where: { id: { in: ids }, tenantId },
        select: { id: true, status: true },
    });
    if (!before.length)
        return;
    await tx.tender.updateMany({
        where: { id: { in: before.map((row) => row.id) }, tenantId },
        data: { status: 'Draft', sourceStatus: null, projectId: null },
    });
    // Die Offerte darf nicht stillschweigend zurückfallen: ihr Verlauf trägt
    // die Eröffnung des Auftrags, also auch dessen Rücknahme.
    await tx.tenderActivityLog.createMany({
        data: before.map((row) => ({
            id: (0, nanoid_1.nanoid)(12),
            tenantId,
            tenderId: row.id,
            employeeId,
            actionType: 'SALES_ORDER_DELETED',
            fieldName: 'status',
            oldValue: row.status,
            newValue: 'Draft',
            description,
        })),
    });
};
const startOfDay = (date) => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
};
const endOfDay = (date) => {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
};
const normalizeIdList = (value) => Array.isArray(value)
    ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))]
    : [];
class ProjectController {
    createProjectUseCase;
    addReportUseCase;
    requestVariationUseCase;
    approveVariationUseCase;
    addExpenseUseCase;
    projectRepository;
    reportRepository;
    constructor(createProjectUseCase, addReportUseCase, requestVariationUseCase, approveVariationUseCase, addExpenseUseCase, projectRepository, reportRepository) {
        this.createProjectUseCase = createProjectUseCase;
        this.addReportUseCase = addReportUseCase;
        this.requestVariationUseCase = requestVariationUseCase;
        this.approveVariationUseCase = approveVariationUseCase;
        this.addExpenseUseCase = addExpenseUseCase;
        this.projectRepository = projectRepository;
        this.reportRepository = reportRepository;
    }
    async resolveProjectSalesOrderId(projectId, tenantId, rawSalesOrderId) {
        const salesOrderId = String(rawSalesOrderId || '').trim();
        if (!salesOrderId)
            return null;
        const salesOrder = await prisma_client_1.default.salesOrder.findFirst({
            where: { id: salesOrderId, projectId, tenantId },
            select: { id: true },
        });
        if (!salesOrder)
            throw new Error("Sipariş bu projeye ait değil.");
        return salesOrder.id;
    }
    async notify(input) {
        await prisma_client_1.default.notification.create({
            data: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId: input.tenantId,
                recipientEmployeeId: input.recipientEmployeeId || null,
                type: input.type,
                title: input.title,
                message: input.message,
                linkUrl: input.linkUrl || null,
                metadata: input.metadata,
            },
        });
    }
    async notifyMany(tenantId, recipientEmployeeIds, payload) {
        for (const recipientEmployeeId of [...new Set(recipientEmployeeIds.filter(Boolean))]) {
            await this.notify({ tenantId, recipientEmployeeId, ...payload });
        }
    }
    async validateProjectTechnician(technicianId, tenantId) {
        const id = String(technicianId || "").trim();
        if (!id)
            return null;
        // Personnel belong to the SELECTED company -> a sister company's
        // technicians are not assignable here.
        const tenantIds = await (0, serviceTenantScope_1.getPersonnelTenantScope)(tenantId);
        const employee = await prisma_client_1.default.employee.findFirst({
            where: {
                id,
                ...(0, serviceTenantScope_1.employeeScopeWhere)(tenantIds),
                isActive: true,
                OR: [
                    { roleName: "Teknisyen" },
                    { employeeRoles: { some: { role: { roleName: "Teknisyen" } } } },
                ],
            },
            select: {
                id: true,
                tenantId: true,
                firstName: true,
                lastName: true,
                email: true,
                phone: true,
                roleName: true,
                title: true,
                employeeRoles: {
                    select: { role: { select: { roleName: true } } },
                },
            },
        });
        if (!employee)
            throw new Error("Seçilen teknisyen bulunamadı.");
        return employee;
    }
    async validateProjectTechnicians(technicianIds, tenantId) {
        return (0, technicianSchedule_1.validateTechnicians)(technicianIds, tenantId);
    }
    async projectManagerRecipients(project) {
        const ids = [project.managerId].filter(Boolean);
        if (ids.length)
            return ids;
        const managers = await prisma_client_1.default.employee.findMany({
            where: {
                tenantId: project.tenantId,
                isActive: true,
                employeeRoles: {
                    some: {
                        role: {
                            permissions: {
                                some: { permission: { permissionName: "projects.manage" } },
                            },
                        },
                    },
                },
            },
            take: 20,
            select: { id: true },
        });
        return managers.map((employee) => employee.id);
    }
    async notifyProjectManagers(project, payload) {
        const recipientIds = await this.projectManagerRecipients(project);
        if (recipientIds.length) {
            await this.notifyMany(project.tenantId, recipientIds, payload);
        }
        else {
            await this.notify({ tenantId: project.tenantId, ...payload });
        }
    }
    // The business date an addon order should carry: the original appointment date the
    // billed extra work belongs to. Extra-work rows (expenses/materials/reports) carry
    // an appointmentId, so we take the latest such appointment's startTime — even when
    // the entry itself was made days later. Falls back to the rows' own dates, then now.
    async resolveAddonOrderDate(tenantId, slice) {
        const appointmentIds = Array.from(new Set([...(slice.expenses || []), ...(slice.extraMaterials || []), ...(slice.reports || [])]
            .map((row) => row?.appointmentId)
            .filter((id) => Boolean(id))));
        if (appointmentIds.length) {
            const appointments = await prisma_client_1.default.appointment.findMany({
                where: { id: { in: appointmentIds }, tenantId },
                select: { startTime: true },
            });
            const times = appointments
                .map((appointment) => new Date(appointment.startTime).getTime())
                .filter((time) => !Number.isNaN(time));
            if (times.length)
                return new Date(Math.max(...times));
        }
        // No appointment link (legacy rows): use the most recent row date in the slice.
        const rowTimes = [
            ...(slice.reports || []).map((row) => row?.workDate || row?.reportDate),
            ...(slice.expenses || []).map((row) => row?.expenseDate),
            ...(slice.extraMaterials || []).map((row) => row?.addedAt),
        ]
            .map((value) => (value ? new Date(value).getTime() : NaN))
            .filter((time) => !Number.isNaN(time));
        return rowTimes.length ? new Date(Math.max(...rowTimes)) : new Date();
    }
    async createAddonOrderForParent(project, parentSalesOrderId, employeeId, orderDate) {
        const tenantId = project.tenantId;
        const parentOrder = await prisma_client_1.default.salesOrder.findFirst({ where: { id: parentSalesOrderId, projectId: project.id, tenantId } });
        if (!parentOrder)
            return null;
        const addons = await prisma_client_1.default.salesOrder.findMany({
            where: { parentSalesOrderId, projectId: project.id, tenantId },
            orderBy: [{ revisionNumber: "desc" }, { createdAt: "desc" }],
        });
        const previousAddon = addons[0] || null;
        const nextRevision = Math.max(0, ...addons.map((order) => Number(order.revisionNumber || 0))) + 1;
        const createdAtFilter = previousAddon?.createdAt ? { gt: previousAddon.createdAt } : undefined;
        const [expenses, extraMaterials, reports] = await Promise.all([
            prisma_client_1.default.projectExpense.findMany({
                where: {
                    projectId: project.id,
                    salesOrderId: parentSalesOrderId,
                    ...(createdAtFilter ? { expenseDate: createdAtFilter } : {}),
                },
            }),
            prisma_client_1.default.projectExtraMaterial.findMany({
                where: {
                    projectId: project.id,
                    salesOrderId: parentSalesOrderId,
                    ...(createdAtFilter ? { addedAt: createdAtFilter } : {}),
                },
            }),
            prisma_client_1.default.projectReport.findMany({
                where: {
                    projectId: project.id,
                    salesOrderId: parentSalesOrderId,
                    ...(createdAtFilter ? { reportDate: createdAtFilter } : {}),
                },
            }),
        ]);
        const expenseTotal = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
        const materialTotal = extraMaterials.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
        const overtimeTotal = reports.reduce((sum, item) => sum + Number(item.overtimeCost || 0), 0);
        const totalAmount = expenseTotal + materialTotal + overtimeTotal;
        if (totalAmount <= 0)
            return null;
        // Date the addon to the appointment the extra work belongs to (never the
        // possibly-later entry time). createdAt still bounds the next slice.
        const resolvedOrderDate = orderDate ?? await this.resolveAddonOrderDate(tenantId, { expenses, extraMaterials, reports });
        // Ek sipariş (Nachtrag) kodu artık üst siparişten TÜRETİLMEZ (eskiden
        // "<üst kod>-N1"); kendi NT- serisinden gelir. Üst siparişe bağ
        // `parentSalesOrderId`, kaçıncı ek olduğu `revisionNumber` ile durur.
        //
        // Süpürülen kayıtlar EK SİPARİŞİN ÜZERİNE DAMGALANIR (kullanıcı isteği
        // 2026-08-07): maliyet/malzeme listeleri artık ek siparişe göre gruplar
        // ve iptal, kayıtlarını doğrudan bulur. Zaman-penceresi çıkarımı yalnızca
        // bu değişiklikten ÖNCE oluşturulmuş ekler için (okuma tarafında) yaşar.
        // Damga da süpürme havuzunu boşaltır: üst siparişte damgası kalan kayıt =
        // henüz faturalanmamış iş.
        const addonOrder = await prisma_client_1.default.$transaction(async (tx) => {
            const orderNumber = await (0, documentNumber_1.nextDocumentNumber)(tenantId, 'ADDON', tx);
            const created = await tx.salesOrder.create({
                data: {
                    id: (0, nanoid_1.nanoid)(10),
                    tenantId,
                    customerId: parentOrder.customerId || project.customerId,
                    tenderId: null,
                    projectId: project.id,
                    parentSalesOrderId,
                    revisionNumber: nextRevision,
                    orderNumber,
                    orderType: "PROJECT_ADDON",
                    status: "ORDERED",
                    totalAmount,
                    orderDate: resolvedOrderDate,
                    createdByEmployeeId: employeeId,
                },
                include: {
                    customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true } },
                    tender: { select: { id: true, tenderNumber: true, status: true, projectId: true } },
                    createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                },
            });
            const stamp = { salesOrderId: created.id };
            if (expenses.length) {
                await tx.projectExpense.updateMany({ where: { id: { in: expenses.map((row) => row.id) } }, data: stamp });
            }
            if (extraMaterials.length) {
                await tx.projectExtraMaterial.updateMany({ where: { id: { in: extraMaterials.map((row) => row.id) } }, data: stamp });
            }
            if (reports.length) {
                await tx.projectReport.updateMany({ where: { id: { in: reports.map((row) => row.id) } }, data: stamp });
            }
            return created;
        });
        return {
            salesOrder: addonOrder,
            totals: { expenses: expenseTotal, extraMaterials: materialTotal, overtime: overtimeTotal, total: totalAmount },
        };
    }
    // Pending extra work accrued on `parentSalesOrderId` since its last addon —
    // the same slice createAddonOrderForParent would bill. Shared by the addon
    // request flow so the manager sees the totals a technician is flagging.
    async computePendingAddonTotals(project, parentSalesOrderId) {
        const tenantId = project.tenantId;
        const addons = await prisma_client_1.default.salesOrder.findMany({
            where: { parentSalesOrderId, projectId: project.id, tenantId },
            orderBy: [{ revisionNumber: "desc" }, { createdAt: "desc" }],
        });
        const previousAddon = addons[0] || null;
        const createdAtFilter = previousAddon?.createdAt ? { gt: previousAddon.createdAt } : undefined;
        const [expenses, extraMaterials, reports] = await Promise.all([
            prisma_client_1.default.projectExpense.findMany({
                where: { projectId: project.id, salesOrderId: parentSalesOrderId, ...(createdAtFilter ? { expenseDate: createdAtFilter } : {}) },
            }),
            prisma_client_1.default.projectExtraMaterial.findMany({
                where: { projectId: project.id, salesOrderId: parentSalesOrderId, ...(createdAtFilter ? { addedAt: createdAtFilter } : {}) },
            }),
            prisma_client_1.default.projectReport.findMany({
                where: { projectId: project.id, salesOrderId: parentSalesOrderId, ...(createdAtFilter ? { reportDate: createdAtFilter } : {}) },
            }),
        ]);
        const expenseTotal = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
        const materialTotal = extraMaterials.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
        const overtimeTotal = reports.reduce((sum, item) => sum + Number(item.overtimeCost || 0), 0);
        return { expenseTotal, materialTotal, overtimeTotal, total: expenseTotal + materialTotal + overtimeTotal };
    }
    // Records (or refreshes) a PENDING addon-order request for the parent order and
    // notifies the project managers. Returns null when there is nothing to bill.
    async createAddonRequestForParent(project, parentSalesOrderId, requesterId, appointmentId, note) {
        const totals = await this.computePendingAddonTotals(project, parentSalesOrderId);
        if (totals.total <= 0)
            return null;
        const requester = await prisma_client_1.default.employee.findUnique({ where: { id: requesterId }, select: { firstName: true, lastName: true } });
        const requestedByName = [requester?.firstName, requester?.lastName].filter(Boolean).join(" ").trim() || null;
        const existing = await prisma_client_1.default.projectAddonRequest.findFirst({
            where: { projectId: project.id, tenantId: project.tenantId, salesOrderId: parentSalesOrderId, status: "PENDING" },
        });
        const data = {
            salesOrderId: parentSalesOrderId,
            appointmentId: appointmentId || null,
            requestedById: requesterId,
            requestedByName,
            note: note ? String(note).trim() : null,
            expenseTotal: totals.expenseTotal,
            materialTotal: totals.materialTotal,
            overtimeTotal: totals.overtimeTotal,
            total: totals.total,
        };
        // One open request per parent order: refresh the existing one instead of
        // stacking duplicates each time a technician finishes another montaj.
        const request = existing
            ? await prisma_client_1.default.projectAddonRequest.update({ where: { id: existing.id }, data: { ...data, createdAt: new Date() } })
            : await prisma_client_1.default.projectAddonRequest.create({ data: { id: (0, nanoid_1.nanoid)(12), tenantId: project.tenantId, projectId: project.id, ...data } });
        await this.notifyProjectManagers(project, {
            type: "PROJECT_ADDON_ORDER_REQUESTED",
            title: "Ek sipariş talebi",
            message: `${requestedByName || "Teknisyen"}, ${project.projectName} projesi için ek sipariş talep etti.`,
            linkUrl: `/projects/${project.id}`,
            metadata: { projectId: project.id, salesOrderId: parentSalesOrderId, addonRequestId: request.id, total: totals.total },
        });
        return { request, totals };
    }
    async list(req, res) {
        try {
            const tenantId = req.user.tenantId;
            // `view=picker` — seçim pencereleri için yalın liste: proje + sipariş
            // başlıkları, rapor/malzeme ağaçları olmadan (takvim sihirbazı kullanır).
            if (req.query.view === "picker") {
                const where = { tenantId };
                if (req.query.customerId)
                    where.customerId = String(req.query.customerId);
                // Seçim kutusu yalnızca ilk birkaç satırı ister (take=7); "tümünü
                // gör" penceresi take olmadan tam listeyi çeker.
                const take = Math.min(100, Math.max(0, Number(req.query.take) || 0));
                const projects = await prisma_client_1.default.project.findMany({
                    where,
                    ...(take ? { take } : {}),
                    orderBy: { createdAt: "desc" },
                    select: {
                        id: true,
                        projectName: true,
                        status: true,
                        customerId: true,
                        customer: { select: { id: true, companyName: true } },
                        salesOrders: {
                            orderBy: { createdAt: "asc" },
                            select: { id: true, orderNumber: true, status: true, orderType: true, parentSalesOrderId: true, totalAmount: true },
                        },
                    },
                });
                return res.status(200).json(projects);
            }
            const filter = { tenantId };
            if (req.query.status)
                filter.status = req.query.status;
            if (req.query.managerId)
                filter.managerId = req.query.managerId;
            if (req.query.customerId)
                filter.customerId = req.query.customerId;
            if (req.query.search)
                filter.search = req.query.search;
            const projects = await this.projectRepository.findAll(filter);
            res.status(200).json(projects);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async listTechnicians(req, res) {
        try {
            res.status(200).json(await (0, technicianSchedule_1.listTechnicianOptions)(req.user.tenantId));
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    tenderMaterialInclude() {
        return {
            select: {
                id: true,
                tenderNumber: true,
                status: true,
                projectId: true,
                // Malzeme/ürün birleşmesi (2026-08-14): satırlar Article'a bağlı;
                // istemci `article`/`articleId` okur (eski `material` alanı kalktı).
                // Pozisyon malzeme eşlemeleri (PositionMaterialMapping) tabloyla
                // birlikte kaldırıldı — malzeme listesi yalnızca usedMaterials'tır.
                usedMaterials: {
                    orderBy: { createdAt: "desc" },
                    select: {
                        id: true,
                        articleId: true,
                        quantity: true,
                        unitCost: true,
                        description: true,
                        article: {
                            select: { id: true, articleCode: true, name: true, salePrice: true },
                        },
                    },
                },
                positions: {
                    select: {
                        id: true,
                        positionNumber: true,
                        shortDescription: true,
                    },
                },
            },
        };
    }
    projectInstallationInclude() {
        return {
            assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } },
            technicianAssignments: { orderBy: { assignedAt: "asc" }, include: { technician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } } } },
            salesOrder: { select: { id: true, orderNumber: true, totalAmount: true, parentSalesOrderId: true, revisionNumber: true, tenderId: true, tender: this.tenderMaterialInclude() } },
            // `select`, not `include`: the installation screens read the project
            // only for its name, customer, offer, reports, expenses and extra
            // materials. A bare `include` also ships every project scalar
            // (bookingToken, plannedBudget, overtime settings, tenant/manager ids,
            // dates) plus the manager join — none of which is rendered here.
            project: {
                select: {
                    id: true,
                    projectName: true,
                    customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true, address: true } },
                    tender: this.tenderMaterialInclude(),
                    salesOrders: {
                        orderBy: { createdAt: "asc" },
                        select: { id: true, orderNumber: true, totalAmount: true, parentSalesOrderId: true, revisionNumber: true, createdAt: true, orderDate: true },
                    },
                    reports: {
                        orderBy: { reportDate: "desc" },
                        include: {
                            employee: { select: { id: true, firstName: true, lastName: true, email: true } },
                            images: { orderBy: { createdAt: "asc" } },
                        },
                    },
                    expenses: { orderBy: { expenseDate: "desc" } },
                    extraMaterials: {
                        orderBy: { addedAt: "desc" },
                        include: { article: { select: { id: true, articleCode: true, name: true, salePrice: true } } },
                    },
                },
            },
        };
    }
    /**
     * Calendar grid projection in ONE database round-trip.
     *
     * Prisma's relation include loads the appointment, primary technician,
     * assignments, order, project and customer as separate relation reads. On
     * the remote database that turns a tiny response into several network
     * round-trips. The grid needs only these labels and ids; notes, CC/iCal,
     * reminders, series metadata and popup contact data are fetched lazily by
     * getAppointmentDetail when a calendar block is opened.
     */
    async listCalendarAppointments(tenantId, start, end, technicianId) {
        const technicianScope = technicianId
            ? client_1.Prisma.sql `AND (
                a.assignedTechId = ${technicianId}
                OR EXISTS (
                    SELECT 1
                    FROM ProjectAppointmentAssignment ownAssignment
                    WHERE ownAssignment.appointmentId = a.id
                      AND ownAssignment.technicianId = ${technicianId}
                )
            )`
            : client_1.Prisma.sql ``;
        const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
            SELECT
                a.id,
                a.projectId,
                a.salesOrderId,
                a.assignedTechId,
                a.startTime,
                a.endTime,
                a.status,
                a.labelId,
                primaryTech.id AS primaryTechId,
                primaryTech.firstName AS primaryFirstName,
                primaryTech.lastName AS primaryLastName,
                assignment.technicianId AS assignmentTechId,
                assignmentTech.firstName AS assignmentFirstName,
                assignmentTech.lastName AS assignmentLastName,
                salesOrder.id AS orderId,
                salesOrder.orderNumber,
                project.id AS joinedProjectId,
                customer.id AS customerId,
                customer.companyName
            FROM Appointment a
            LEFT JOIN Employee primaryTech ON primaryTech.id = a.assignedTechId
            LEFT JOIN ProjectAppointmentAssignment assignment ON assignment.appointmentId = a.id
            LEFT JOIN Employee assignmentTech ON assignmentTech.id = assignment.technicianId
            LEFT JOIN SalesOrder salesOrder ON salesOrder.id = a.salesOrderId
            LEFT JOIN Project project ON project.id = a.projectId
            LEFT JOIN Customer customer ON customer.id = project.customerId
            WHERE a.tenantId = ${tenantId}
              AND a.projectId IS NOT NULL
              AND a.status IN ('BOOKED', 'COMPLETED')
              AND a.startTime >= ${start}
              AND a.endTime <= ${end}
              ${technicianScope}
            ORDER BY a.startTime ASC, assignment.assignedAt ASC
        `);
        const byId = new Map();
        for (const row of rows) {
            let appointment = byId.get(row.id);
            if (!appointment) {
                appointment = {
                    id: row.id,
                    projectId: row.projectId,
                    salesOrderId: row.salesOrderId,
                    assignedTechId: row.assignedTechId,
                    startTime: row.startTime,
                    endTime: row.endTime,
                    status: row.status,
                    labelId: row.labelId,
                    assignedTechnician: row.primaryTechId
                        ? { id: row.primaryTechId, firstName: row.primaryFirstName, lastName: row.primaryLastName }
                        : null,
                    technicianAssignments: [],
                    salesOrder: row.orderId
                        ? { id: row.orderId, orderNumber: row.orderNumber }
                        : null,
                    project: row.joinedProjectId
                        ? {
                            id: row.joinedProjectId,
                            customer: row.customerId
                                ? { id: row.customerId, companyName: row.companyName }
                                : null,
                        }
                        : null,
                };
                byId.set(row.id, appointment);
            }
            if (row.assignmentTechId) {
                appointment.technicianAssignments.push({
                    technician: {
                        id: row.assignmentTechId,
                        firstName: row.assignmentFirstName,
                        lastName: row.assignmentLastName,
                    },
                });
            }
        }
        return Array.from(byId.values());
    }
    // Single-appointment include for the calendar detail popup: customer contacts,
    // participants with contact details, order/tender numbers and the manager —
    // everything the popup shows, and nothing more (still no material/report trees).
    projectCalendarDetailInclude() {
        return {
            assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } },
            technicianAssignments: {
                orderBy: { assignedAt: "asc" },
                include: { technician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } } },
            },
            salesOrder: { select: { id: true, orderNumber: true, totalAmount: true, tender: { select: { id: true, tenderNumber: true } } } },
            project: {
                select: {
                    id: true,
                    projectName: true,
                    customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true, address: true } },
                    manager: { select: { id: true, firstName: true, lastName: true, email: true } },
                    tender: { select: { id: true, tenderNumber: true } },
                },
            },
        };
    }
    // Technician appointment pop-up: exactly the contact and assignment fields
    // rendered by AppointmentSheet. Order totals, tenders, managers, report
    // trees and image blobs belong to their own screens and are not loaded here.
    projectTechnicianPopupSelect() {
        return {
            id: true,
            projectId: true,
            salesOrderId: true,
            assignedTechId: true,
            startTime: true,
            endTime: true,
            status: true,
            notes: true,
            ccEmails: true,
            assignedTechnician: {
                select: { id: true, firstName: true, lastName: true },
            },
            technicianAssignments: {
                orderBy: { assignedAt: "asc" },
                select: {
                    technicianId: true,
                    technician: { select: { id: true, firstName: true, lastName: true } },
                },
            },
            project: {
                select: {
                    id: true,
                    projectName: true,
                    customer: {
                        select: { id: true, companyName: true, mainPhone: true, address: true },
                    },
                },
            },
        };
    }
    // Fast initial payload for the technician work screen. The expensive tender
    // tree, expenses and catalogue are intentionally loaded by their own tabs.
    projectInstallationWorkSelect(appointmentId) {
        return {
            id: true,
            tenantId: true,
            projectId: true,
            salesOrderId: true,
            assignedTechId: true,
            customerId: true,
            startTime: true,
            endTime: true,
            status: true,
            notes: true,
            isLocked: true,
            assignedTechnician: {
                select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true },
            },
            technicianAssignments: {
                orderBy: { assignedAt: "asc" },
                select: {
                    technicianId: true,
                    technician: {
                        select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true },
                    },
                },
            },
            salesOrder: {
                select: { id: true, orderNumber: true, parentSalesOrderId: true, revisionNumber: true },
            },
            project: {
                select: {
                    id: true,
                    projectName: true,
                    overtimeHourlyRate: true,
                    overtimeTolerancePercent: true,
                    customer: {
                        select: { id: true, companyName: true, mainEmail: true, mainPhone: true, address: true },
                    },
                    salesOrders: {
                        orderBy: { createdAt: "asc" },
                        select: { id: true, orderNumber: true },
                    },
                    reports: {
                        where: { appointmentId },
                        orderBy: { reportDate: "desc" },
                        select: {
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
                            employee: {
                                select: { id: true, firstName: true, lastName: true, email: true },
                            },
                            // Der vereinheitlichte Rapport-Editor listet auch das
                            // verwendete Material und speichert die Liste als
                            // vollständigen Ersatz — ohne diese Zeilen würde eine
                            // Montage-Speicherung sie löschen.
                            usedMaterials: {
                                select: {
                                    id: true,
                                    articleId: true,
                                    quantity: true,
                                    costAtTime: true,
                                    article: { select: { id: true, name: true } },
                                },
                            },
                            images: {
                                orderBy: { createdAt: "asc" },
                                select: { id: true, imageData: true, caption: true, createdAt: true },
                            },
                        },
                    },
                },
            },
        };
    }
    projectInstallationExpenseSelect() {
        return {
            id: true,
            expenses: {
                orderBy: { expenseDate: "desc" },
                select: {
                    id: true,
                    expenseType: true,
                    amount: true,
                    description: true,
                    expenseDate: true,
                    appointmentId: true,
                    salesOrderId: true,
                },
            },
        };
    }
    projectInstallationMaterialSelect() {
        return {
            id: true,
            salesOrder: {
                select: {
                    id: true,
                    orderNumber: true,
                    parentSalesOrderId: true,
                    revisionNumber: true,
                    tenderId: true,
                    tender: this.tenderMaterialInclude(),
                },
            },
            project: {
                select: {
                    id: true,
                    projectName: true,
                    tender: this.tenderMaterialInclude(),
                },
            },
            extraMaterials: {
                orderBy: { addedAt: "desc" },
                select: {
                    id: true,
                    articleId: true,
                    quantity: true,
                    unitPrice: true,
                    description: true,
                    addedAt: true,
                    appointmentId: true,
                    salesOrderId: true,
                    article: {
                        select: {
                            id: true,
                            articleCode: true,
                            name: true,
                            salePrice: true,
                        },
                    },
                },
            },
        };
    }
    // Teknisyen montaj listesi için asgari yük: tablo satırı (sipariş no, müşteri,
    // proje, tarih) + durum türetimi (rapor imzalı mı — findReport eşleşmesi için
    // gereken skaler alanlar). projectInstallationInclude'un taşıdığı rapor
    // GÖRSELLERİ / müşteri imzası (base64 LongText'ler), malzeme ağaçları,
    // giderler burada bilerek yok — liste saniyeler yerine milisaniyede dönsün.
    projectMontageListInclude() {
        return {
            salesOrder: { select: { id: true, orderNumber: true } },
            project: {
                select: {
                    id: true,
                    projectName: true,
                    customer: { select: { id: true, companyName: true } },
                    salesOrders: {
                        orderBy: { createdAt: "asc" },
                        select: { id: true, orderNumber: true },
                    },
                    reports: {
                        select: {
                            id: true,
                            isSigned: true,
                            appointmentId: true,
                            salesOrderId: true,
                            workDate: true,
                            reportDate: true,
                            startedAt: true,
                        },
                    },
                },
            },
        };
    }
    async listMyInstallations(req, res) {
        try {
            const now = new Date();
            const rawStart = req.query.start ? new Date(String(req.query.start)) : new Date(now.getFullYear(), now.getMonth(), 1);
            const rawEnd = req.query.end ? new Date(String(req.query.end)) : new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999);
            if (Number.isNaN(rawStart.getTime()) || Number.isNaN(rawEnd.getTime())) {
                return res.status(400).json({ error: "Geçerli tarih aralığı girin." });
            }
            // Date-only params (e.g. "2026-06-17") parse to midnight; widen to cover
            // the full first/last day so single-day (day view) ranges are not empty.
            const start = startOfDay(rawStart);
            const end = endOfDay(rawEnd);
            // Montaj tabloları SUNUCUDA sayfalanır ve yalnızca tablo kolonlarını
            // alır: satır başına düz bir DTO döner (sipariş no, müşteri, proje,
            // saatler, imza durumu). Pop-up/iş ekranı verileri burada YOK — onlar
            // açıldıkları anda kendi detay uçlarından yüklenir.
            if (String(req.query.view || "") === "montage-page") {
                return this.listMontageOrdersPage(req, res, start, end);
            }
            if (String(req.query.view || "") === "calendar") {
                const appointments = await this.listCalendarAppointments(req.user.tenantId, start, end, req.user.id);
                return res.status(200).json(appointments);
            }
            const appointments = await prisma_client_1.default.appointment.findMany({
                where: {
                    tenantId: req.user.tenantId,
                    OR: [
                        { assignedTechId: req.user.id },
                        { technicianAssignments: { some: { technicianId: req.user.id } } },
                    ],
                    projectId: { not: null },
                    status: { in: ["BOOKED", "COMPLETED"] },
                    startTime: { gte: start },
                    endTime: { lte: end },
                },
                orderBy: { startTime: "asc" },
                // The calendar asks for the trimmed grid include, the montage list
                // for the row-only include; the installation screens (which derive
                // their detail from this list) keep the full one.
                include: String(req.query.view || "") === "montage"
                    ? this.projectMontageListInclude()
                    : this.projectInstallationInclude(),
            });
            res.status(200).json(appointments);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // Sayfalı montaj listesi: mode=active (BOOKED, en yakını önce) |
    // completed (COMPLETED, en yenisi önce), 10'arlı sayfa. "İmzalı mı"
    // yalnızca SAYFADAKİ randevuların raporlarına bakılarak hesaplanır —
    // frontend'in findReport kuralının aynısı (aynı gün + randevu/sipariş
    // kapsamı), böylece durum rozetleri iki tarafta aynı sonucu verir.
    async listMontageOrdersPage(req, res, start, end) {
        const mode = String(req.query.mode || "active") === "completed" ? "completed" : "active";
        const page = Math.max(1, Number(req.query.page || 1) || 1);
        const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize || 10) || 10));
        const where = {
            tenantId: req.user.tenantId,
            OR: [
                { assignedTechId: req.user.id },
                { technicianAssignments: { some: { technicianId: req.user.id } } },
            ],
            projectId: { not: null },
            status: mode === "completed" ? "COMPLETED" : "BOOKED",
            startTime: { gte: start },
            endTime: { lte: end },
            ...(mode === "completed" ? { reports: { some: { employeeId: req.user.id } } } : {}),
        };
        const fetched = await prisma_client_1.default.appointment.findMany({
            where,
            orderBy: { startTime: mode === "completed" ? "desc" : "asc" },
            skip: (page - 1) * pageSize,
            take: pageSize + 1,
            select: {
                id: true,
                startTime: true,
                endTime: true,
                status: true,
                salesOrderId: true,
                projectId: true,
                salesOrder: { select: { orderNumber: true } },
                project: {
                    select: {
                        projectName: true,
                        customer: { select: { companyName: true } },
                    },
                },
                ...(mode === "completed"
                    ? {
                        reports: {
                            where: { employeeId: req.user.id },
                            orderBy: { reportDate: "desc" },
                            take: 1,
                            select: { id: true, isSigned: true },
                        },
                    }
                    : {}),
            },
        });
        const hasMore = fetched.length > pageSize;
        const appointments = fetched.slice(0, pageSize);
        const offset = (page - 1) * pageSize;
        const total = hasMore
            ? await prisma_client_1.default.appointment.count({ where })
            : offset + appointments.length;
        // İmza durumu yalnızca appointmentId üzerinden hesaplanır. Bir siparişin
        // başka gün/randevusuna ait raporu bu satırı imzalı gösteremez.
        res.status(200).json({
            items: appointments.map((appt) => ({
                id: appt.id,
                startTime: appt.startTime,
                endTime: appt.endTime,
                status: appt.status,
                projectId: appt.projectId,
                salesOrderId: appt.salesOrderId,
                orderNumber: appt.salesOrder?.orderNumber || appt.project?.projectName || appt.id,
                projectName: appt.project?.projectName || "-",
                customerName: appt.project?.customer?.companyName || "-",
                fieldReportId: appt.reports?.[0]?.id || null,
                signed: Boolean(appt.reports?.[0]?.isSigned),
            })),
            total,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
            page,
            pageSize,
        });
    }
    /**
     * Technician report registry used by the montage panel.
     *
     * The list deliberately returns only the visible table columns. In
     * particular it never selects report images, checklist JSON or the
     * LongText customer-signature fields. Field-report preview data is loaded
     * from getMyMontageReport only after the user opens a row.
     */
    async listMyMontageReportOrders(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const employeeId = req.user.id;
            const page = Math.max(1, Number(req.query.page || 1) || 1);
            const pageSize = Math.min(20, Math.max(1, Number(req.query.pageSize || 10) || 10));
            const search = String(req.query.search || "").trim();
            const offset = (page - 1) * pageSize;
            const searchFilter = search
                ? client_1.Prisma.sql `
                    AND (
                        so.orderNumber LIKE ${`%${search}%`}
                        OR p.projectName LIKE ${`%${search}%`}
                        OR c.companyName LIKE ${`%${search}%`}
                    )
                `
                : client_1.Prisma.empty;
            // One narrow query replaces the previous sequential groupBy + order
            // lookup (+ occasional second groupBy for total). COUNT(*) OVER()
            // keeps exact 10-row pagination without another database round trip.
            const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT
                    so.id AS salesOrderId,
                    so.orderNumber AS orderNumber,
                    so.projectId AS projectId,
                    p.projectName AS projectName,
                    c.companyName AS customerName,
                    COUNT(pr.id) AS fieldReportCount,
                    MAX(pr.reportDate) AS latestReportDate,
                    COUNT(*) OVER() AS totalRows
                FROM ProjectReport pr
                INNER JOIN Project p
                    ON p.id = pr.projectId
                    AND p.tenantId = ${tenantId}
                INNER JOIN SalesOrder so
                    ON so.id = pr.salesOrderId
                    AND so.tenantId = ${tenantId}
                LEFT JOIN Customer c
                    ON c.id = p.customerId
                WHERE pr.employeeId = ${employeeId}
                    AND pr.salesOrderId IS NOT NULL
                    ${searchFilter}
                GROUP BY
                    so.id,
                    so.orderNumber,
                    so.projectId,
                    p.projectName,
                    c.companyName
                ORDER BY latestReportDate DESC
                LIMIT ${pageSize}
                OFFSET ${offset}
            `);
            const total = Number(rows[0]?.totalRows || 0);
            res.status(200).json({
                items: rows.map((row) => ({
                    salesOrderId: row.salesOrderId,
                    orderNumber: row.orderNumber || row.salesOrderId,
                    projectId: row.projectId || null,
                    projectName: row.projectName || "-",
                    customerName: row.customerName || "-",
                    fieldReportCount: Number(row.fieldReportCount || 0),
                    latestReportDate: row.latestReportDate || null,
                })),
                total,
                totalPages: Math.max(1, Math.ceil(total / pageSize)),
                page,
                pageSize,
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getMyMontageReportOrder(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const employeeId = req.user.id;
            const salesOrderId = String(req.params.salesOrderId || "");
            const fieldReports = await prisma_client_1.default.projectReport.findMany({
                where: {
                    employeeId,
                    salesOrderId,
                    project: { tenantId },
                },
                orderBy: { reportDate: "desc" },
                select: {
                    id: true,
                    appointmentId: true,
                    reportDate: true,
                    workDate: true,
                    isSigned: true,
                    appointment: {
                        select: { id: true, startTime: true, endTime: true },
                    },
                    employee: {
                        select: { firstName: true, lastName: true },
                    },
                },
            });
            if (!fieldReports.length)
                return res.status(404).json({ error: "Sipariş saha raporu bulunamadı." });
            const order = await prisma_client_1.default.salesOrder.findFirst({
                where: { id: salesOrderId, tenantId },
                select: {
                    id: true,
                    orderNumber: true,
                    projectId: true,
                    project: {
                        select: {
                            projectName: true,
                            customer: { select: { companyName: true } },
                        },
                    },
                },
            });
            if (!order)
                return res.status(404).json({ error: "Sipariş bulunamadı." });
            const [deliveryReport, exactGeneral, fallbackGeneral] = await Promise.all([
                prisma_client_1.default.deliveryReport.findFirst({
                    where: { tenantId, salesOrderId },
                    orderBy: { createdAt: "desc" },
                    select: { id: true, isSigned: true, createdAt: true, checklistName: true },
                }),
                prisma_client_1.default.signatureRequest.findFirst({
                    where: { tenantId, reportType: "GENERAL", reportId: salesOrderId },
                    orderBy: { createdAt: "desc" },
                    select: { id: true, status: true, createdAt: true },
                }),
                prisma_client_1.default.signatureRequest.findFirst({
                    where: {
                        tenantId,
                        reportType: "GENERAL",
                        projectId: order.projectId || "__no_match__",
                        title: { contains: order.orderNumber },
                    },
                    orderBy: { createdAt: "desc" },
                    select: { id: true, status: true, createdAt: true },
                }),
            ]);
            res.status(200).json({
                order: {
                    salesOrderId: order.id,
                    orderNumber: order.orderNumber,
                    projectId: order.projectId,
                    projectName: order.project?.projectName || "-",
                    customerName: order.project?.customer?.companyName || "-",
                },
                fieldReports,
                deliveryReport,
                generalReport: exactGeneral || fallbackGeneral,
                createAppointmentId: fieldReports.find((row) => row.appointmentId)?.appointmentId || null,
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getMyMontageReportResources(req, res) {
        try {
            const report = await prisma_client_1.default.projectReport.findFirst({
                where: {
                    id: String(req.params.reportId),
                    employeeId: req.user.id,
                    project: { tenantId: req.user.tenantId },
                },
                select: {
                    id: true,
                    appointmentId: true,
                    usedMaterials: {
                        select: {
                            id: true,
                            quantity: true,
                            costAtTime: true,
                            article: { select: { articleCode: true, name: true, unit: true } },
                        },
                    },
                },
            });
            if (!report)
                return res.status(404).json({ error: "Saha raporu bulunamadı." });
            if (!report.appointmentId) {
                return res.status(200).json({ usedMaterials: report.usedMaterials, extraMaterials: [], expenses: [] });
            }
            const [extraMaterials, expenses] = await Promise.all([
                prisma_client_1.default.projectExtraMaterial.findMany({
                    where: { appointmentId: report.appointmentId },
                    select: {
                        id: true,
                        quantity: true,
                        unitPrice: true,
                        description: true,
                        article: { select: { name: true } },
                    },
                }),
                prisma_client_1.default.projectExpense.findMany({
                    where: { appointmentId: report.appointmentId },
                    select: {
                        id: true,
                        expenseType: true,
                        amount: true,
                        description: true,
                        expenseDate: true,
                    },
                }),
            ]);
            res.status(200).json({ usedMaterials: report.usedMaterials, extraMaterials, expenses });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async listMyMontageReports(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const employeeId = req.user.id;
            const page = Math.max(1, Number(req.query.page || 1) || 1);
            const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize || 10) || 10));
            const kind = ["field", "delivery", "general"].includes(String(req.query.kind))
                ? String(req.query.kind)
                : "all";
            const signed = ["signed", "unsigned"].includes(String(req.query.signed))
                ? String(req.query.signed)
                : "all";
            const search = String(req.query.search || "").trim();
            const signedValue = signed === "all" ? undefined : signed === "signed";
            const matchingProjects = search
                ? await prisma_client_1.default.project.findMany({
                    where: {
                        tenantId,
                        OR: [
                            { projectNumber: { contains: search } },
                            { projectName: { contains: search } },
                            { customer: { is: { companyName: { contains: search } } } },
                        ],
                    },
                    select: { id: true },
                })
                : [];
            const matchingOrders = search
                ? await prisma_client_1.default.salesOrder.findMany({
                    where: {
                        tenantId,
                        OR: [
                            { orderNumber: { contains: search } },
                            { legacyNumber: { contains: search } },
                        ],
                    },
                    select: { id: true },
                })
                : [];
            const matchingProjectIds = matchingProjects.map((row) => row.id);
            const matchingOrderIds = matchingOrders.map((row) => row.id);
            const fieldWhere = {
                employeeId,
                project: { tenantId },
                ...(signedValue === undefined ? {} : { isSigned: signedValue }),
            };
            const deliveryWhere = {
                tenantId,
                employeeId,
                ...(signedValue === undefined ? {} : { isSigned: signedValue }),
            };
            const assignedProjectRows = kind === "all" || kind === "general"
                ? await prisma_client_1.default.appointment.findMany({
                    where: {
                        tenantId,
                        projectId: { not: null },
                        OR: [
                            { assignedTechId: employeeId },
                            { technicianAssignments: { some: { technicianId: employeeId } } },
                        ],
                    },
                    distinct: ["projectId"],
                    select: { projectId: true },
                })
                : [];
            const assignedProjectIds = assignedProjectRows.map((row) => row.projectId).filter(Boolean);
            const generalWhere = {
                tenantId,
                reportType: "GENERAL",
                projectId: assignedProjectIds.length ? { in: assignedProjectIds } : "__no_match__",
                ...(signedValue === undefined
                    ? {}
                    : signedValue
                        ? { status: "SIGNED" }
                        : { status: { not: "SIGNED" } }),
            };
            if (search) {
                fieldWhere.OR = [
                    { operationsDone: { contains: search } },
                    ...(matchingProjectIds.length ? [{ projectId: { in: matchingProjectIds } }] : []),
                    ...(matchingOrderIds.length ? [{ salesOrderId: { in: matchingOrderIds } }] : []),
                ];
                deliveryWhere.OR = [
                    ...(matchingProjectIds.length ? [{ projectId: { in: matchingProjectIds } }] : []),
                    ...(matchingOrderIds.length ? [{ salesOrderId: { in: matchingOrderIds } }] : []),
                ];
                if (!deliveryWhere.OR.length)
                    deliveryWhere.id = "__no_match__";
                generalWhere.OR = [
                    { title: { contains: search } },
                    ...(matchingProjectIds.length ? [{ projectId: { in: matchingProjectIds } }] : []),
                ];
            }
            const includeField = kind !== "delivery" && kind !== "general";
            const includeDelivery = kind !== "field" && kind !== "general";
            const includeGeneral = kind !== "field" && kind !== "delivery";
            const requestedRows = page * pageSize;
            const [fieldTotal, deliveryTotal, generalTotal, fieldReports, deliveryReports, generalReports] = await Promise.all([
                includeField ? prisma_client_1.default.projectReport.count({ where: fieldWhere }) : 0,
                includeDelivery ? prisma_client_1.default.deliveryReport.count({ where: deliveryWhere }) : 0,
                includeGeneral ? prisma_client_1.default.signatureRequest.count({ where: generalWhere }) : 0,
                includeField
                    ? prisma_client_1.default.projectReport.findMany({
                        where: fieldWhere,
                        orderBy: { reportDate: "desc" },
                        take: requestedRows,
                        select: {
                            id: true,
                            reportDate: true,
                            workDate: true,
                            appointmentId: true,
                            projectId: true,
                            salesOrderId: true,
                            isSigned: true,
                            project: {
                                select: {
                                    projectName: true,
                                    customer: { select: { companyName: true } },
                                },
                            },
                            salesOrder: { select: { orderNumber: true } },
                        },
                    })
                    : [],
                includeDelivery
                    ? prisma_client_1.default.deliveryReport.findMany({
                        where: deliveryWhere,
                        orderBy: { createdAt: "desc" },
                        take: requestedRows,
                        select: {
                            id: true,
                            createdAt: true,
                            appointmentId: true,
                            projectId: true,
                            salesOrderId: true,
                            isSigned: true,
                        },
                    })
                    : [],
                includeGeneral
                    ? prisma_client_1.default.signatureRequest.findMany({
                        where: generalWhere,
                        orderBy: { createdAt: "desc" },
                        take: requestedRows,
                        select: {
                            id: true,
                            createdAt: true,
                            projectId: true,
                            title: true,
                            status: true,
                            signedAt: true,
                        },
                    })
                    : [],
            ]);
            // DeliveryReport intentionally has no Prisma relation to project/order.
            // Resolve just the labels required by the current page in two batched
            // scalar queries.
            const deliveryProjectIds = [...new Set([
                    ...deliveryReports.map((row) => row.projectId),
                    ...generalReports.map((row) => row.projectId),
                ].filter(Boolean))];
            const deliveryOrderIds = [...new Set(deliveryReports.map((row) => row.salesOrderId).filter(Boolean))];
            const [deliveryProjects, deliveryOrders] = await Promise.all([
                deliveryProjectIds.length
                    ? prisma_client_1.default.project.findMany({
                        where: { id: { in: deliveryProjectIds }, tenantId },
                        select: {
                            id: true,
                            projectName: true,
                            customer: { select: { companyName: true } },
                        },
                    })
                    : [],
                deliveryOrderIds.length
                    ? prisma_client_1.default.salesOrder.findMany({
                        where: { id: { in: deliveryOrderIds }, tenantId },
                        select: { id: true, orderNumber: true },
                    })
                    : [],
            ]);
            const projectLabels = new Map(deliveryProjects.map((row) => [row.id, row]));
            const orderLabels = new Map(deliveryOrders.map((row) => [row.id, row]));
            const rows = [
                ...fieldReports.map((report) => ({
                    key: `field-${report.id}`,
                    id: report.id,
                    kind: "field",
                    date: report.workDate || report.reportDate,
                    customerName: report.project?.customer?.companyName || "-",
                    projectName: report.project?.projectName || "-",
                    projectId: report.projectId || null,
                    orderNumber: report.salesOrder?.orderNumber || "-",
                    appointmentId: report.appointmentId || null,
                    signed: Boolean(report.isSigned),
                })),
                ...deliveryReports.map((report) => {
                    const project = report.projectId ? projectLabels.get(report.projectId) : null;
                    const order = report.salesOrderId ? orderLabels.get(report.salesOrderId) : null;
                    return {
                        key: `delivery-${report.id}`,
                        id: report.id,
                        kind: "delivery",
                        date: report.createdAt,
                        customerName: project?.customer?.companyName || "-",
                        projectName: project?.projectName || "-",
                        projectId: report.projectId || null,
                        orderNumber: order?.orderNumber || "-",
                        appointmentId: report.appointmentId || null,
                        signed: Boolean(report.isSigned),
                    };
                }),
                ...generalReports.map((report) => {
                    const project = report.projectId ? projectLabels.get(report.projectId) : null;
                    return {
                        key: `general-${report.id}`,
                        id: report.id,
                        kind: "general",
                        date: report.createdAt,
                        customerName: project?.customer?.companyName || "-",
                        projectName: project?.projectName || "-",
                        projectId: report.projectId || null,
                        orderNumber: report.title || "-",
                        appointmentId: null,
                        signed: report.status === "SIGNED",
                    };
                }),
            ]
                .sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")))
                .slice((page - 1) * pageSize, page * pageSize);
            const total = Number(fieldTotal) + Number(deliveryTotal) + Number(generalTotal);
            res.status(200).json({
                items: rows,
                total,
                totalPages: Math.max(1, Math.ceil(total / pageSize)),
                page,
                pageSize,
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /** Full field-report preview, fetched only after a report row is opened. */
    async getMyMontageReport(req, res) {
        try {
            const report = await prisma_client_1.default.projectReport.findFirst({
                where: {
                    id: String(req.params.reportId),
                    employeeId: req.user.id,
                    project: { tenantId: req.user.tenantId },
                },
                include: {
                    project: {
                        select: {
                            id: true,
                            projectName: true,
                            customer: { select: { id: true, companyName: true } },
                        },
                    },
                    salesOrder: { select: { id: true, orderNumber: true } },
                    appointment: { select: { id: true, startTime: true, endTime: true } },
                    employee: { select: { id: true, firstName: true, lastName: true } },
                    images: {
                        orderBy: { createdAt: "asc" },
                        select: { id: true, imageData: true, caption: true },
                    },
                },
            });
            if (!report)
                return res.status(404).json({ error: "Saha raporu bulunamadı." });
            res.status(200).json(report);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // Manager-facing list of every order appointment in the tenant for the range
    // (technicians use listMyInstallations, which scopes to their own assignments).
    async listAppointments(req, res) {
        try {
            const now = new Date();
            const rawStart = req.query.start ? new Date(String(req.query.start)) : new Date(now.getFullYear(), now.getMonth(), 1);
            const rawEnd = req.query.end ? new Date(String(req.query.end)) : new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999);
            if (Number.isNaN(rawStart.getTime()) || Number.isNaN(rawEnd.getTime())) {
                return res.status(400).json({ error: "Geçerli tarih aralığı girin." });
            }
            // Date-only params (e.g. "2026-06-17") parse to midnight; widen to cover
            // the full first/last day so single-day (day view) ranges are not empty.
            const start = startOfDay(rawStart);
            const end = endOfDay(rawEnd);
            if (String(req.query.view || "") === "calendar") {
                const appointments = await this.listCalendarAppointments(req.user.tenantId, start, end);
                return res.status(200).json(appointments);
            }
            const appointments = await prisma_client_1.default.appointment.findMany({
                where: {
                    tenantId: req.user.tenantId,
                    projectId: { not: null },
                    status: { in: ["BOOKED", "COMPLETED"] },
                    startTime: { gte: start },
                    endTime: { lte: end },
                },
                orderBy: { startTime: "asc" },
                include: this.projectInstallationInclude(),
            });
            res.status(200).json(appointments);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getMyInstallation(req, res) {
        try {
            const appointmentId = String(req.params.appointmentId || "");
            const section = String(req.query.section || "work");
            const where = {
                id: appointmentId,
                tenantId: req.user.tenantId,
                OR: [
                    { assignedTechId: req.user.id },
                    { technicianAssignments: { some: { technicianId: req.user.id } } },
                ],
                projectId: { not: null },
            };
            const appointment = section === "general"
                ? await prisma_client_1.default.appointment.findFirst({
                    where,
                    include: this.projectInstallationInclude(),
                })
                : await prisma_client_1.default.appointment.findFirst({
                    where,
                    select: section === "expenses"
                        ? this.projectInstallationExpenseSelect()
                        : section === "materials"
                            ? this.projectInstallationMaterialSelect()
                            : this.projectInstallationWorkSelect(appointmentId),
                });
            if (!appointment)
                return res.status(404).json({ error: "Montaj randevusu bulunamadı." });
            res.status(200).json(appointment);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // Detail for the calendar popup, fetched lazily when an appointment block is
    // clicked. `technicianScope` mirrors the two list endpoints: managers may open
    // any appointment in the tenant, technicians only their own assignments.
    async getAppointmentDetail(req, res, opts = {}) {
        try {
            const where = {
                id: String(req.params.appointmentId || ""),
                tenantId: req.user.tenantId,
                projectId: { not: null },
            };
            if (opts.technicianScope) {
                where.OR = [
                    { assignedTechId: req.user.id },
                    { technicianAssignments: { some: { technicianId: req.user.id } } },
                ];
            }
            const appointment = await prisma_client_1.default.appointment.findFirst(opts.technicianScope
                ? { where, select: this.projectTechnicianPopupSelect() }
                : { where, include: this.projectCalendarDetailInclude() });
            if (!appointment)
                return res.status(404).json({ error: "Randevu bulunamadı." });
            res.status(200).json(appointment);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async getById(req, res) {
        try {
            const allowedViews = new Set([
                "overview",
                "details",
                "planning",
                "fieldReports",
                "generalReport",
                "delivery",
                "signatures",
                "expenses",
                "materials",
                "overtime",
                "billing",
                "addons",
            ]);
            const requestedView = String(req.query.view || "");
            if (requestedView && !allowedViews.has(requestedView)) {
                return res.status(400).json({ error: "Geçersiz proje detay görünümü." });
            }
            const projectId = req.params.id;
            const tenantId = req.user.tenantId;
            const projectPromise = requestedView
                ? this.projectRepository.findDetailById(projectId, tenantId, requestedView)
                : this.projectRepository.findById(projectId, tenantId);
            // Independent relation: run it beside the main read model so a
            // remote database pays one critical-path round trip instead of two.
            const addonRequestsPromise = prisma_client_1.default.projectAddonRequest.findMany({
                where: { projectId, tenantId },
                orderBy: { createdAt: "desc" },
            }).catch((addonError) => {
                console.error("[getById] could not load addon requests:", addonError?.message || addonError);
                return [];
            });
            const [project, addonRequests] = await Promise.all([projectPromise, addonRequestsPromise]);
            if (!project) {
                return res.status(404).json({ error: "Proje bulunamadı veya seçili şirkette değil." });
            }
            res.status(200).json({ ...project, addonRequests });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async update(req, res) {
        try {
            const project = await this.projectRepository.findById(req.params.id);
            if (!project || project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }
            const allowed = ['projectName', 'managerId', 'status', 'startDate', 'endDate', 'plannedBudget', 'overtimeHourlyRate'];
            const patch = {};
            for (const key of allowed) {
                if (req.body[key] !== undefined)
                    patch[key] = req.body[key];
            }
            if (patch.startDate)
                patch.startDate = new Date(patch.startDate);
            if (patch.endDate)
                patch.endDate = new Date(patch.endDate);
            if (patch.plannedBudget !== undefined)
                patch.plannedBudget = Number(patch.plannedBudget);
            if (patch.overtimeHourlyRate !== undefined)
                patch.overtimeHourlyRate = Number(patch.overtimeHourlyRate);
            const updated = await this.projectRepository.updateProject(project.id, patch);
            res.status(200).json(updated);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async activate(req, res) {
        try {
            const project = await this.projectRepository.findById(req.params.id);
            if (!project || project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }
            if (project.status !== 'AWAITING_APPROVAL') {
                return res.status(400).json({ error: "Sadece onay bekleyen projeler aktiflestirilebilir." });
            }
            const updated = await this.projectRepository.updateProject(project.id, {
                status: 'ACTIVE',
                startDate: req.body.startDate ? new Date(req.body.startDate) : new Date()
            });
            res.status(200).json({ message: "Proje aktiflestirildi.", project: updated });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // Flat list of every field report in the tenant, for the Services > Reports module.
    async listAllReports(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const search = String(req.query.search || "").trim();
            const startRaw = req.query.start ? new Date(String(req.query.start)) : null;
            const endRaw = req.query.end ? new Date(String(req.query.end)) : null;
            // LİSTE GÖVDESİ — rapor İÇERİĞİ taşınmaz. Tablolar yalnızca tarih,
            // süre/mesai kolonları, etiketler ve onay/imza durumunu çiziyor.
            // `operationsDone` / `technicalNotes` / `customerSignature` (base64
            // imza) ile `usedMaterials`, `images`, `employee`, `appointment`
            // ilişkileri sadece PDF üretilirken gerekiyor; PDF yolu zaten projeyi
            // `GET /projects/:id` ile baştan çekip tam raporu oradan okuyor.
            //
            // Bu ilişkiler Prisma'da ilişki başına AYRI bir sorgu turu demekti
            // (usedMaterials iki seviye olduğu için iki tur) — uzak veritabanında
            // ifade başına ~100 ms. Kalan iki ilişki tek ham JOIN'de geliyor.
            const whereSql = [client_1.Prisma.sql `pj.tenantId = ${tenantId}`];
            if (startRaw && !Number.isNaN(startRaw.getTime())) {
                whereSql.push(client_1.Prisma.sql `pr.workDate >= ${startOfDay(startRaw)}`);
            }
            if (endRaw && !Number.isNaN(endRaw.getTime())) {
                whereSql.push(client_1.Prisma.sql `pr.workDate <= ${endOfDay(endRaw)}`);
            }
            if (search) {
                const pattern = `%${search}%`;
                whereSql.push(client_1.Prisma.sql `(
                    pj.projectName LIKE ${pattern}
                    OR c.companyName LIKE ${pattern}
                    OR pr.operationsDone LIKE ${pattern}
                )`);
            }
            const rows = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT
                    pr.id, pr.projectId, pr.salesOrderId, pr.appointmentId,
                    pr.reportDate, pr.workDate, pr.startedAt, pr.endedAt,
                    pr.workedMinutes, pr.plannedMinutesForDay, pr.overtimeMinutes,
                    pr.overtimeHourlyRate, pr.overtimeCost,
                    pr.isSigned, pr.hoursApprovedAt, pr.autoApproved,
                    pj.projectName AS projectName,
                    c.id AS customerId,
                    c.companyName AS customerName,
                    so.orderNumber AS orderNumber
                FROM ProjectReport pr
                INNER JOIN Project pj ON pj.id = pr.projectId
                LEFT JOIN Customer c ON c.id = pj.customerId
                LEFT JOIN SalesOrder so ON so.id = pr.salesOrderId
                WHERE ${client_1.Prisma.join(whereSql, ' AND ')}
                ORDER BY pr.reportDate DESC
                LIMIT 500
            `);
            const reports = rows.map((row) => ({
                id: row.id,
                projectId: row.projectId,
                salesOrderId: row.salesOrderId ?? null,
                appointmentId: row.appointmentId ?? null,
                reportDate: row.reportDate,
                workDate: row.workDate,
                startedAt: row.startedAt ?? null,
                endedAt: row.endedAt ?? null,
                workedMinutes: Number(row.workedMinutes ?? 0),
                plannedMinutesForDay: Number(row.plannedMinutesForDay ?? 0),
                overtimeMinutes: Number(row.overtimeMinutes ?? 0),
                overtimeHourlyRate: Number(row.overtimeHourlyRate ?? 0),
                overtimeCost: Number(row.overtimeCost ?? 0),
                isSigned: Boolean(row.isSigned),
                hoursApprovedAt: row.hoursApprovedAt ?? null,
                autoApproved: Boolean(row.autoApproved),
                project: {
                    id: row.projectId,
                    projectName: row.projectName ?? null,
                    customer: row.customerId
                        ? { id: row.customerId, companyName: row.customerName ?? null }
                        : null,
                },
                salesOrder: row.salesOrderId
                    ? { id: row.salesOrderId, orderNumber: row.orderNumber ?? null }
                    : null,
            }));
            res.status(200).json(reports);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /**
     * Saha ekranlarının "malzeme" kataloğu — malzeme/ürün birleşmesinden
     * (2026-08-14) beri ÜRÜN listesidir. Yanıt eski ProjectMaterial biçimini
     * korur (serialId=articleCode, unitCost=salePrice, stockQuantity=bakiye
     * toplamı), böylece montaj/rapor/teklif seçicileri değişmeden çalışır.
     */
    async listMaterials(req, res) {
        try {
            const tenantId = req.user.tenantId;
            const compact = req.query.view === "picker";
            const [articles, balances] = await Promise.all([
                prisma_client_1.default.article.findMany({
                    where: { tenantId, deletedAt: null, isActive: true },
                    select: {
                        id: true,
                        articleCode: true,
                        name: true,
                        unit: true,
                        salePrice: true,
                        ...(compact ? {} : { minStockLevel: true, criticalStockLevel: true }),
                    },
                    orderBy: { name: 'asc' },
                }),
                prisma_client_1.default.stockBalance.groupBy({
                    by: ['articleId'],
                    where: { tenantId },
                    _sum: { currentQuantity: true },
                }),
            ]);
            const stockByArticle = new Map(balances.map((row) => [row.articleId, Number(row._sum?.currentQuantity || 0)]));
            res.status(200).json(articles.map((article) => ({
                id: article.id,
                serialId: article.articleCode,
                name: article.name,
                unit: article.unit,
                unitCost: article.salePrice,
                stockQuantity: stockByArticle.get(article.id) || 0,
                ...(compact ? {} : {
                    minStockLevel: article.minStockLevel,
                    criticalStockLevel: article.criticalStockLevel,
                }),
            })));
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async createFromTender(req, res) {
        try {
            const { tenderId, managerId, overtimeHourlyRate } = req.body;
            const employeeId = req.user.id;
            const project = await this.createProjectUseCase.execute(tenderId, employeeId, managerId, req.user.tenantId, Number(overtimeHourlyRate || 0));
            const frontendUrl = process.env.OFFITEC_FRONTEND_URL || 'http://localhost:5173';
            const bookingLink = `${frontendUrl}/booking/${project.bookingToken}`;
            res.status(201).json({
                message: "Sipariş/proje oluşturuldu. Teklif mailindeki saat planları projeye kilitli randevu olarak aktarıldı.",
                project,
                bookingLink
            });
        }
        catch (error) {
            res.status(403).json({ error: error.message });
        }
    }
    async sendBookingMail(req, res) {
        try {
            const project = await this.projectRepository.findById(req.params.id);
            if (!project || project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }
            if (!project.bookingToken) {
                return res.status(400).json({ error: "Bu proje için randevu tokeni yok." });
            }
            const settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId: await (0, serviceTenantScope_1.getMailTenantId)(req.user.tenantId) } });
            const frontendUrl = process.env.OFFITEC_FRONTEND_URL || 'http://localhost:5173';
            const bookingLink = `${frontendUrl}/booking/${project.bookingToken}`;
            const customerEmail = project.customer?.mainEmail || "";
            const to = String(req.body.to || customerEmail || "").trim();
            const fromEmail = String(req.body.fromEmail || settings?.fromEmail || req.user.email || "").trim();
            const fromName = req.body.fromName || settings?.fromName || "Offitec ERP";
            const subject = String(req.body.subject || `${project.projectName} - Montaj randevusu`).trim();
            const message = req.body.message || "Lütfen size uygun montaj saatini seçin.";
            if (!to)
                return res.status(400).json({ error: "Alıcı e-posta adresi zorunludur." });
            if (!fromEmail)
                return res.status(400).json({ error: "Gönderici e-posta adresi zorunludur." });
            const html = `
                <div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.6">
                    <p>${message}</p>
                    <p><a href="${bookingLink}" style="display:inline-block;background:#1d4ed8;color:white;padding:10px 14px;border-radius:6px;text-decoration:none">Randevu saatini seç</a></p>
                    <p style="font-size:12px;color:#64748b">${bookingLink}</p>
                </div>
            `;
            // Kundenmail → über das Outlook-Postfach des Benutzers (sonst SMTP),
            // festgehalten in der Kundenkommunikation (MailMessage).
            const result = await (0, MailDispatchService_1.dispatchMail)({ tenantId: req.user.tenantId, employeeId: req.user.id }, settings, {
                fromEmail,
                fromName,
                to,
                subject,
                text: `${message}\n\n${bookingLink}`,
                html,
                replyTo: req.body.replyTo || settings?.replyTo || null
            }, {
                record: project.customerId
                    ? { customerId: project.customerId, entityType: 'PROJECT', entityId: project.id, entityLabel: project.projectNumber || project.projectName }
                    : null,
            });
            res.status(200).json({
                message: result.preview
                    ? "SMTP ayarı olmadığı için randevu maili önizleme olarak hazırlandı."
                    : "Randevu maili gönderildi.",
                bookingLink,
                ...result
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // ── Rapport-Speicherprotokoll ─────────────────────────────────────────
    // Jede Speicherung/Fertigstellung/Signatur schreibt best-effort eine
    // Protokollzeile (wer, wann, was). Ein Fehler hier — z. B. eine noch nicht
    // eingespielte Migration — darf die Speicherung selbst niemals abbrechen.
    async writeReportLog(reportId, employeeId, action) {
        try {
            await prisma_client_1.default.projectReportLog.create({
                data: { id: (0, nanoid_1.nanoid)(10), reportId, employeeId, action },
            });
        }
        catch (logError) {
            console.error('[writeReportLog] failed:', logError?.message || logError);
        }
    }
    // Wer hat den Rapport wann gespeichert — der Protokoll-Knopf der
    // Projektleiter-Ansicht liest diese Liste (neueste zuerst).
    async getReportLogs(req, res) {
        try {
            const reportId = req.params.reportId;
            const report = await prisma_client_1.default.projectReport.findFirst({
                where: { id: reportId, project: { tenantId: req.user.tenantId } },
                select: { id: true },
            });
            if (!report)
                return res.status(404).json({ error: "Saha raporu bulunamadı." });
            let logs = [];
            try {
                logs = await prisma_client_1.default.projectReportLog.findMany({
                    where: { reportId },
                    orderBy: { createdAt: 'desc' },
                    include: { employee: { select: { id: true, firstName: true, lastName: true } } },
                });
            }
            catch (logError) {
                // Migration fehlt noch — leere Liste statt Fehler, die Ansicht bleibt nutzbar.
                console.error('[getReportLogs] failed:', logError?.message || logError);
            }
            res.status(200).json({ logs });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /**
     * Ersetzt die Ressourcen eines Termins VOLLSTÄNDIG durch den übergebenen
     * Stand ("der letzte Speicherstand gilt", Benutzerwunsch 2026-08-13). Jede
     * übergebene Liste ist der GESAMTE gewünschte Bestand des Termins: Zeilen
     * mit id bleiben (Menge/Betrag wird angepasst, Bestandsdifferenz gebucht),
     * Zeilen ohne id werden angelegt (Bestand abgebucht), fehlende Zeilen
     * gelöscht (Zusatzmaterial wird dabei RESTOCKT — dieselbe Buchung wie beim
     * einzelnen Löschen). `undefined` lässt die jeweilige Liste unangetastet.
     */
    async replaceAppointmentResources(args) {
        const { tenantId, projectId, salesOrderId, appointmentId, reportId, employeeId } = args;
        // İstemci artık yalnızca değişen kaynak gruplarını yollar. Hiçbiri
        // değişmediyse transaction/okuma açmadan doğrudan rapor kaydına dön.
        if (args.expenses === undefined && args.extraMaterials === undefined && args.usedMaterials === undefined)
            return;
        const wantExpenses = args.expenses
            ?.map((row) => ({
            id: row.id ? String(row.id) : null,
            expenseType: String(row.expenseType || '').trim(),
            // Betrag ist NICHT Pflicht: eine Zeile mit Text zählt auch mit 0.
            amount: Number.isFinite(Number(row.amount)) && Number(row.amount) > 0 ? Number(row.amount) : 0,
        }))
            .filter((row) => row.expenseType);
        const wantExtras = args.extraMaterials
            ?.map((row) => ({
            id: row.id ? String(row.id) : null,
            materialId: String(row.materialId || '').trim(),
            quantity: Number(row.quantity || 0),
            description: row.description ? String(row.description).trim() : null,
        }))
            .filter((row) => row.materialId && row.quantity > 0);
        const wantUsed = args.usedMaterials
            ?.map((row) => ({
            id: row.id ? String(row.id) : null,
            materialId: String(row.materialId || '').trim(),
            quantity: Number(row.quantity || 0),
        }))
            .filter((row) => row.materialId && row.quantity > 0);
        // Ein Rundlauf für alle beteiligten Artikel (Tenant-Check + Preise +
        // verfügbarer Bestand über alle Lagerorte).
        const articleIds = [...new Set([
                ...(wantExtras || []).map((row) => row.materialId),
                ...(wantUsed || []).map((row) => row.materialId),
            ])];
        const articlesById = new Map();
        const stockLeft = new Map();
        if (articleIds.length) {
            const [articles, balances] = await Promise.all([
                prisma_client_1.default.article.findMany({
                    where: { id: { in: articleIds }, tenantId },
                    select: { id: true, name: true, salePrice: true },
                }),
                prisma_client_1.default.stockBalance.groupBy({
                    by: ['articleId'],
                    where: { articleId: { in: articleIds } },
                    _sum: { currentQuantity: true },
                }),
            ]);
            for (const article of articles)
                articlesById.set(article.id, article);
            for (const row of balances)
                stockLeft.set(row.articleId, Number(row._sum?.currentQuantity || 0));
        }
        const stockError = (article) => new Error(`[Stok uyarısı] ${article.name} için kayıtlı miktar yetersiz.`);
        // Verfügbarkeit wird lokal mitgeführt: mehrere Zeilen desselben Artikels
        // dürfen zusammen nicht mehr verbrauchen, als tatsächlich am Lager ist.
        const takeStock = (article, quantity) => {
            const available = stockLeft.get(article.id) ?? 0;
            if (available < quantity)
                throw stockError(article);
            stockLeft.set(article.id, available - quantity);
        };
        const giveStock = (articleId, quantity) => {
            stockLeft.set(articleId, (stockLeft.get(articleId) ?? 0) + quantity);
        };
        await prisma_client_1.default.$transaction(async (tx) => {
            if (wantExpenses) {
                const existing = await tx.projectExpense.findMany({
                    where: { projectId, appointmentId },
                    select: { id: true, expenseType: true, amount: true },
                });
                const keptIds = new Set(wantExpenses.filter((row) => row.id).map((row) => row.id));
                const removed = existing.filter((row) => !keptIds.has(row.id));
                if (removed.length) {
                    await tx.projectExpense.deleteMany({ where: { id: { in: removed.map((row) => row.id) } } });
                }
                for (const row of wantExpenses) {
                    const current = row.id ? existing.find((item) => item.id === row.id) : null;
                    if (current) {
                        if (current.expenseType !== row.expenseType || Number(current.amount) !== row.amount) {
                            await tx.projectExpense.update({
                                where: { id: current.id },
                                data: { expenseType: row.expenseType, amount: row.amount },
                            });
                        }
                    }
                    else {
                        await tx.projectExpense.create({
                            data: {
                                id: (0, nanoid_1.nanoid)(10),
                                projectId,
                                salesOrderId,
                                appointmentId,
                                expenseType: row.expenseType,
                                amount: row.amount,
                                description: '',
                            },
                        });
                    }
                }
            }
            if (wantExtras) {
                // Bestandsbuchungen laufen über StockMovement/StockBalance —
                // dieselbe Buchhaltung wie das Lager-Modul, nicht mehr das alte
                // Skalarfeld der Material-Tabelle.
                const restock = (articleId, quantity) => {
                    giveStock(articleId, quantity);
                    return (0, articleStock_1.adjustArticleStock)(tx, {
                        tenantId, articleId, employeeId, quantity,
                        direction: 'IN', referenceId: projectId, description: 'Zusatzmaterial iadesi',
                    });
                };
                const consume = (article, quantity) => {
                    takeStock(article, quantity);
                    return (0, articleStock_1.adjustArticleStock)(tx, {
                        tenantId, articleId: article.id, employeeId, quantity,
                        direction: 'OUT', referenceId: projectId, description: 'Zusatzmaterial',
                    });
                };
                const existing = await tx.projectExtraMaterial.findMany({
                    where: { projectId, appointmentId },
                    select: { id: true, articleId: true, quantity: true, description: true },
                });
                const keptIds = new Set(wantExtras.filter((row) => row.id).map((row) => row.id));
                for (const current of existing) {
                    if (keptIds.has(current.id))
                        continue;
                    await restock(current.articleId, Number(current.quantity || 0));
                    await tx.projectExtraMaterial.delete({ where: { id: current.id } });
                }
                for (const row of wantExtras) {
                    const article = articlesById.get(row.materialId);
                    // Unbekannter / fremder Artikel wird still übersprungen — wie bisher.
                    if (!article)
                        continue;
                    const current = row.id ? existing.find((item) => item.id === row.id) : null;
                    if (!current) {
                        await consume(article, row.quantity);
                        await tx.projectExtraMaterial.create({
                            data: {
                                id: (0, nanoid_1.nanoid)(10),
                                projectId,
                                salesOrderId,
                                appointmentId,
                                articleId: article.id,
                                quantity: row.quantity,
                                unitPrice: Number(article.salePrice || 0),
                                description: row.description,
                            },
                        });
                    }
                    else if (current.articleId !== row.materialId) {
                        await restock(current.articleId, Number(current.quantity || 0));
                        await consume(article, row.quantity);
                        await tx.projectExtraMaterial.update({
                            where: { id: current.id },
                            data: { articleId: article.id, quantity: row.quantity, unitPrice: Number(article.salePrice || 0), description: row.description },
                        });
                    }
                    else {
                        const diff = row.quantity - Number(current.quantity || 0);
                        if (diff > 0) {
                            await consume(article, diff);
                        }
                        else if (diff < 0) {
                            await restock(article.id, Math.abs(diff));
                        }
                        if (diff !== 0 || (current.description || null) !== row.description) {
                            await tx.projectExtraMaterial.update({
                                where: { id: current.id },
                                data: { quantity: row.quantity, description: row.description },
                            });
                        }
                    }
                }
            }
            if (wantUsed) {
                const existing = await tx.reportMaterial.findMany({
                    where: { reportId },
                    select: { id: true, articleId: true, quantity: true },
                });
                const keptIds = new Set(wantUsed.filter((row) => row.id).map((row) => row.id));
                const removed = existing.filter((row) => !keptIds.has(row.id));
                if (removed.length) {
                    await tx.reportMaterial.deleteMany({ where: { id: { in: removed.map((row) => row.id) } } });
                }
                for (const row of wantUsed) {
                    const current = row.id ? existing.find((item) => item.id === row.id) : null;
                    if (current) {
                        // costAtTime der bestehenden Zeile bleibt — nur die Menge folgt.
                        if (Number(current.quantity) !== row.quantity) {
                            await tx.reportMaterial.update({ where: { id: current.id }, data: { quantity: row.quantity } });
                        }
                    }
                    else {
                        const article = articlesById.get(row.materialId);
                        if (!article)
                            continue;
                        await tx.reportMaterial.create({
                            data: {
                                id: (0, nanoid_1.nanoid)(10),
                                reportId,
                                articleId: article.id,
                                quantity: row.quantity,
                                costAtTime: Number(article.salePrice || 0),
                            },
                        });
                    }
                }
            }
        });
    }
    /**
     * Speichert den GANZEN Montage-Rapport eines Termins in EINEM Aufruf
     * (Benutzerwunsch 2026-08-13): Rapportkörper (upsert per Termin) plus
     * Spesen / Zusatzmaterial / verwendetes Material als vollständiger Ersatz
     * des bisherigen Standes — der letzte Speicherstand gilt, es gibt keine
     * zusammengeführten Rapporte. Jede Speicherung landet im Protokoll.
     * Projektleiter-Popup und Montage-Bildschirm rufen denselben Endpunkt.
     */
    async saveFieldReport(req, res) {
        try {
            const appointmentId = String(req.params.appointmentId || '');
            const appointment = await prisma_client_1.default.appointment.findFirst({
                where: { id: appointmentId, tenantId: req.user.tenantId, projectId: { not: null } },
                select: {
                    id: true,
                    projectId: true,
                    salesOrderId: true,
                    startTime: true,
                    endTime: true,
                    project: {
                        select: {
                            id: true,
                            status: true,
                            overtimeTolerancePercent: true,
                            overtimeHourlyRate: true,
                            salesOrders: {
                                orderBy: { createdAt: 'asc' },
                                select: { id: true, createdAt: true },
                            },
                        },
                    },
                },
            });
            if (!appointment?.project)
                return res.status(404).json({ error: "Montaj randevusu bulunamadı." });
            const operationItems = Array.isArray(req.body.operationsDoneItems)
                ? req.body.operationsDoneItems.map(String).map((item) => item.trim()).filter(Boolean)
                : [];
            const operationsDone = operationItems.length
                ? operationItems.map((item) => `- ${item}`).join('\n')
                : String(req.body.operationsDone || '').trim();
            if (!operationsDone)
                return res.status(400).json({ error: "Yapilan isler zorunludur." });
            const requestedSalesOrderId = String(req.body.salesOrderId ?? appointment.salesOrderId ?? '').trim();
            if (requestedSalesOrderId && !appointment.project.salesOrders.some((order) => order.id === requestedSalesOrderId)) {
                return res.status(400).json({ error: "Sipariş bu projeye ait değil." });
            }
            const salesOrderId = requestedSalesOrderId || null;
            // Der Termin besitzt seinen Rapport; Alt-Rapporte ohne appointmentId
            // desselben Tages werden weiterverwendet statt doppelt angelegt —
            // exakt die Logik von completeInstallation.
            const workDate = startOfDay(new Date(appointment.startTime));
            const isPrimaryOrder = (appointment.project.salesOrders?.[0]?.id || null) === (salesOrderId || null);
            const ownReport = await this.reportRepository.findByAppointmentId(appointment.id);
            const legacyDayReport = ownReport
                ? null
                : await this.reportRepository.findByProjectAndWorkDate(appointment.projectId, workDate, salesOrderId ?? undefined, isPrimaryOrder);
            const existingReport = ownReport || (legacyDayReport && !legacyDayReport.appointmentId ? legacyDayReport : null);
            const reportInput = {
                projectId: appointment.projectId,
                salesOrderId,
                appointmentId: appointment.id,
                employeeId: req.user.id,
                workDate: workDate.toISOString(),
                startedAt: req.body.startedAt || appointment.startTime,
                endedAt: req.body.endedAt || appointment.endTime,
                operationsDone,
                technicalNotes: req.body.technicalNotes,
                images: Array.isArray(req.body.images) ? req.body.images.map(String) : undefined,
                projectContext: appointment.project,
                deferResultHydration: true,
                existingReportContext: existingReport || undefined,
                duplicateCheckCompleted: true,
            };
            const reportResult = existingReport
                ? await this.addReportUseCase.update(existingReport.id, reportInput)
                : await this.addReportUseCase.execute(reportInput);
            await this.replaceAppointmentResources({
                tenantId: req.user.tenantId,
                projectId: appointment.projectId,
                salesOrderId,
                appointmentId: appointment.id,
                reportId: reportResult.id,
                employeeId: req.user.id,
                expenses: Array.isArray(req.body.expenses) ? req.body.expenses : undefined,
                extraMaterials: Array.isArray(req.body.extraMaterials) ? req.body.extraMaterials : undefined,
                usedMaterials: Array.isArray(req.body.usedMaterials) ? req.body.usedMaterials : undefined,
            });
            // Beide Unterschriften reisen mit dem gemeinsamen Rapport-Editor:
            // mitgeschickt = setzen/löschen, weggelassen = unverändert. Der
            // speichernde Benutzer bleibt über das Rapport-Protokoll sichtbar.
            if (req.body.technicianSignature !== undefined) {
                const signature = String(req.body.technicianSignature || '').startsWith('data:image/')
                    ? String(req.body.technicianSignature)
                    : null;
                await prisma_client_1.default.projectReport.update({
                    where: { id: reportResult.id },
                    data: { technicianSignature: signature, technicianSignedAt: signature ? new Date() : null },
                });
            }
            if (req.body.customerSignature !== undefined) {
                const signature = String(req.body.customerSignature || '').startsWith('data:image/')
                    ? String(req.body.customerSignature)
                    : null;
                await prisma_client_1.default.projectReport.update({
                    where: { id: reportResult.id },
                    data: {
                        customerSignature: signature,
                        isSigned: Boolean(signature),
                        signedAt: signature ? new Date() : null,
                    },
                });
            }
            // Denetim kaydı best-effort'tür; kullanıcı yanıtını ayrı bir INSERT
            // turu için bekletmez.
            void this.writeReportLog(reportResult.id, req.user.id, 'SAVED');
            // Das Büro erfährt vom eingegangenen Rapport (Glocke + Einblendung);
            // die speichernde Person selbst bekommt nichts.
            void (0, projectEventNotifications_1.notifyProjectEvent)({
                tenantId: req.user.tenantId,
                projectId: appointment.projectId,
                event: 'FIELD_REPORT_RECEIVED',
                report: 'FIELD',
                reportId: reportResult.id,
                actorEmployeeId: req.user.id,
            });
            // Frischer Stand in einer Antwort — der Client muss nicht nachladen.
            const [report, expenses, rawExtraMaterials] = await Promise.all([
                this.reportRepository.findSaveResultById(reportResult.id),
                prisma_client_1.default.projectExpense.findMany({
                    where: { projectId: appointment.projectId, appointmentId: appointment.id },
                    orderBy: { expenseDate: 'asc' },
                    select: { id: true, expenseType: true, amount: true },
                }),
                prisma_client_1.default.projectExtraMaterial.findMany({
                    where: { projectId: appointment.projectId, appointmentId: appointment.id },
                    orderBy: { addedAt: 'asc' },
                    select: {
                        id: true,
                        articleId: true,
                        quantity: true,
                        unitPrice: true,
                        description: true,
                        article: { select: { id: true, name: true } },
                    },
                }),
            ]);
            res.status(200).json({
                message: "Saha raporu kaydedildi.",
                report,
                expenses,
                extraMaterials: rawExtraMaterials.map((row) => ({
                    id: row.id,
                    materialId: row.articleId,
                    quantity: row.quantity,
                    unitPrice: row.unitPrice,
                    description: row.description,
                    material: row.article,
                })),
                overtimeWarning: reportResult.overtimeWarning || null,
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async addReport(req, res) {
        try {
            const salesOrderId = await this.resolveProjectSalesOrderId(req.params.id, req.user.tenantId, req.body.salesOrderId);
            // Tie the report to a specific appointment when one is supplied so it never
            // leaks onto sibling appointments sharing the sales order. Validate it belongs
            // to this project/tenant before trusting it.
            let appointmentId = null;
            if (req.body.appointmentId) {
                const appointment = await prisma_client_1.default.appointment.findFirst({
                    where: { id: String(req.body.appointmentId), tenantId: req.user.tenantId, projectId: req.params.id },
                    select: { id: true },
                });
                if (!appointment)
                    return res.status(400).json({ error: "Randevu bu projeye ait değil." });
                appointmentId = appointment.id;
            }
            const input = {
                projectId: req.params.id,
                salesOrderId,
                appointmentId,
                employeeId: req.user.id,
                workDate: req.body.workDate,
                startedAt: req.body.startedAt,
                endedAt: req.body.endedAt,
                operationsDone: req.body.operationsDone,
                technicalNotes: req.body.technicalNotes,
                images: Array.isArray(req.body.images) ? req.body.images.map(String) : undefined
            };
            const report = await this.addReportUseCase.execute(input);
            await this.writeReportLog(report.id, req.user.id, 'SAVED');
            res.status(201).json({ message: "Saha raporu kaydedildi.", report });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async updateReport(req, res) {
        try {
            const report = await this.reportRepository.findById(req.params.reportId);
            if (!report)
                return res.status(404).json({ error: "Saha raporu bulunamadı." });
            const project = await this.projectRepository.findById(report.projectId);
            if (!project || project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }
            const input = {
                projectId: report.projectId,
                salesOrderId: await this.resolveProjectSalesOrderId(report.projectId, req.user.tenantId, req.body.salesOrderId || report.salesOrderId),
                employeeId: req.user.id,
                workDate: req.body.workDate,
                startedAt: req.body.startedAt,
                endedAt: req.body.endedAt,
                operationsDone: req.body.operationsDone,
                technicalNotes: req.body.technicalNotes,
                images: Array.isArray(req.body.images) ? req.body.images.map(String) : undefined
            };
            const updated = await this.addReportUseCase.update(req.params.reportId, input);
            await this.writeReportLog(req.params.reportId, req.user.id, 'SAVED');
            res.status(200).json({ message: "Saha raporu güncellendi.", report: updated });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // Append used materials (reportMaterial rows) to an existing field report — used by the inline
    // "Saha" editor when adding used materials to a report that already exists.
    async addReportMaterials(req, res) {
        try {
            const reportId = req.params.reportId;
            const report = await prisma_client_1.default.projectReport.findFirst({
                where: { id: reportId, project: { tenantId: req.user.tenantId } },
                select: { id: true },
            });
            if (!report)
                return res.status(404).json({ error: "Saha raporu bulunamadı." });
            const items = Array.isArray(req.body.materials) ? req.body.materials : [];
            // `materialId` on the wire carries an Article id since the merge.
            const rows = [];
            for (const item of items) {
                const quantity = Number(item.quantity || 0);
                if (!item.materialId || quantity <= 0)
                    continue;
                const article = await prisma_client_1.default.article.findFirst({
                    where: { id: String(item.materialId), tenantId: req.user.tenantId },
                    select: { id: true, salePrice: true },
                });
                if (!article)
                    continue;
                rows.push({
                    id: (0, nanoid_1.nanoid)(10),
                    reportId: report.id,
                    articleId: article.id,
                    quantity,
                    costAtTime: Number(article.salePrice || 0),
                });
            }
            if (rows.length) {
                await prisma_client_1.default.reportMaterial.createMany({ data: rows });
            }
            res.status(201).json({ message: "Kullanılan malzemeler eklendi.", count: rows.length });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async signReport(req, res) {
        try {
            const reportId = req.params.reportId;
            const { signatureBase64 } = req.body;
            // `role: 'TECHNICIAN'` = Unterschrift des Technikers selbst; sie
            // schliesst den Rapport NICHT ab und löst keine Meldung aus.
            const technician = String(req.body.role || "").toUpperCase() === "TECHNICIAN";
            const report = await prisma_client_1.default.projectReport.findFirst({
                where: { id: reportId, project: { tenantId: req.user.tenantId } },
                select: { id: true, projectId: true },
            });
            if (!report)
                return res.status(404).json({ error: "Saha raporu bulunamadı." });
            await this.reportRepository.signReport(reportId, signatureBase64, technician ? 'TECHNICIAN' : 'CUSTOMER');
            await this.writeReportLog(reportId, req.user.id, 'SIGNED');
            if (!technician) {
                void (0, projectEventNotifications_1.notifyProjectEvent)({
                    tenantId: req.user.tenantId,
                    projectId: report.projectId,
                    event: 'SIGNATURE_RECEIVED',
                    report: 'FIELD',
                    reportId,
                    actorEmployeeId: req.user.id,
                });
            }
            res.status(200).json({ message: "Rapor imzalandı." });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async requestReportSignature(req, res) {
        try {
            const reportId = req.params.reportId;
            const channel = String(req.body.channel || "technician");
            const report = await prisma_client_1.default.projectReport.findFirst({
                where: { id: reportId, project: { tenantId: req.user.tenantId } },
                include: {
                    employee: { select: { id: true, firstName: true, lastName: true, email: true } },
                    project: { include: { customer: true } },
                    salesOrder: { select: { orderNumber: true } },
                },
            });
            if (!report)
                return res.status(404).json({ error: "Saha raporu bulunamadı." });
            const frontendUrl = process.env.OFFITEC_FRONTEND_URL || "http://localhost:5173";
            const reportLink = `${frontendUrl}/projects/${report.projectId}`;
            const sent = [];
            if ((channel === "technician" || channel === "both") && report.employeeId) {
                await this.notify({
                    tenantId: req.user.tenantId,
                    recipientEmployeeId: report.employeeId,
                    type: "PROJECT_REPORT_SIGNATURE_REQUEST",
                    title: "Müşteri imzası tekrar istendi",
                    message: `${report.project?.projectName || "Proje"} saha raporu için imza alınması gerekiyor.`,
                    linkUrl: "/projects/installation/tasks",
                    metadata: { projectId: report.projectId, reportId },
                });
                sent.push("technician");
            }
            if (channel === "mail" || channel === "both") {
                const settings = await prisma_client_1.default.mailSetting.findUnique({ where: { tenantId: await (0, serviceTenantScope_1.getMailTenantId)(req.user.tenantId) } });
                const to = String(req.body.to || report.project?.customer?.mainEmail || "").trim();
                const fromEmail = String(req.body.fromEmail || settings?.fromEmail || req.user.email || "").trim();
                const fromName = req.body.fromName || settings?.fromName || "Offitec ERP";
                const subject = String(req.body.subject || `${report.project?.projectName || "Proje"} - saha raporu imzası`).trim();
                const message = String(req.body.message || "Saha raporunuz imza için hazır. Lütfen Offitec ekibiyle birlikte raporu kontrol edip imzalayın.").trim();
                if (!to)
                    return res.status(400).json({ error: "Müşteri e-posta adresi bulunamadı." });
                if (!fromEmail)
                    return res.status(400).json({ error: "Gönderici e-posta adresi zorunludur." });
                await smtp.send(settings || {}, {
                    fromEmail,
                    fromName,
                    to,
                    subject,
                    text: `${message}\n\n${reportLink}`,
                    html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;line-height:1.6"><p>${message}</p><p><a href="${reportLink}" style="display:inline-block;background:#1d4ed8;color:white;padding:10px 14px;border-radius:6px;text-decoration:none">Raporu goruntule</a></p><p style="font-size:12px;color:#64748b">${reportLink}</p></div>`,
                    replyTo: req.body.replyTo || settings?.replyTo || null,
                });
                sent.push("mail");
            }
            res.status(200).json({ message: "İmza isteği gönderildi.", sent });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async completeInstallation(req, res, options = {}) {
        try {
            const appointmentId = String(req.params.appointmentId || req.body.appointmentId || "");
            const isManagerCompletion = Boolean(options.allowManagerComplete);
            const appointment = await prisma_client_1.default.appointment.findFirst({
                where: {
                    id: appointmentId,
                    tenantId: req.user.tenantId,
                    ...(isManagerCompletion ? {} : {
                        OR: [
                            { assignedTechId: req.user.id },
                            { technicianAssignments: { some: { technicianId: req.user.id } } },
                        ],
                    }),
                    projectId: { not: null },
                },
                include: {
                    salesOrder: true,
                    project: { include: { salesOrders: { orderBy: { createdAt: "asc" } }, customer: true, manager: true } },
                },
            });
            if (!appointment?.project)
                return res.status(404).json({ error: "Montaj randevusu bulunamadı." });
            if (startOfDay(new Date(appointment.startTime)).getTime() > startOfDay(new Date()).getTime()) {
                return res.status(400).json({ error: "Montaj gunu gelmeden rapor kapatilamaz." });
            }
            const operationItems = Array.isArray(req.body.operationsDoneItems)
                ? req.body.operationsDoneItems.map(String).map((item) => item.trim()).filter(Boolean)
                : [];
            const operationsDone = operationItems.length
                ? operationItems.map((item) => `- ${item}`).join("\n")
                : String(req.body.operationsDone || "").trim()
                    // Managers can finish directly without filling anything in; record a standard note.
                    || (isManagerCompletion ? "Saha çalışması yönetici tarafından tamamlandı." : "");
            if (!operationsDone)
                return res.status(400).json({ error: "Yapilan isler zorunludur." });
            const salesOrderId = appointment.salesOrderId ? String(appointment.salesOrderId) : null;
            if (salesOrderId && !appointment.project.salesOrders.some((order) => order.id === salesOrderId)) {
                return res.status(400).json({ error: "Sipariş bu projeye ait değil." });
            }
            // Field work belongs to its day: the report may end at the latest by midnight of the appointment day.
            const dayEnd = endOfDay(new Date(appointment.startTime));
            let endedAt = req.body.endedAt ? new Date(req.body.endedAt) : new Date();
            const startedAt = req.body.startedAt ? new Date(req.body.startedAt) : new Date(appointment.startTime);
            if (Number.isNaN(endedAt.getTime()) || Number.isNaN(startedAt.getTime())) {
                return res.status(400).json({ error: "Geçerli başlangıç ve bitiş zamanı girin." });
            }
            if (endedAt > dayEnd)
                endedAt = dayEnd;
            const reportEmployeeId = isManagerCompletion ? (appointment.assignedTechId || req.user.id) : req.user.id;
            const workDate = startOfDay(new Date(appointment.startTime));
            // A day can only hold one field report per order. If one already exists, reuse it and just
            // close the appointment instead of failing with "a report already exists".
            const isPrimaryOrder = (appointment.project.salesOrders?.[0]?.id || null) === (salesOrderId || null);
            // Prefer this appointment's own report (e.g. a manager-drafted one) so completing
            // it reuses that report. Only fall back to the legacy order/day lookup for reports
            // that carry NO appointmentId — a report already stamped to a sibling appointment
            // must never be stolen/re-stamped, so this appointment gets its own report instead.
            const ownReport = await this.reportRepository.findByAppointmentId(appointment.id);
            const legacyDayReport = ownReport
                ? null
                : await this.reportRepository.findByProjectAndWorkDate(appointment.projectId, workDate, salesOrderId ?? undefined, isPrimaryOrder);
            const existingReport = ownReport || (legacyDayReport && !legacyDayReport.appointmentId ? legacyDayReport : null);
            const reportPayload = {
                projectId: appointment.projectId,
                salesOrderId,
                appointmentId: appointment.id,
                employeeId: reportEmployeeId,
                workDate: workDate.toISOString(),
                startedAt: startedAt.toISOString(),
                endedAt: endedAt.toISOString(),
                operationsDone,
                technicalNotes: req.body.technicalNotes,
                images: Array.isArray(req.body.images) ? req.body.images.map(String) : undefined,
                projectContext: appointment.project,
                duplicateCheckCompleted: true,
            };
            // When a report already exists (e.g. a manager-drafted one), a technician
            // finishing the montaj applies their own field-report content to it — the
            // technician did the work, so their entry is the record of truth. A manager
            // just marking the job done reuses the report untouched, so their explicit
            // "Finish" never overwrites the report body with a default note.
            const reportResult = existingReport
                ? (isManagerCompletion
                    ? (await this.reportRepository.findSaveResultById(existingReport.id) || existingReport)
                    : await this.addReportUseCase.update(existingReport.id, reportPayload))
                : await this.addReportUseCase.execute(reportPayload);
            // Der neue Client schickt den VOLLSTÄNDIGEN Ressourcen-Stand mit
            // `resourceMode: 'replace'` — dann ERSETZT der Abschluss den alten
            // Stand (der letzte Speicherstand gilt; nichts wird mehr angehängt
            // und damit doppelt "zusammengeführt"). Alt-Clients ohne die Flagge
            // behalten das bisherige Anhängeverhalten.
            if (req.body.resourceMode === 'replace') {
                await this.replaceAppointmentResources({
                    tenantId: req.user.tenantId,
                    projectId: appointment.projectId,
                    salesOrderId,
                    appointmentId: appointment.id,
                    reportId: reportResult.id,
                    employeeId: req.user.id,
                    expenses: Array.isArray(req.body.expenses) ? req.body.expenses : undefined,
                    extraMaterials: Array.isArray(req.body.materials) ? req.body.materials : undefined,
                    usedMaterials: Array.isArray(req.body.usedMaterials) ? req.body.usedMaterials : undefined,
                });
            }
            else {
                const cleanUsedMaterials = Array.isArray(req.body.usedMaterials) ? req.body.usedMaterials : [];
                const usedMaterialRows = [];
                for (const material of cleanUsedMaterials) {
                    const quantity = Number(material.quantity || 0);
                    if (!material.materialId || quantity <= 0)
                        continue;
                    const articleRecord = await prisma_client_1.default.article.findFirst({
                        where: { id: String(material.materialId), tenantId: req.user.tenantId },
                        select: { id: true, salePrice: true },
                    });
                    if (!articleRecord)
                        continue;
                    usedMaterialRows.push({
                        id: (0, nanoid_1.nanoid)(10),
                        reportId: reportResult.id,
                        articleId: articleRecord.id,
                        quantity,
                        costAtTime: Number(articleRecord.salePrice || 0),
                    });
                }
                if (usedMaterialRows.length) {
                    await prisma_client_1.default.reportMaterial.createMany({ data: usedMaterialRows });
                }
                const cleanExpenses = Array.isArray(req.body.expenses) ? req.body.expenses : [];
                for (const expense of cleanExpenses) {
                    // Tutar ZORUNLU DEĞİL: metni olan gider 0 bedelle de kaydedilir.
                    const amount = Number(expense.amount || 0);
                    if (!String(expense.expenseType || "").trim())
                        continue;
                    await this.addExpenseUseCase.execute(appointment.projectId, String(expense.expenseType).trim(), Number.isFinite(amount) && amount > 0 ? amount : 0, expense.description ? String(expense.description).trim() : "", salesOrderId, appointment.id);
                }
                const cleanMaterials = Array.isArray(req.body.materials) ? req.body.materials : [];
                for (const material of cleanMaterials) {
                    const quantity = Number(material.quantity || 0);
                    if (!material.materialId || quantity <= 0)
                        continue;
                    await this.requestVariationUseCase.execute(appointment.projectId, req.user.id, String(material.materialId), quantity, material.description ? String(material.description).trim() : "", salesOrderId, appointment.id);
                }
            }
            await this.writeReportLog(reportResult.id, req.user.id, 'COMPLETED');
            let report = reportResult;
            const signatureBase64 = typeof req.body.signatureBase64 === "string" ? req.body.signatureBase64 : "";
            // Der Techniker unterschreibt im Rapport-Editor selbst; sie reist mit
            // dem Abschluss mit, damit sie nicht beim "Abschliessen" verlorengeht.
            const technicianSignature = String(req.body.technicianSignature || "").startsWith("data:image/")
                ? String(req.body.technicianSignature)
                : null;
            if (technicianSignature) {
                await this.reportRepository.signReport(reportResult.id, technicianSignature, 'TECHNICIAN');
            }
            if (signatureBase64) {
                await this.reportRepository.signReport(reportResult.id, signatureBase64);
            }
            if (signatureBase64 || technicianSignature) {
                report = await this.reportRepository.findById(reportResult.id) || reportResult;
            }
            await prisma_client_1.default.appointment.update({
                where: { id: appointment.id },
                data: { status: "COMPLETED" },
            });
            // Finishing as administrator also approves the report's worked-hours / overtime.
            if (isManagerCompletion) {
                await prisma_client_1.default.projectReport.update({
                    where: { id: reportResult.id },
                    data: { hoursApprovedAt: new Date(), hoursApprovedById: req.user.id, autoApproved: false },
                });
            }
            const parentSalesOrderId = appointment.salesOrder?.parentSalesOrderId || salesOrderId || appointment.project.salesOrders?.[0]?.id || null;
            // Addon order/request + manager notification are best-effort side-effects:
            // the montaj report is already saved, so a failure here (e.g. missing
            // migration) must never abort the completion the technician just performed.
            let addon = null;
            let addonRequest = null;
            try {
                // Managers may finalize the addon order directly; a technician finishing
                // the montaj only raises a request that the manager acts on.
                if (parentSalesOrderId && isManagerCompletion) {
                    addon = await this.createAddonOrderForParent(appointment.project, parentSalesOrderId, req.user.id, new Date(appointment.startTime));
                }
                else if (parentSalesOrderId && !isManagerCompletion) {
                    addonRequest = await this.createAddonRequestForParent(appointment.project, parentSalesOrderId, req.user.id, appointment.id);
                }
                await this.notifyProjectManagers(appointment.project, {
                    type: isManagerCompletion ? "PROJECT_INSTALLATION_MANAGER_COMPLETED" : signatureBase64 ? "PROJECT_INSTALLATION_COMPLETED" : "PROJECT_INSTALLATION_UNSIGNED",
                    title: isManagerCompletion ? "Montaj yönetici tarafından bitirildi" : signatureBase64 ? "Montaj tamamlandı" : "Montaj imzasız geldi",
                    message: isManagerCompletion
                        ? `${appointment.project.projectName} montajı yönetici tarafından bitirildi.`
                        : `${appointment.project.projectName} montajı teknisyen tarafından bitirildi${signatureBase64 ? "." : ", müşteri imzası yok."}`,
                    linkUrl: `/projects/${appointment.projectId}`,
                    metadata: { projectId: appointment.projectId, appointmentId: appointment.id, reportId: reportResult.id, addonSalesOrderId: addon?.salesOrder?.id || null, addonRequestId: addonRequest?.request?.id || null },
                });
            }
            catch (sideEffectError) {
                console.error("[completeInstallation] addon/notify side-effect failed:", sideEffectError?.message || sideEffectError);
            }
            res.status(201).json({
                message: isManagerCompletion ? "Montaj yönetici tarafından bitirildi." : signatureBase64 ? "Montaj tamamlandı ve imza alındı." : "Montaj imzasız tamamlandı.",
                report,
                addonOrder: addon?.salesOrder || null,
                addonTotals: addon?.totals || null,
                addonRequest: addonRequest?.request || null,
                overtimeWarning: reportResult.overtimeWarning || null,
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async requestExtraMaterial(req, res) {
        try {
            const projectId = req.params.id;
            const employeeId = req.user.id;
            const { materialId, quantity, description } = req.body;
            const salesOrderId = await this.resolveProjectSalesOrderId(projectId, req.user.tenantId, req.body.salesOrderId);
            const appointmentId = req.body.appointmentId ? String(req.body.appointmentId) : null;
            const extraMaterial = await this.requestVariationUseCase.execute(projectId, employeeId, materialId, quantity, description, salesOrderId, appointmentId);
            res.status(201).json({ message: "Ek malzeme projeye eklendi.", extraMaterial });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async approveVariation(req, res) {
        try {
            const variationId = req.params.variationId;
            const managerId = req.user.id;
            const { isApproved } = req.body;
            const result = await this.approveVariationUseCase.execute(variationId, managerId, isApproved);
            res.status(200).json(result);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async addExpense(req, res) {
        try {
            const projectId = req.params.id;
            const { expenseType, amount, description } = req.body;
            const salesOrderId = await this.resolveProjectSalesOrderId(projectId, req.user.tenantId, req.body.salesOrderId);
            const appointmentId = req.body.appointmentId ? String(req.body.appointmentId) : null;
            const expense = await this.addExpenseUseCase.execute(projectId, expenseType, amount, description, salesOrderId, appointmentId);
            res.status(201).json({ message: "Harici gider eklendi.", expense });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async updateExpense(req, res) {
        try {
            const expense = await prisma_client_1.default.projectExpense.findUnique({
                where: { id: req.params.expenseId },
                include: { project: true },
            });
            if (!expense?.project || expense.project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Harici gider bulunamadı." });
            }
            const patch = {};
            // Sabit tür listesi KALDIRILDI: harici gider serbest metindir, tek
            // koşul boş olmamasıdır (bkz. AddProjectExpenseUseCase).
            if (req.body.expenseType !== undefined) {
                const expenseType = String(req.body.expenseType || "").trim();
                if (!expenseType) {
                    return res.status(400).json({ error: "Harici gider açıklaması zorunludur." });
                }
                patch.expenseType = expenseType;
            }
            // Tutar zorunlu değil: 0 da geçerlidir (bedel sonra girilebilir).
            if (req.body.amount !== undefined) {
                const amount = Number(req.body.amount);
                patch.amount = Number.isFinite(amount) && amount > 0 ? amount : 0;
            }
            if (req.body.description !== undefined) {
                patch.description = String(req.body.description || "").trim() || null;
            }
            if (req.body.salesOrderId !== undefined) {
                patch.salesOrderId = await this.resolveProjectSalesOrderId(expense.projectId, req.user.tenantId, req.body.salesOrderId);
            }
            const updated = await prisma_client_1.default.projectExpense.update({
                where: { id: expense.id },
                data: patch,
            });
            res.status(200).json({ message: "Harici gider güncellendi.", expense: updated });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async deleteExpense(req, res) {
        try {
            const expense = await prisma_client_1.default.projectExpense.findUnique({
                where: { id: req.params.expenseId },
                include: { project: true },
            });
            if (!expense?.project || expense.project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Harici gider bulunamadı." });
            }
            await prisma_client_1.default.projectExpense.delete({ where: { id: expense.id } });
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async updateExtraMaterial(req, res) {
        try {
            const existing = await prisma_client_1.default.projectExtraMaterial.findUnique({
                where: { id: req.params.extraMaterialId },
                include: { project: true, article: true },
            });
            if (!existing?.project || existing.project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Ek malzeme bulunamadı." });
            }
            // Draht-Feld heißt weiterhin `materialId`, trägt aber eine Artikel-Id.
            const articleId = req.body.materialId !== undefined
                ? String(req.body.materialId || "").trim()
                : existing.articleId;
            if (!articleId)
                return res.status(400).json({ error: "Malzeme seçimi zorunludur." });
            const quantity = req.body.quantity !== undefined ? Number(req.body.quantity || 0) : Number(existing.quantity || 0);
            if (quantity <= 0)
                return res.status(400).json({ error: "Miktar sıfırdan büyük olmalıdır." });
            const article = await prisma_client_1.default.article.findFirst({
                where: { id: articleId, tenantId: req.user.tenantId },
                select: { id: true, name: true, salePrice: true },
            });
            if (!article) {
                return res.status(404).json({ error: "Malzeme bulunamadı." });
            }
            const stock = await (0, articleStock_1.articleStockTotal)(prisma_client_1.default, article.id);
            const availableQuantity = stock + (article.id === existing.articleId ? Number(existing.quantity || 0) : 0);
            if (availableQuantity < quantity) {
                return res.status(400).json({ error: `[Stok uyarısı] ${article.name} için kayıtlı miktar yetersiz.` });
            }
            const salesOrderId = req.body.salesOrderId !== undefined
                ? await this.resolveProjectSalesOrderId(existing.projectId, req.user.tenantId, req.body.salesOrderId)
                : existing.salesOrderId;
            const unitPrice = req.body.unitPrice !== undefined
                ? Number(req.body.unitPrice || 0)
                : article.id === existing.articleId
                    ? Number(existing.unitPrice || 0)
                    : Number(article.salePrice || 0);
            if (unitPrice < 0)
                return res.status(400).json({ error: "Birim fiyat negatif olamaz." });
            const description = req.body.description !== undefined
                ? String(req.body.description || "").trim() || null
                : existing.description;
            const tenantId = req.user.tenantId;
            const employeeId = req.user.id;
            const updated = await prisma_client_1.default.$transaction(async (tx) => {
                const previousQuantity = Number(existing.quantity || 0);
                const restock = (restockArticleId, restockQuantity) => (0, articleStock_1.adjustArticleStock)(tx, {
                    tenantId, articleId: restockArticleId, employeeId, quantity: restockQuantity,
                    direction: 'IN', referenceId: existing.projectId, description: 'Zusatzmaterial iadesi',
                });
                const consume = (consumeQuantity) => (0, articleStock_1.adjustArticleStock)(tx, {
                    tenantId, articleId: article.id, employeeId, quantity: consumeQuantity,
                    direction: 'OUT', referenceId: existing.projectId, description: 'Zusatzmaterial',
                });
                if (existing.articleId !== article.id) {
                    await restock(existing.articleId, previousQuantity);
                    await consume(quantity);
                }
                else {
                    const diff = quantity - previousQuantity;
                    if (diff > 0)
                        await consume(diff);
                    else if (diff < 0)
                        await restock(article.id, Math.abs(diff));
                }
                return await tx.projectExtraMaterial.update({
                    where: { id: existing.id },
                    data: {
                        articleId: article.id,
                        salesOrderId,
                        quantity,
                        unitPrice,
                        description,
                    },
                    include: { article: true },
                });
            });
            // Eski istemci sözleşmesi: yanıt `material`/`materialId` adlarını korur.
            res.status(200).json({
                message: "Ek malzeme güncellendi.",
                extraMaterial: { ...updated, materialId: updated.articleId, material: updated.article },
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async deleteExtraMaterial(req, res) {
        try {
            const existing = await prisma_client_1.default.projectExtraMaterial.findUnique({
                where: { id: req.params.extraMaterialId },
                include: { project: true },
            });
            if (!existing?.project || existing.project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Ek malzeme bulunamadı." });
            }
            await prisma_client_1.default.$transaction(async (tx) => {
                await (0, articleStock_1.adjustArticleStock)(tx, {
                    tenantId: req.user.tenantId,
                    articleId: existing.articleId,
                    employeeId: req.user.id,
                    quantity: Number(existing.quantity || 0),
                    direction: 'IN',
                    referenceId: existing.projectId,
                    description: 'Zusatzmaterial iadesi',
                });
                await tx.projectExtraMaterial.delete({ where: { id: existing.id } });
            });
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // Admin/manager-facing: delete a project sales order. An addon (Nachtrag)
    // order releases its records on cancel (user request 2026-08-07): its extra
    // materials are RESTOCKED and removed, its expenses/reports/appointments are
    // re-stamped onto the parent order (field history survives and becomes
    // billable again). Any order that has been invoiced is rejected outright.
    // When a main order is removed its own scoped reports / expenses / extra
    // materials (restocked) / appointments are cleaned up too.
    /**
     * Projeyi TÜM operasyonel kayıtlarıyla siler (kullanıcı isteği; onay için
     * istemci "DELETE" yazdırır): raporlar (görselleri/malzemeleri cascade),
     * ek malzemeler (stok İADE edilir), giderler, randevular (atamalar cascade),
     * teslimat raporları, imza istekleri ve projenin TÜM siparişleri; faz /
     * varyasyon / ek sipariş istekleri projeyle birlikte cascade düşer. Teklif
     * ve sevkiyatlar SİLİNMEZ — projectId bağları koparılır (SetNull), teklif
     * yeniden dönüştürülebilir hâle gelir.
     *
     * Faturalanmış proje silinemez (iptal edilmiş fatura dahil) — sipariş
     * silmedeki kuralın aynısı.
     */
    async deleteProject(req, res) {
        try {
            const projectId = req.params.id;
            const tenantId = req.user.tenantId;
            const project = await prisma_client_1.default.project.findFirst({
                where: { id: projectId, tenantId },
                // tenderId: die Offerte des Projekts geht mit zurück in den Entwurf.
                select: { id: true, tenderId: true },
            });
            if (!project)
                return res.status(404).json({ error: "Proje bulunamadı." });
            const orders = await prisma_client_1.default.salesOrder.findMany({
                where: { projectId, tenantId },
                select: { id: true, tenderId: true, orderNumber: true },
            });
            const orderIds = orders.map((order) => order.id);
            const invoiceCount = await prisma_client_1.default.invoice.count({
                where: {
                    OR: [
                        { projectId },
                        ...(orderIds.length ? [{ salesOrderId: { in: orderIds } }] : []),
                    ],
                },
            });
            if (invoiceCount > 0) {
                return res.status(400).json({ error: "Faturalandırılmış bir proje silinemez." });
            }
            await prisma_client_1.default.$transaction(async (tx) => {
                // Stok iadesi silmeden ÖNCE — sipariş silmedeki kuralın aynısı.
                const extraMaterials = await tx.projectExtraMaterial.findMany({
                    where: { projectId },
                    select: { id: true, articleId: true, quantity: true },
                });
                for (const row of extraMaterials) {
                    await (0, articleStock_1.adjustArticleStock)(tx, {
                        tenantId: req.user.tenantId,
                        articleId: row.articleId,
                        employeeId: req.user.id,
                        quantity: Number(row.quantity || 0),
                        direction: 'IN',
                        referenceId: projectId,
                        description: 'Zusatzmaterial iadesi',
                    });
                }
                if (extraMaterials.length) {
                    await tx.projectExtraMaterial.deleteMany({ where: { projectId } });
                }
                // Raporlar randevulardan ÖNCE (rapor→randevu bağı var); rapor
                // görselleri ve malzemeleri cascade ile düşer.
                await tx.projectReport.deleteMany({ where: { projectId } });
                await tx.projectExpense.deleteMany({ where: { projectId } });
                await tx.appointment.deleteMany({ where: { projectId } });
                await tx.deliveryReport.deleteMany({ where: { projectId, tenantId } });
                await tx.signatureRequest.deleteMany({ where: { projectId, tenantId } });
                if (orderIds.length) {
                    await tx.salesOrder.deleteMany({ where: { id: { in: orderIds } } });
                }
                await tx.project.delete({ where: { id: projectId } });
                // Mit dem Projekt gehen seine Aufträge — also sind deren Offerten
                // wieder Entwurf und können erneut zu einem Auftrag werden. Die
                // Offerte des Projekts selbst ist dabei, auch wenn sie es nie bis
                // zu einem Auftrag geschafft hat.
                const orderNumbers = orders.map((order) => order.orderNumber).filter(Boolean).join(', ');
                await revertTendersToDraft(tx, tenantId, req.user.id, [project.tenderId, ...orders.map((order) => order.tenderId)], orderNumbers
                    ? `Proje silindi; ${orderNumbers} kaldirildi, teklif taslaga dondu.`
                    : 'Proje silindi; teklif taslaga dondu.');
                // Sicherheitsnetz: `Tender.projectId` ist kein Fremdschlüssel, eine
                // vergessene Verknüpfung zählte sonst weiter als «Auftrag».
                await tx.tender.updateMany({
                    where: { projectId, tenantId },
                    data: { projectId: null },
                });
            });
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async deleteSalesOrder(req, res) {
        try {
            const projectId = req.params.id;
            const salesOrderId = req.params.salesOrderId;
            const tenantId = req.user.tenantId;
            const order = await prisma_client_1.default.salesOrder.findFirst({
                where: { id: salesOrderId, projectId, tenantId },
            });
            if (!order)
                return res.status(404).json({ error: "Sipariş bu projeye ait değil." });
            const isAddon = Boolean(order.parentSalesOrderId);
            // Deleting a main order removes its addon orders with it, so the whole
            // family (order + addons) must be un-billed before anything is deleted.
            const addons = isAddon
                ? []
                : await prisma_client_1.default.salesOrder.findMany({
                    where: { parentSalesOrderId: order.id, projectId, tenantId },
                    select: { id: true },
                });
            const familyIds = [order.id, ...addons.map((addon) => addon.id)];
            const invoiceCount = await prisma_client_1.default.invoice.count({ where: { salesOrderId: { in: familyIds } } });
            if (invoiceCount > 0) {
                return res.status(400).json({ error: "Faturalandırılmış bir sipariş silinemez." });
            }
            await prisma_client_1.default.$transaction(async (tx) => {
                if (isAddon) {
                    // EK SİPARİŞ İPTALİ (kullanıcı isteği 2026-08-07): kullanılan
                    // ek malzemeler STOĞA İADE edilir. Yeni model ekleri kayıtlarını
                    // kendi id'siyle damgalı taşır; ESKİ ekler için aynı iade, üst
                    // siparişe damgalı kalmış ZAMAN DİLİMİ kayıtlarına uygulanır
                    // (önceki ek → bu ek; okuma tarafındaki pencereyle birebir).
                    const siblings = await tx.salesOrder.findMany({
                        where: { parentSalesOrderId: order.parentSalesOrderId, projectId, tenantId, NOT: { id: order.id } },
                        select: { id: true, createdAt: true },
                    });
                    const previousAddon = siblings
                        .filter((sibling) => new Date(sibling.createdAt).getTime() < new Date(order.createdAt).getTime())
                        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null;
                    const legacyWindow = {
                        salesOrderId: order.parentSalesOrderId,
                        addedAt: {
                            ...(previousAddon ? { gt: previousAddon.createdAt } : {}),
                            lte: order.createdAt,
                        },
                    };
                    const extraMaterials = await tx.projectExtraMaterial.findMany({
                        where: { projectId, OR: [{ salesOrderId: order.id }, legacyWindow] },
                        select: { id: true, articleId: true, quantity: true },
                    });
                    for (const row of extraMaterials) {
                        await (0, articleStock_1.adjustArticleStock)(tx, {
                            tenantId: req.user.tenantId,
                            articleId: row.articleId,
                            employeeId: req.user.id,
                            quantity: Number(row.quantity || 0),
                            direction: 'IN',
                            referenceId: projectId,
                            description: 'Zusatzmaterial iadesi',
                        });
                    }
                    if (extraMaterials.length) {
                        await tx.projectExtraMaterial.deleteMany({ where: { id: { in: extraMaterials.map((row) => row.id) } } });
                    }
                    // Gider, rapor ve randevular SİLİNMEZ — saha kaydı yok edilmez.
                    // Üst siparişe geri damgalanır ve bekleyen havuza döner; bir
                    // sonraki ek sipariş isterse yeniden faturalar.
                    const returnStamp = { salesOrderId: order.parentSalesOrderId };
                    await tx.projectExpense.updateMany({ where: { projectId, salesOrderId: order.id }, data: returnStamp });
                    await tx.projectReport.updateMany({ where: { projectId, salesOrderId: order.id }, data: returnStamp });
                    await tx.appointment.updateMany({ where: { projectId, salesOrderId: order.id }, data: returnStamp });
                }
                if (!isAddon) {
                    // Records normally carry the parent order id, but sweep the whole
                    // family in case anything was ever stamped with an addon id.
                    // Reports own their materials/images via onDelete: Cascade.
                    const reports = await tx.projectReport.findMany({
                        where: { projectId, salesOrderId: { in: familyIds } },
                        select: { id: true },
                    });
                    if (reports.length) {
                        await tx.projectReport.deleteMany({ where: { id: { in: reports.map((r) => r.id) } } });
                    }
                    // Restock every extra material before removing it.
                    const extraMaterials = await tx.projectExtraMaterial.findMany({
                        where: { projectId, salesOrderId: { in: familyIds } },
                        select: { id: true, articleId: true, quantity: true },
                    });
                    for (const row of extraMaterials) {
                        await (0, articleStock_1.adjustArticleStock)(tx, {
                            tenantId: req.user.tenantId,
                            articleId: row.articleId,
                            employeeId: req.user.id,
                            quantity: Number(row.quantity || 0),
                            direction: 'IN',
                            referenceId: projectId,
                            description: 'Zusatzmaterial iadesi',
                        });
                    }
                    if (extraMaterials.length) {
                        await tx.projectExtraMaterial.deleteMany({ where: { id: { in: extraMaterials.map((r) => r.id) } } });
                    }
                    await tx.projectExpense.deleteMany({ where: { projectId, salesOrderId: { in: familyIds } } });
                    // Appointment assignments cascade on Appointment delete.
                    await tx.appointment.deleteMany({ where: { projectId, salesOrderId: { in: familyIds } } });
                    // Addon orders carry no records of their own (they bill the parent's
                    // time slice, deleted above) — remove them entirely, not just zeroed.
                    if (addons.length) {
                        await tx.salesOrder.deleteMany({ where: { id: { in: addons.map((addon) => addon.id) } } });
                    }
                }
                await tx.salesOrder.delete({ where: { id: order.id } });
                // Ein gelöschter HAUPTauftrag lässt seine Offerte auftragslos
                // zurück — dieselbe Regel wie beim Projekt, sonst bliebe sie
                // gesperrt und stünde in der Liste unter «Auftrag». Nachträge
                // (`isAddon`) tragen keine Offerte und lassen den Hauptauftrag
                // stehen, da ändert sich nichts.
                if (!isAddon) {
                    await revertTendersToDraft(tx, tenantId, req.user.id, [order.tenderId], `${order.orderNumber} silindi; teklif taslaga dondu.`);
                }
            });
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    async createAddonOrder(req, res) {
        try {
            const projectId = req.params.id;
            const tenantId = req.user.tenantId;
            const employeeId = req.user.id;
            const rawParentSalesOrderId = String(req.body.parentSalesOrderId || req.body.salesOrderId || "").trim();
            if (!rawParentSalesOrderId)
                return res.status(400).json({ error: "Bağlı sipariş seçimi zorunludur." });
            const project = await this.projectRepository.findById(projectId);
            if (!project || project.tenantId !== tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }
            const selectedOrder = await prisma_client_1.default.salesOrder.findFirst({
                where: { id: rawParentSalesOrderId, projectId, tenantId },
            });
            if (!selectedOrder)
                return res.status(404).json({ error: "Sipariş bu projeye ait değil." });
            const parentSalesOrderId = selectedOrder.parentSalesOrderId || selectedOrder.id;
            const parentOrder = selectedOrder.parentSalesOrderId
                ? await prisma_client_1.default.salesOrder.findFirst({ where: { id: parentSalesOrderId, projectId, tenantId } })
                : selectedOrder;
            if (!parentOrder)
                return res.status(404).json({ error: "Ana sipariş bulunamadı." });
            const addons = await prisma_client_1.default.salesOrder.findMany({
                where: { parentSalesOrderId, projectId, tenantId },
                orderBy: [{ revisionNumber: 'desc' }, { createdAt: 'desc' }],
            });
            const previousAddon = addons[0] || null;
            const nextRevision = Math.max(0, ...addons.map((order) => Number(order.revisionNumber || 0))) + 1;
            const previousCreatedAt = previousAddon?.createdAt || null;
            const createdAtFilter = previousCreatedAt ? { gt: previousCreatedAt } : undefined;
            const [expenses, extraMaterials, reports] = await Promise.all([
                prisma_client_1.default.projectExpense.findMany({
                    where: {
                        projectId,
                        salesOrderId: parentSalesOrderId,
                        ...(createdAtFilter ? { expenseDate: createdAtFilter } : {}),
                    },
                }),
                prisma_client_1.default.projectExtraMaterial.findMany({
                    where: {
                        projectId,
                        salesOrderId: parentSalesOrderId,
                        ...(createdAtFilter ? { addedAt: createdAtFilter } : {}),
                    },
                }),
                prisma_client_1.default.projectReport.findMany({
                    where: {
                        projectId,
                        salesOrderId: parentSalesOrderId,
                        ...(createdAtFilter ? { reportDate: createdAtFilter } : {}),
                    },
                }),
            ]);
            const expenseTotal = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0);
            const materialTotal = extraMaterials.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
            const overtimeTotal = reports.reduce((sum, item) => sum + Number(item.overtimeCost || 0), 0);
            const totalAmount = expenseTotal + materialTotal + overtimeTotal;
            if (totalAmount <= 0) {
                return res.status(400).json({ error: "Ek sipariş oluşturmak için son ek siparişten sonra harici gider, ek malzeme veya ek işçilik maliyeti bulunamadı." });
            }
            // Date the addon to the appointment its billed extra work belongs to, even
            // when the manager creates it days later. createdAt still bounds the next slice.
            const resolvedOrderDate = await this.resolveAddonOrderDate(tenantId, { expenses, extraMaterials, reports });
            // Ek sipariş (Nachtrag) kodu kendi NT- serisinden gelir — bkz.
            // `createAddonOrderForParent`.
            const orderNumber = await (0, documentNumber_1.nextDocumentNumber)(tenantId, 'ADDON');
            const addonOrder = await prisma_client_1.default.salesOrder.create({
                data: {
                    id: (0, nanoid_1.nanoid)(10),
                    tenantId,
                    customerId: parentOrder.customerId || project.customerId,
                    tenderId: null,
                    projectId,
                    parentSalesOrderId,
                    revisionNumber: nextRevision,
                    orderNumber,
                    orderType: 'PROJECT_ADDON',
                    status: 'ORDERED',
                    totalAmount,
                    orderDate: resolvedOrderDate,
                    createdByEmployeeId: employeeId,
                },
                include: {
                    customer: { select: { id: true, companyName: true, mainEmail: true, mainPhone: true } },
                    tender: { select: { id: true, tenderNumber: true, status: true, projectId: true } },
                    createdBy: { select: { id: true, firstName: true, lastName: true, email: true } },
                },
            });
            // Any open technician requests for this parent are now fulfilled (best-effort).
            try {
                await prisma_client_1.default.projectAddonRequest.updateMany({
                    where: { projectId, tenantId, salesOrderId: parentSalesOrderId, status: "PENDING" },
                    data: { status: "HANDLED", resolvedById: employeeId, resolvedAt: new Date() },
                });
            }
            catch (markError) {
                console.error("[createAddonOrder] could not mark addon requests handled:", markError?.message || markError);
            }
            res.status(201).json({
                message: `${orderNumber} ek siparişi oluşturuldu.`,
                salesOrder: addonOrder,
                totals: { expenses: expenseTotal, extraMaterials: materialTotal, overtime: overtimeTotal, total: totalAmount },
            });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // Technician-facing: raise a request that the manager create an addon order
    // from the extra work accrued on a parent order. Does not create the order.
    async requestAddonOrder(req, res) {
        try {
            const projectId = req.params.id;
            const tenantId = req.user.tenantId;
            const project = await this.projectRepository.findById(projectId, tenantId);
            if (!project)
                return res.status(404).json({ error: "Proje bulunamadı." });
            const rawSalesOrderId = String(req.body.salesOrderId || req.body.parentSalesOrderId || "").trim();
            let parentSalesOrderId = rawSalesOrderId || null;
            if (parentSalesOrderId) {
                const order = await prisma_client_1.default.salesOrder.findFirst({ where: { id: parentSalesOrderId, projectId, tenantId } });
                if (!order)
                    return res.status(404).json({ error: "Sipariş bu projeye ait değil." });
                parentSalesOrderId = order.parentSalesOrderId || order.id;
            }
            else {
                parentSalesOrderId = project.salesOrders?.find((o) => !o.parentSalesOrderId)?.id || project.salesOrders?.[0]?.id || null;
            }
            if (!parentSalesOrderId)
                return res.status(400).json({ error: "Ek sipariş talebi için bağlı bir sipariş bulunamadı." });
            const result = await this.createAddonRequestForParent(project, parentSalesOrderId, req.user.id, req.body.appointmentId ? String(req.body.appointmentId) : null, req.body.note);
            if (!result) {
                return res.status(400).json({ error: "Ek sipariş talebi için harici gider, ek malzeme veya ek işçilik maliyeti bulunamadı." });
            }
            res.status(201).json({ message: "Ek sipariş talebi yöneticiye iletildi.", addonRequest: result.request, totals: result.totals });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    // Manager-facing: resolve (HANDLED / DISMISSED) a technician addon request.
    async resolveAddonRequest(req, res) {
        try {
            const requestId = req.params.requestId;
            const tenantId = req.user.tenantId;
            const nextStatus = String(req.body.status || "DISMISSED").toUpperCase();
            if (!["HANDLED", "DISMISSED", "PENDING"].includes(nextStatus)) {
                return res.status(400).json({ error: "Geçersiz talep durumu." });
            }
            const request = await prisma_client_1.default.projectAddonRequest.findFirst({ where: { id: requestId, tenantId } });
            if (!request)
                return res.status(404).json({ error: "Ek sipariş talebi bulunamadı." });
            const updated = await prisma_client_1.default.projectAddonRequest.update({
                where: { id: request.id },
                data: {
                    status: nextStatus,
                    resolvedById: nextStatus === "PENDING" ? null : req.user.id,
                    resolvedAt: nextStatus === "PENDING" ? null : new Date(),
                },
            });
            res.status(200).json({ message: "Ek sipariş talebi güncellendi.", addonRequest: updated });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /* Alles am Termin ausser der Uhrzeit. Steht getrennt, weil ein mehrtägiger
       Einsatz seine Zeiten je TAG mitbringt (parseAppointmentDays), Notiz und
       CC-Liste aber EINMAL für den ganzen Einsatz gelten. */
    parseAppointmentMeta(body) {
        // CC listesi gönderilmediyse undefined kalır (update mevcut değeri korur).
        const ccEmails = body.ccEmails === undefined
            ? undefined
            : (Array.isArray(body.ccEmails) ? body.ccEmails : String(body.ccEmails || "").split(","))
                .map((value) => String(value ?? "").trim())
                .filter((email, index, list) => email.includes("@") && list.indexOf(email) === index);
        return {
            notes: body.notes === undefined ? undefined : String(body.notes || "").trim() || null,
            ccEmails,
            /* KALENDER-ETIKETT (25.08.2026). Roh durchgereicht: geprueft wird
               es erst gegen den Mandanten (calendarLabelCatalog), und das
               braucht eine Abfrage -- hier wird nur gelesen, was ankam. */
            labelId: body.labelId,
        };
    }
    parseAppointmentBody(body) {
        const startTime = new Date(body.startTime);
        const endTime = new Date(body.endTime);
        if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime()) || endTime <= startTime) {
            throw new Error("Geçerli bir başlangıç ve bitiş saati girin.");
        }
        return { startTime, endTime, ...this.parseAppointmentMeta(body) };
    }
    // A customer may receive at most one field appointment per calendar day, regardless of project/order.
    async findCustomerSameDayAppointment(customerId, day, excludeAppointmentId) {
        if (!customerId)
            return null;
        return await prisma_client_1.default.appointment.findFirst({
            where: {
                customerId,
                projectId: { not: null },
                status: { in: ["BOOKED", "COMPLETED"] },
                ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
                startTime: { gte: startOfDay(day), lte: endOfDay(day) },
            },
        });
    }
    async findProjectAppointmentConflict(projectId, startTime, endTime, appointmentId, salesOrderId) {
        return await prisma_client_1.default.appointment.findFirst({
            where: {
                projectId,
                ...(salesOrderId !== undefined ? { salesOrderId } : {}),
                ...(appointmentId ? { id: { not: appointmentId } } : {}),
                startTime: { lt: endTime },
                endTime: { gt: startTime }
            }
        });
    }
    async findTechnicianScheduleConflict(technicianIds, startTime, endTime, tenantId, appointmentId) {
        return (0, technicianSchedule_1.findTechnicianScheduleConflict)(technicianIds, startTime, endTime, tenantId, { appointmentId });
    }
    appointmentTechnicianIdsFromBody(body, fallbackIds = []) {
        if (body.technicianIds !== undefined)
            return normalizeIdList(body.technicianIds);
        if (body.assignedTechId !== undefined)
            return normalizeIdList([body.assignedTechId]);
        return [...new Set(fallbackIds.filter(Boolean))];
    }
    async replaceProjectAppointmentAssignments(appointmentId, technicianIds) {
        const ids = [...new Set(technicianIds.filter(Boolean))];
        await prisma_client_1.default.$transaction(async (tx) => {
            await tx.projectAppointmentAssignment.deleteMany({ where: { appointmentId } });
            if (ids.length) {
                await tx.projectAppointmentAssignment.createMany({
                    data: ids.map((technicianId) => ({
                        id: (0, nanoid_1.nanoid)(10),
                        appointmentId,
                        technicianId,
                    })),
                    skipDuplicates: true,
                });
            }
        });
    }
    /**
     * POST /projects/:id/appointments
     *
     * EIN Einsatz, EIN oder MEHRERE Tage (24.08.2026). Im Körper stehen
     * entweder `startTime`/`endTime` (der einzelne Tag, wie bisher) oder
     * `days: [{ startTime, endTime }, …]` — dann entsteht je Tag eine Zeile,
     * alle unter derselben `seriesId`. Warum je Tag eine Zeile und nicht ein
     * Balken über die Woche: siehe appointmentSeries.ts.
     *
     * Geprüft wird ALLES VORHER: ein halb angelegter Einsatz (Montag steht,
     * Mittwoch ist besetzt) wäre schlimmer als eine klare Absage.
     *
     * DER BESETZTE TAG (01.09.2026, Vorgabe Samet: «wenn der Tag schon belegt
     * ist, soll der alte Eintrag gelöscht werden — mit einem Knopf, der löscht
     * und speichert»). Die Absage nennt seit heute die Zeilen, die im Weg
     * stehen (`replaceable`, siehe appointmentSeries.ts); schickt der Browser
     * sie als `replaceAppointmentIds` zurück, verschwinden sie in DERSELBEN
     * Transaktion, in der der neue Einsatz entsteht. Entweder beides oder
     * nichts — ein gelöschter alter Termin ohne neuen wäre das schlechteste
     * aller Ergebnisse.
     */
    async createAppointment(req, res) {
        try {
            const project = await this.projectRepository.findById(req.params.id);
            if (!project || project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Proje bulunamadı." });
            }
            const meta = this.parseAppointmentMeta(req.body);
            /* Ohne mitgeschicktes Etikett greift der Vorschlag der Rolle
               «geplanter Termin» -- ein neu gesetzter Termin steht bevor. Ist
               dieses Etikett ausgeblendet, bleibt der Termin ohne Etikett. */
            const labelId = await (0, calendarLabelCatalog_1.resolveNewLabelId)(project.tenantId, meta.labelId, 'PLANNED');
            const days = (0, appointmentSeries_1.parseAppointmentDays)(req.body);
            const salesOrderId = await this.resolveProjectSalesOrderId(project.id, req.user.tenantId, req.body.salesOrderId);
            const technicians = await this.validateProjectTechnicians(this.appointmentTechnicianIdsFromBody(req.body), req.user.tenantId);
            const technicianIds = technicians.map((technician) => technician.id);
            const responsibleTechnician = technicians[0] || null;
            /* Die Termine, die dem neuen Platz machen sollen. Sie kommen aus
               der vorigen Absage zurück — der Browser erfindet sie nicht. */
            const replaceIds = normalizeIdList(req.body?.replaceAppointmentIds);
            const replaced = replaceIds.length
                ? await prisma_client_1.default.appointment.findMany({
                    where: { id: { in: replaceIds }, tenantId: req.user.tenantId },
                    orderBy: { startTime: "asc" },
                    select: { id: true, projectId: true, salesOrderId: true, seriesId: true, startTime: true, endTime: true, status: true },
                })
                : [];
            if (replaced.length !== replaceIds.length) {
                return res.status(404).json({ error: "Ein zu ersetzender Termin wurde nicht gefunden." });
            }
            /* An einem abgeschlossenen Tag hängt geleistete Arbeit — Rapport,
               Spesen, Material. Er weicht keinem neuen Termin. */
            if (replaced.some((row) => row.status === "COMPLETED")) {
                return res.status(409).json({ error: "Ein bereits abgeschlossener Termin kann nicht ersetzt werden." });
            }
            /* Und weichen darf nur, was auf den geplanten Tagen liegt: das
               Anlegen eines Termins ist kein Weg, irgendeine andere Zeile
               mitzunehmen. */
            if (replaced.some((row) => !(0, appointmentSeries_1.blocksPlannedDays)(row, days))) {
                return res.status(400).json({ error: "Ein zu ersetzender Termin liegt nicht an den geplanten Tagen." });
            }
            await (0, appointmentSeries_1.assertDaysAvailable)({
                tenantId: req.user.tenantId,
                projectId: project.id,
                customerId: project.customerId,
                salesOrderId,
                technicianIds,
                days,
                // Was gleich weggeräumt wird, darf sich nicht selbst im Weg stehen.
                excludeAppointmentIds: replaceIds,
            });
            /* Die Absagen EINSAMMELN, solange die Zeilen noch da sind —
               verschickt werden sie erst, wenn alles durchgelaufen ist
               (dieselbe Reihenfolge wie beim Löschen eines Termins). */
            const cancellations = replaced.length
                ? await Promise.all(replaced.map((row) => (0, calendarMailService_1.buildAppointmentCancellation)(row.id)))
                : [];
            /* Alle Tage in EINEM Durchgang: `createMany` statt einer Anlage je
               Tag — bei vier Tagen wären das sonst acht Wartezeiten auf einer
               entfernten Datenbank, und der Transaktionsdeckel (5 s) rückt
               näher, je länger der Einsatz ist. */
            const appointmentIds = days.map(() => (0, nanoid_1.nanoid)(10));
            const seriesId = await prisma_client_1.default.$transaction(async (tx) => {
                /* ZUERST RÄUMEN, DANN SETZEN (01.09.2026). Der alte Termin geht
                   mit allem, was an ihm hängt; bleibt seine Serie leer, geht
                   die Klammer mit (und mit ihr die Terminunterlagen), sonst
                   wird der Rest neu durchnummeriert — «Tag 2 von 4» heisst
                   danach «Tag 2 von 3». */
                for (const row of replaced) {
                    await this.purgeAppointmentDay(tx, row, req.user.id, req.user.tenantId);
                }
                for (const oldSeriesId of [...new Set(replaced.map((row) => row.seriesId).filter(Boolean))]) {
                    const left = await tx.appointment.count({ where: { seriesId: oldSeriesId } });
                    if (left === 0)
                        await tx.appointmentSeries.delete({ where: { id: oldSeriesId } }).catch(() => null);
                    else
                        await (0, appointmentSeries_1.renumberSeries)(tx, oldSeriesId);
                }
                const id = await (0, appointmentSeries_1.createSeries)(tx, project.tenantId, req.body?.coverNote);
                await tx.appointment.createMany({
                    data: days.map((day, index) => ({
                        id: appointmentIds[index],
                        tenantId: project.tenantId,
                        projectId: project.id,
                        salesOrderId,
                        assignedTechId: responsibleTechnician?.id || null,
                        customerId: project.customerId,
                        startTime: day.startTime,
                        endTime: day.endTime,
                        notes: meta.notes ?? null,
                        ccEmails: meta.ccEmails ?? [],
                        labelId,
                        // Wer den Termin setzt, bekommt die automatische Teammail mit.
                        createdByEmployeeId: req.user.id,
                        status: "BOOKED",
                        isLocked: true,
                        seriesId: id,
                        dayIndex: index,
                    })),
                });
                if (technicianIds.length) {
                    await tx.projectAppointmentAssignment.createMany({
                        data: appointmentIds.flatMap((appointmentId) => technicianIds.map((technicianId) => ({
                            id: (0, nanoid_1.nanoid)(10),
                            appointmentId,
                            technicianId,
                        }))),
                        skipDuplicates: true,
                    });
                }
                return id;
            });
            /* Absage an alle Beteiligten des ERSETZTEN Termins: er verschwindet
               damit auch aus deren Outlook. Erst NACH der Transaktion — und
               mit den Daten, die vorher geladen wurden, denn die Zeile ist nun
               fort. Die Aufbietung für den neuen Einsatz folgt weiter unten. */
            for (const cancellation of cancellations) {
                (0, calendarMailService_1.queueAppointmentCancellation)(cancellation, req.user.id);
            }
            const appointments = await prisma_client_1.default.appointment.findMany({
                where: { id: { in: appointmentIds } },
                orderBy: { startTime: "asc" },
                include: {
                    assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } },
                    technicianAssignments: { include: { technician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } } } },
                },
            });
            /* DIE INTERNE AUFBIETUNG GEHT SOFORT RAUS (Vorgabe 19.08.2026): an das
               zugeteilte Team, die CC-Liste und die Person, die den Termin angelegt
               hat. Feuern und vergessen — ein stummer Mailserver darf das Anlegen
               nicht scheitern lassen; die Antwort wartet nicht darauf.

               EINE Mail für den GANZEN Einsatz, nicht eine je Tag (Vorgabe
               24.08.2026): sie trägt den Einsatzplan — «Tag 1, Montag …, 08:00
               bis 17:00» — und die Kalendereinträge aller Tage.

               An den KUNDEN geht weiterhin nichts von selbst: seine Einladung
               verlässt das Haus erst mit «Termin senden» (POST
               …/appointments/:id/send-invite), und nur dort reisen auch die
               Checklisten mit (die PDFs entstehen im Browser). */
            (0, calendarMailService_1.queueAppointmentTeamInvite)(appointmentIds[0], req.user.id);
            if (technicianIds.length) {
                await this.notifyMany(project.tenantId, technicianIds, {
                    type: "PROJECT_INSTALLATION_ASSIGNED",
                    title: "Yeni montaj randevusu",
                    message: `${project.projectName} montajı size atandı.`,
                    linkUrl: "/projects/installation/calendar",
                    metadata: { projectId: project.id, appointmentId: appointmentIds[0], seriesId, salesOrderId },
                });
            }
            /* Die Antwort ist der ERSTE Tag (daran hängen die Aufrufer, die
               einen einzelnen Termin erwarten) — plus die Serie und ihre Tage
               für alles, was den ganzen Einsatz meint. */
            res.status(201).json({ ...appointments[0], seriesId, days: appointments, replaced: replaced.length });
        }
        catch (error) {
            /* `replaceable` reist MIT der Absage: es sind die Zeilen, die im Weg
               stehen. Der Browser bietet damit «löschen und speichern» an und
               schickt sie als `replaceAppointmentIds` zurück (01.09.2026). */
            res.status(error?.status || 400).json({
                error: error.message,
                ...(error?.replaceable?.length ? { replaceable: error.replaceable } : {}),
            });
        }
    }
    async updateAppointment(req, res) {
        try {
            const appointment = await prisma_client_1.default.appointment.findUnique({
                where: { id: req.params.appointmentId },
                include: { project: true, technicianAssignments: true }
            });
            if (!appointment?.project || appointment.project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Randevu bulunamadı." });
            }
            const parsed = this.parseAppointmentBody(req.body);
            // Nicht mitgeschickt = unveraendert; ausdruecklich leer = ohne Etikett.
            const labelId = await (0, calendarLabelCatalog_1.sanitizeLabelId)(req.user.tenantId, parsed.labelId);
            const salesOrderId = await this.resolveProjectSalesOrderId(appointment.projectId, req.user.tenantId, req.body.salesOrderId || appointment.salesOrderId);
            const sameDayForCustomer = await this.findCustomerSameDayAppointment(appointment.customerId || appointment.project.customerId, parsed.startTime, appointment.id);
            if (sameDayForCustomer)
                return res.status(409).json({ error: "Bu müşteri için aynı güne ait başka bir randevu var. Bir günde tek randevu verilebilir." });
            const conflict = await this.findProjectAppointmentConflict(appointment.projectId, parsed.startTime, parsed.endTime, appointment.id, salesOrderId);
            if (conflict)
                return res.status(409).json({ error: "Bu proje için saat planı çakışıyor." });
            const fallbackTechnicianIds = [
                appointment.assignedTechId,
                ...((appointment.technicianAssignments || []).map((assignment) => assignment.technicianId)),
            ].filter(Boolean);
            const technicians = await this.validateProjectTechnicians(this.appointmentTechnicianIdsFromBody(req.body, fallbackTechnicianIds), req.user.tenantId);
            const technicianIds = technicians.map((technician) => technician.id);
            const responsibleTechnician = technicians[0] || null;
            const techConflict = await this.findTechnicianScheduleConflict(technicianIds, parsed.startTime, parsed.endTime, req.user.tenantId, appointment.id);
            if (techConflict)
                return res.status(409).json({ error: techConflict.message });
            const updated = await prisma_client_1.default.appointment.update({
                where: { id: appointment.id },
                data: {
                    startTime: parsed.startTime,
                    endTime: parsed.endTime,
                    salesOrderId,
                    assignedTechId: responsibleTechnician?.id || null,
                    notes: parsed.notes ?? appointment.notes,
                    ...(parsed.ccEmails !== undefined ? { ccEmails: parsed.ccEmails } : {}),
                    ...(labelId !== undefined ? { labelId } : {}),
                    status: "BOOKED",
                    isLocked: true
                },
                include: {
                    assignedTechnician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } },
                    technicianAssignments: { include: { technician: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, roleName: true } } } },
                }
            });
            await this.replaceProjectAppointmentAssignments(appointment.id, technicianIds);
            /* Ein Tag eines mehrtägigen Einsatzes kann durch das Verschieben vor
               oder hinter seine Geschwister rutschen — dann stimmt «Tag 2 von 4»
               nicht mehr. Die Nummerierung folgt immer dem Datum. */
            if (appointment.seriesId) {
                await (0, appointmentSeries_1.renumberSeries)(prisma_client_1.default, appointment.seriesId);
            }
            const previousIds = new Set(fallbackTechnicianIds);
            const addedIds = technicianIds.filter((id) => !previousIds.has(id));
            if (addedIds.length) {
                await this.notifyMany(appointment.project.tenantId, addedIds, {
                    type: "PROJECT_INSTALLATION_ASSIGNED",
                    title: "Montaj randevusu size atandı",
                    message: `${appointment.project.projectName} montajı için görevlendirildiniz.`,
                    linkUrl: "/projects/installation/calendar",
                    metadata: { projectId: appointment.projectId, appointmentId: appointment.id, salesOrderId },
                });
                /* WER NEU AUFGEBOTEN WIRD, ERFÄHRT ES AUCH PER MAIL (25.08.2026,
                   Vorgabe Samet: «nur wenn ein Termin zugeteilt wird — an die
                   Monteurin oder den CC»). Bisher bekam sie nur die Meldung im
                   Programm; wer den ganzen Tag draußen ist, sieht die nicht. */
                (0, calendarMailService_1.queueAppointmentTeamInvite)(appointment.id, req.user.id);
            }
            // Eine reine ZEITÄNDERUNG geht weiterhin NICHT von selbst raus: wer
            // den Kunden informieren will, sendet die Einladung erneut (gleiche
            // UID, höherer Zählstand — Outlook ersetzt dann den Eintrag). Und
            // das Team hört nur, wenn sich die Aufbietung wirklich ändert.
            res.status(200).json(updated);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /**
     * EINEN Tag samt allem, was an ihm hängt. Läuft INNERHALB der Transaktion
     * der Löschung — bei einem mehrtägigen Einsatz nacheinander für jeden Tag,
     * damit entweder der ganze Einsatz verschwindet oder gar nichts.
     */
    async purgeAppointmentDay(tx, appointment, employeeId, tenantId) {
        const dayStart = startOfDay(new Date(appointment.startTime));
        const dayEnd = endOfDay(new Date(appointment.startTime));
        const fallbackScope = {
            projectId: appointment.projectId,
            salesOrderId: appointment.salesOrderId || null,
            appointmentId: null,
        };
        const reports = await tx.projectReport.findMany({
            where: {
                OR: [
                    { appointmentId: appointment.id },
                    { ...fallbackScope, workDate: { gte: dayStart, lte: dayEnd } },
                ],
            },
            select: { id: true },
        });
        const reportIds = reports.map((report) => report.id);
        if (reportIds.length) {
            await tx.reportMaterial.deleteMany({ where: { reportId: { in: reportIds } } });
            await tx.projectReport.deleteMany({ where: { id: { in: reportIds } } });
        }
        await tx.projectExpense.deleteMany({
            where: {
                OR: [
                    { appointmentId: appointment.id },
                    { ...fallbackScope, expenseDate: { gte: dayStart, lte: dayEnd } },
                ],
            },
        });
        const extraMaterials = await tx.projectExtraMaterial.findMany({
            where: {
                OR: [
                    { appointmentId: appointment.id },
                    { ...fallbackScope, addedAt: { gte: dayStart, lte: dayEnd } },
                ],
            },
            select: { id: true, articleId: true, quantity: true },
        });
        for (const row of extraMaterials) {
            await (0, articleStock_1.adjustArticleStock)(tx, {
                tenantId,
                articleId: row.articleId,
                employeeId,
                quantity: Number(row.quantity || 0),
                direction: 'IN',
                referenceId: appointment.projectId,
                description: 'Zusatzmaterial iadesi',
            });
        }
        if (extraMaterials.length) {
            await tx.projectExtraMaterial.deleteMany({ where: { id: { in: extraMaterials.map((row) => row.id) } } });
        }
        await tx.appointment.delete({ where: { id: appointment.id } });
    }
    /**
     * DELETE /projects/appointments/:appointmentId[?scope=series]
     *
     * `scope=series` löscht den GANZEN mehrtägigen Einsatz, sonst nur diesen
     * einen Tag. Bleiben bei einem einzelnen Tag Geschwister übrig, wird der
     * Rest neu durchnummeriert («Tag 2 von 4» heisst danach «Tag 2 von 3»).
     */
    async deleteAppointment(req, res) {
        try {
            const appointment = await prisma_client_1.default.appointment.findUnique({
                where: { id: req.params.appointmentId },
                include: { project: true }
            });
            if (!appointment?.project || appointment.project.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Randevu bulunamadı." });
            }
            const wholeSeries = String(req.query.scope || "") === "series" && Boolean(appointment.seriesId);
            const targets = wholeSeries
                ? await prisma_client_1.default.appointment.findMany({
                    where: { seriesId: appointment.seriesId, tenantId: req.user.tenantId },
                    orderBy: { startTime: "asc" },
                    select: { id: true, projectId: true, salesOrderId: true, startTime: true },
                })
                : [appointment];
            // Die Absagen EINSAMMELN, solange die Zeilen noch da sind — verschickt
            // werden sie erst, wenn das Löschen wirklich durchgelaufen ist. Nur
            // für Termine, die je verschickt wurden (sonst null).
            const cancellations = await Promise.all(targets.map((target) => (0, calendarMailService_1.buildAppointmentCancellation)(target.id)));
            await prisma_client_1.default.$transaction(async (tx) => {
                for (const target of targets) {
                    await this.purgeAppointmentDay(tx, target, req.user.id, req.user.tenantId);
                }
                if (appointment.seriesId) {
                    // War es der letzte Tag, geht die Klammer mit — und mit ihr
                    // (per Fremdschlüssel) die Unterlagen des Einsatzes.
                    const left = wholeSeries ? 0 : await tx.appointment.count({ where: { seriesId: appointment.seriesId } });
                    if (left === 0)
                        await tx.appointmentSeries.delete({ where: { id: appointment.seriesId } }).catch(() => null);
                    else
                        await (0, appointmentSeries_1.renumberSeries)(tx, appointment.seriesId);
                }
            });
            // Absage an alle Beteiligten: der Termin verschwindet damit auch aus
            // deren Outlook. Erst NACH der erfolgreichen Löschung — und mit den
            // Daten, die vorher geladen wurden, denn die Zeile ist nun fort.
            for (const cancellation of cancellations) {
                (0, calendarMailService_1.queueAppointmentCancellation)(cancellation, req.user.id);
            }
            res.status(204).send();
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
    /* ── Mehrtägige Einsätze und Terminunterlagen (24.08.2026) ─────────── */
    /**
     * Der Termin, auf den ein Aufruf zeigt — im Rahmen dessen, was die
     * aufrufende Person sehen darf. Projektleitung sieht jeden Termin ihres
     * Mandanten, die Monteurin nur die, auf die sie eingeteilt ist.
     */
    async findScopedAppointment(req, opts = {}) {
        const where = {
            id: String(req.params.appointmentId || ""),
            tenantId: req.user.tenantId,
        };
        if (opts.technicianScope) {
            where.OR = [
                { assignedTechId: req.user.id },
                { technicianAssignments: { some: { technicianId: req.user.id } } },
            ];
        }
        return await prisma_client_1.default.appointment.findFirst({
            where,
            select: {
                id: true, tenantId: true, seriesId: true, dayIndex: true,
                projectId: true, salesOrderId: true, customerId: true,
                startTime: true, endTime: true, status: true, notes: true,
            },
        });
    }
    /** Darf diese Person die Unterlagen dieses Einsatzes sehen? */
    async assertSeriesReadable(seriesId, req, opts = {}) {
        const where = { seriesId, tenantId: req.user.tenantId };
        if (opts.technicianScope) {
            where.OR = [
                { assignedTechId: req.user.id },
                { technicianAssignments: { some: { technicianId: req.user.id } } },
            ];
        }
        const hit = await prisma_client_1.default.appointment.findFirst({ where, select: { id: true } });
        if (!hit)
            throw Object.assign(new Error("Termin nicht gefunden."), { status: 404 });
    }
    /**
     * GET /projects/appointments/:appointmentId/series
     *     /projects/technician/installations/:appointmentId/series
     *
     * Der ganze Einsatz: seine Tage mit den Zeiten je Tag, das Begleitwort und
     * die Unterlagen (nur die Angaben — der Inhalt kommt erst beim Öffnen).
     *
     * Ein Termin von vor dem 24.08.2026 hat noch keine Serie. Er bekommt hier
     * KEINE — ein Lesezugriff schreibt nicht; er wird als das ausgeliefert, was
     * er ist: ein Einsatz mit einem Tag und ohne Unterlagen.
     */
    async getAppointmentSeries(req, res, opts = {}) {
        try {
            const appointment = await this.findScopedAppointment(req, opts);
            if (!appointment)
                return res.status(404).json({ error: "Termin nicht gefunden." });
            if (!appointment.seriesId) {
                return res.status(200).json({
                    seriesId: null,
                    coverNote: null,
                    days: [{
                            id: appointment.id,
                            dayIndex: 0,
                            startTime: appointment.startTime,
                            endTime: appointment.endTime,
                            status: appointment.status,
                        }],
                    documents: [],
                });
            }
            const [series, days, documents] = await Promise.all([
                prisma_client_1.default.appointmentSeries.findUnique({
                    where: { id: appointment.seriesId },
                    select: { id: true, coverNote: true },
                }),
                prisma_client_1.default.appointment.findMany({
                    where: { seriesId: appointment.seriesId, tenantId: req.user.tenantId },
                    orderBy: { startTime: "asc" },
                    select: { id: true, dayIndex: true, startTime: true, endTime: true, status: true },
                }),
                prisma_client_1.default.appointmentDocument.findMany({
                    where: { seriesId: appointment.seriesId },
                    orderBy: { createdAt: "asc" },
                    select: appointmentSeries_1.documentListSelect,
                }),
            ]);
            res.status(200).json({
                seriesId: appointment.seriesId,
                coverNote: series?.coverNote ?? null,
                days,
                documents: await Promise.all(documents.map(appointmentDocumentDto)),
            });
        }
        catch (error) {
            res.status(error?.status || 400).json({ error: error.message });
        }
    }
    /**
     * PUT /projects/appointments/:appointmentId/series/days
     *
     * Der Einsatzplan, wie er sein SOLL: `days: [{ appointmentId?, startTime,
     * endTime }, …]`. Tage mit `appointmentId` werden fortgeschrieben, Tage
     * ohne kommen dazu, fehlende fallen weg — damit deckt EIN Aufruf beides ab,
     * «auf weitere Tage ausdehnen» und «die Zeiten eines Tages ändern».
     *
     * Geprüft wird wieder ALLES VORHER; geschrieben wird in EINER Transaktion.
     */
    async saveAppointmentSeriesDays(req, res) {
        try {
            const appointment = await prisma_client_1.default.appointment.findFirst({
                where: { id: String(req.params.appointmentId || ""), tenantId: req.user.tenantId },
                include: { project: { select: { id: true, tenantId: true, projectName: true, customerId: true } }, technicianAssignments: true },
            });
            if (!appointment?.project)
                return res.status(404).json({ error: "Termin nicht gefunden." });
            const seriesId = await (0, appointmentSeries_1.ensureSeriesId)(appointment);
            const existing = await prisma_client_1.default.appointment.findMany({
                where: { seriesId, tenantId: req.user.tenantId },
                orderBy: { startTime: "asc" },
                select: { id: true, projectId: true, salesOrderId: true, startTime: true, endTime: true, status: true },
            });
            const existingById = new Map(existing.map((row) => [row.id, row]));
            const days = (0, appointmentSeries_1.parseAppointmentDays)(req.body);
            if (!days.length)
                return res.status(400).json({ error: "Ein Einsatz braucht mindestens einen Tag." });
            for (const day of days) {
                if (day.appointmentId && !existingById.has(day.appointmentId)) {
                    return res.status(400).json({ error: "Ein Tag gehört nicht zu diesem Einsatz." });
                }
            }
            const keptIds = new Set(days.map((day) => day.appointmentId).filter(Boolean));
            const removed = existing.filter((row) => !keptIds.has(row.id));
            /* Ein Tag, an dem schon gearbeitet wurde, verschwindet nicht
               nebenbei: an ihm hängen Rapport, Spesen und Material. Wer ihn
               wirklich streichen will, löscht ihn ausdrücklich. */
            const finished = removed.find((row) => row.status === "COMPLETED");
            if (finished) {
                return res.status(409).json({ error: "Ein bereits abgeschlossener Tag kann nicht aus dem Einsatz entfernt werden." });
            }
            const fallbackTechnicianIds = [
                appointment.assignedTechId,
                ...((appointment.technicianAssignments || []).map((assignment) => assignment.technicianId)),
            ].filter(Boolean);
            const technicians = await this.validateProjectTechnicians(this.appointmentTechnicianIdsFromBody(req.body, fallbackTechnicianIds), req.user.tenantId);
            const technicianIds = technicians.map((technician) => technician.id);
            const responsibleTechnician = technicians[0] || null;
            await (0, appointmentSeries_1.assertDaysAvailable)({
                tenantId: req.user.tenantId,
                projectId: appointment.projectId,
                customerId: appointment.customerId || appointment.project.customerId,
                salesOrderId: appointment.salesOrderId ?? null,
                technicianIds,
                days,
                excludeAppointmentIds: existing.map((row) => row.id),
            });
            const cancellations = await Promise.all(removed.map((row) => (0, calendarMailService_1.buildAppointmentCancellation)(row.id)));
            const addedIds = [];
            await prisma_client_1.default.$transaction(async (tx) => {
                for (const day of days) {
                    if (day.appointmentId) {
                        const current = existingById.get(day.appointmentId);
                        if (new Date(current.startTime).getTime() === day.startTime.getTime()
                            && new Date(current.endTime).getTime() === day.endTime.getTime())
                            continue;
                        await tx.appointment.update({
                            where: { id: day.appointmentId },
                            data: { startTime: day.startTime, endTime: day.endTime },
                        });
                        continue;
                    }
                    const id = (0, nanoid_1.nanoid)(10);
                    addedIds.push(id);
                    await tx.appointment.create({
                        data: {
                            id,
                            tenantId: appointment.tenantId,
                            projectId: appointment.projectId,
                            salesOrderId: appointment.salesOrderId ?? null,
                            assignedTechId: responsibleTechnician?.id || null,
                            customerId: appointment.customerId || appointment.project.customerId,
                            startTime: day.startTime,
                            endTime: day.endTime,
                            notes: appointment.notes ?? null,
                            ccEmails: appointment.ccEmails ?? [],
                            createdByEmployeeId: appointment.createdByEmployeeId || req.user.id,
                            status: "BOOKED",
                            isLocked: true,
                            seriesId,
                        },
                    });
                    if (technicianIds.length) {
                        await tx.projectAppointmentAssignment.createMany({
                            data: technicianIds.map((technicianId) => ({ id: (0, nanoid_1.nanoid)(10), appointmentId: id, technicianId })),
                            skipDuplicates: true,
                        });
                    }
                }
                for (const row of removed) {
                    await this.purgeAppointmentDay(tx, row, req.user.id, req.user.tenantId);
                }
                await (0, appointmentSeries_1.renumberSeries)(tx, seriesId);
            });
            for (const cancellation of cancellations) {
                (0, calendarMailService_1.queueAppointmentCancellation)(cancellation, req.user.id);
            }
            /* GEMELDET WIRD DIE AUFBIETUNG, NICHT DIE PLANUNG (25.08.2026,
               Vorgabe Samet: «nicht bei jedem Speichern eine Mail — nur wenn
               ein Termin zugeteilt wird, an die Monteurin oder den CC»).

               Bis dahin ging bei JEDEM angehängten Tag eine Mail raus. Wer
               einen Einsatz zusammenstellt — Tag dazu, Unterlage dazu, Bild
               dazu, speichern — löste damit eine Mail nach der anderen aus,
               obwohl sich an der Aufbietung nichts geändert hatte.

               Jetzt zählt allein, ob jemand NEU aufgeboten wird. Tage, Zeiten,
               Begleitwort, Unterlagen und Bilder bleiben still. */
            const newlyAssigned = technicianIds.filter((id) => !fallbackTechnicianIds.includes(id));
            if (newlyAssigned.length)
                (0, calendarMailService_1.queueAppointmentTeamInvite)(appointment.id, req.user.id);
            const updated = await prisma_client_1.default.appointment.findMany({
                where: { seriesId, tenantId: req.user.tenantId },
                orderBy: { startTime: "asc" },
                select: { id: true, dayIndex: true, startTime: true, endTime: true, status: true },
            });
            res.status(200).json({ seriesId, days: updated, added: addedIds.length, removed: removed.length });
        }
        catch (error) {
            res.status(error?.status || 400).json({ error: error.message });
        }
    }
    /**
     * PATCH /projects/appointments/:appointmentId/series
     * Das Begleitwort an die Monteurin — der Zettel, der sonst am Auftrag
     * hinge. Es geht NICHT an den Kunden.
     */
    async saveAppointmentSeriesNote(req, res) {
        try {
            const appointment = await this.findScopedAppointment(req);
            if (!appointment)
                return res.status(404).json({ error: "Termin nicht gefunden." });
            const seriesId = await (0, appointmentSeries_1.ensureSeriesId)(appointment);
            const coverNote = req.body?.coverNote === undefined
                ? undefined
                : String(req.body.coverNote || "").trim().slice(0, 5000) || null;
            const series = await prisma_client_1.default.appointmentSeries.update({
                where: { id: seriesId },
                data: { ...(coverNote === undefined ? {} : { coverNote }) },
                select: { id: true, coverNote: true },
            });
            res.status(200).json({ seriesId: series.id, coverNote: series.coverNote });
        }
        catch (error) {
            res.status(error?.status || 400).json({ error: error.message });
        }
    }
    /**
     * POST /projects/appointments/:appointmentId/documents
     *
     * TERMINUNTERLAGEN (Vorgabe 24.08.2026): Begleitzettel, Bilder und PDF,
     * die die Monteurin am Termin braucht. Sie gehen an KEINEN Kunden und an
     * keine Einladung — sie stehen nur im Programm.
     */
    async addAppointmentDocument(req, res) {
        /* Die Datei liegt schon auf der Platte, wenn die Zeile scheitert —
           dann muss sie wieder weg, sonst bleibt eine Waise liegen. */
        let storedRef = null;
        try {
            const appointment = await this.findScopedAppointment(req);
            if (!appointment)
                return res.status(404).json({ error: "Termin nicht gefunden." });
            const upload = (0, appointmentSeries_1.sanitizeDocumentUpload)(req.body, req.file);
            /* DIE SCHNELLE REIHENFOLGE (24.08.2026): erst die Datei auf die
               Platte (das ist ein Schreibvorgang vor Ort), dann EINE kurze
               Zeile in die Datenbank. Die Serie wird nur angelegt, wenn es
               noch keine gibt — bei jedem weiteren Anhang entfällt auch das. */
            const [seriesId, stored] = await Promise.all([
                (0, appointmentSeries_1.ensureSeriesId)(appointment),
                LocalFileStorage_1.appointmentDocumentStorage.store(req.user.tenantId, upload.body, upload.contentType),
            ]);
            storedRef = LocalFileStorage_1.appointmentDocumentStorage.publicReadUrl(stored);
            if (!storedRef) {
                await LocalFileStorage_1.appointmentDocumentStorage.remove(stored).catch(() => undefined);
                throw Object.assign(new Error('R2_PUBLIC_URL ayarlanmamış; belge için kalıcı URL oluşturulamadı.'), { status: 503 });
            }
            const total = await prisma_client_1.default.appointmentDocument.aggregate({
                where: { seriesId },
                _sum: { sizeBytes: true },
            });
            if (Number(total?._sum?.sizeBytes || 0) + upload.sizeBytes > appointmentSeries_1.SERIES_DOCUMENT_LIMIT_BYTES) {
                // Geworfen, nicht zurückgegeben: nur so räumt der Fangzweig die
                // eben geschriebene Datei wieder weg.
                throw Object.assign(new Error(`Die Unterlagen eines Einsatzes dürfen zusammen höchstens ${Math.round(appointmentSeries_1.SERIES_DOCUMENT_LIMIT_BYTES / (1024 * 1024))} MB gross sein.`), { status: 400 });
            }
            const document = await prisma_client_1.default.appointmentDocument.create({
                data: {
                    id: (0, nanoid_1.nanoid)(12),
                    tenantId: req.user.tenantId,
                    seriesId,
                    fileName: upload.fileName,
                    contentType: upload.contentType,
                    sizeBytes: upload.sizeBytes,
                    fileRef: storedRef,
                    uploadedById: req.user.id,
                },
                select: appointmentSeries_1.documentListSelect,
            });
            storedRef = null;
            res.status(201).json({ seriesId, document: await appointmentDocumentDto(document) });
        }
        catch (error) {
            if (storedRef)
                await LocalFileStorage_1.appointmentDocumentStorage.remove(storedRef).catch(() => undefined);
            res.status(error?.status || 400).json({ error: error.message });
        }
    }
    /**
     * POST /projects/appointments/:appointmentId/documents/batch
     *
     * Alle in der Oberflaeche gemeinsam ausgewaehlten Dateien werden auch als
     * ein Paket gespeichert. Der alte Einzel-Endpunkt bleibt fuer Skripte und
     * andere Aufrufer bestehen; die Kalenderoberflaeche spart hier jedoch pro
     * weiterer Datei einen kompletten HTTP-/Auth-/DB-Durchlauf.
     */
    async addAppointmentDocuments(req, res) {
        const requestStartedAt = Date.now();
        const storedRefs = [];
        try {
            const files = Array.isArray(req.files) ? req.files : [];
            if (!files.length)
                return res.status(400).json({ error: "Mindestens eine Unterlage ist erforderlich." });
            // Erst das gesamte Paket pruefen. Eine ungueltige Datei darf nicht
            // dazu fuehren, dass die Dateien davor bereits sichtbar sind.
            const uploads = files.map((file) => (0, appointmentSeries_1.sanitizeDocumentUpload)({}, file));
            const incomingBytes = uploads.reduce((sum, upload) => sum + upload.sizeBytes, 0);
            if (incomingBytes > appointmentSeries_1.SERIES_DOCUMENT_LIMIT_BYTES) {
                return res.status(400).json({
                    error: `Die Unterlagen eines Einsatzes dürfen zusammen höchstens ${Math.round(appointmentSeries_1.SERIES_DOCUMENT_LIMIT_BYTES / (1024 * 1024))} MB gross sein.`,
                });
            }
            // Terminpruefung UND bisherige Gesamtgroesse in EINEM DB-Rundgang.
            // Bei der entfernten MariaDB kostet jeder zusaetzliche Rundgang
            // messbar Zeit; der Join benutzt den bestehenden seriesId-Index.
            const appointments = await prisma_client_1.default.$queryRaw(client_1.Prisma.sql `
                SELECT a.id AS id,
                       a.tenantId AS tenantId,
                       a.seriesId AS seriesId,
                       COALESCE(SUM(d.sizeBytes), 0) AS documentBytes
                FROM Appointment a
                LEFT JOIN AppointmentDocument d ON d.seriesId = a.seriesId
                WHERE a.id = ${String(req.params.appointmentId || "")}
                  AND a.tenantId = ${req.user.tenantId}
                GROUP BY a.id, a.tenantId, a.seriesId
            `);
            const appointment = appointments[0];
            if (!appointment)
                return res.status(404).json({ error: "Termin nicht gefunden." });
            const seriesId = await (0, appointmentSeries_1.ensureSeriesId)(appointment);
            if (Number(appointment.documentBytes || 0) + incomingBytes > appointmentSeries_1.SERIES_DOCUMENT_LIMIT_BYTES) {
                return res.status(400).json({
                    error: `Die Unterlagen eines Einsatzes dürfen zusammen höchstens ${Math.round(appointmentSeries_1.SERIES_DOCUMENT_LIMIT_BYTES / (1024 * 1024))} MB gross sein.`,
                });
            }
            const validationFinishedAt = Date.now();
            // Plattenschreibvorgaenge sind unabhaengig und duerfen parallel
            // laufen. Die Referenzen werden sofort festgehalten, damit bei
            // einem Teilfehler alle schon geschriebenen Dateien wegkommen.
            const stored = await Promise.allSettled(uploads.map(async (upload, index) => {
                const stored = await LocalFileStorage_1.appointmentDocumentStorage.store(req.user.tenantId, upload.body, upload.contentType);
                const url = LocalFileStorage_1.appointmentDocumentStorage.publicReadUrl(stored);
                if (!url) {
                    await LocalFileStorage_1.appointmentDocumentStorage.remove(stored).catch(() => undefined);
                    throw Object.assign(new Error('R2_PUBLIC_URL ayarlanmamış; belge için kalıcı URL oluşturulamadı.'), { status: 503 });
                }
                storedRefs[index] = url;
            }));
            const storeFailure = stored.find((result) => result.status === "rejected");
            if (storeFailure?.status === "rejected")
                throw storeFailure.reason;
            const storageFinishedAt = Date.now();
            const createdAt = new Date();
            const rows = uploads.map((upload, index) => ({
                id: (0, nanoid_1.nanoid)(12),
                tenantId: req.user.tenantId,
                seriesId,
                fileName: upload.fileName,
                contentType: upload.contentType,
                sizeBytes: upload.sizeBytes,
                fileRef: storedRefs[index],
                uploadedById: req.user.id,
                createdAt,
            }));
            // `createMany` ist selbst EINE atomare INSERT-Anweisung. Eine
            // interaktive Transaktion plus anschliessendes SELECT wuerden nur
            // BEGIN/SELECT/COMMIT-Netzrundgaenge addieren. Alle Felder fuer die
            // schlanke Antwort liegen bereits sicher im Speicher.
            await prisma_client_1.default.appointmentDocument.createMany({ data: rows });
            /* Die Antwort traegt dieselbe Adresse wie die Liste (01.09.2026):
               der gespeicherte Verweis geht nie roh zum Browser, displayUrl()
               macht daraus den Namen, der dort ankommt. */
            const signedUrls = await Promise.all(rows.map((row) => (LocalFileStorage_1.appointmentDocumentStorage.displayUrl(row.fileRef, { contentType: row.contentType || undefined }))));
            const documents = rows.map((row, index) => ({
                id: row.id,
                fileName: row.fileName,
                contentType: row.contentType,
                sizeBytes: row.sizeBytes,
                url: signedUrls[index] || row.fileRef,
                createdAt: row.createdAt,
                uploadedBy: {
                    id: req.user.id,
                    firstName: req.user.firstName || "",
                    lastName: req.user.lastName || "",
                },
            }));
            storedRefs.length = 0;
            const databaseFinishedAt = Date.now();
            res.setHeader("Server-Timing", `auth;dur=${Number(req.authDurMs ?? 0)}, rbac;dur=${Number(req.rbacDurMs ?? 0)}, validation;dur=${validationFinishedAt - requestStartedAt}, storage;dur=${storageFinishedAt - validationFinishedAt}, db-write;dur=${databaseFinishedAt - storageFinishedAt}, handler-total;dur=${databaseFinishedAt - requestStartedAt}`);
            res.status(201).json({ seriesId, documents });
        }
        catch (error) {
            await Promise.all(storedRefs.filter(Boolean).map((reference) => (LocalFileStorage_1.appointmentDocumentStorage.remove(reference).catch(() => undefined))));
            res.status(error?.status || 400).json({ error: error.message });
        }
    }
    /**
     * GET /projects/appointment-documents/:documentId
     *     /projects/technician/appointment-documents/:documentId
     * Der Inhalt einer Unterlage — als Daten-URI, wie er abgelegt wurde. Erst
     * hier reist der Anhang über die Leitung, nicht schon in der Liste.
     */
    async getAppointmentDocument(req, res, opts = {}) {
        try {
            const document = await prisma_client_1.default.appointmentDocument.findFirst({
                where: { id: String(req.params.documentId || ""), tenantId: req.user.tenantId },
            });
            if (!document)
                return res.status(404).json({ error: "Unterlage nicht gefunden." });
            await this.assertSeriesReadable(document.seriesId, req, opts);
            const url = await LocalFileStorage_1.appointmentDocumentStorage.displayUrl(document.fileRef, {
                contentType: document.contentType || undefined,
            });
            if (!url) {
                return res.status(409).json({ error: 'Bu belgenin dosyası okunabilir bir depoda değil.' });
            }
            res.status(200).json({
                id: document.id,
                fileName: document.fileName,
                contentType: document.contentType,
                sizeBytes: document.sizeBytes,
                createdAt: document.createdAt,
                url,
            });
        }
        catch (error) {
            res.status(error?.status || 400).json({ error: error.message });
        }
    }
    /** DELETE /projects/appointment-documents/:documentId */
    async deleteAppointmentDocument(req, res) {
        try {
            const document = await prisma_client_1.default.appointmentDocument.findFirst({
                where: { id: String(req.params.documentId || ""), tenantId: req.user.tenantId },
                select: { id: true, seriesId: true, fileRef: true },
            });
            if (!document)
                return res.status(404).json({ error: "Unterlage nicht gefunden." });
            await this.assertSeriesReadable(document.seriesId, req);
            /* `deleteMany`, NICHT `delete` (25.08.2026). Zwischen dem Finden und
               dem Löschen liegt ein Netzweg: ein zweiter Klick auf denselben
               Papierkorb — oder dasselbe Fenster zweimal offen — findet die
               Zeile ebenfalls und löscht sie als Zweiter noch einmal. `delete`
               wirft dann P2025 ("Record to delete does not exist"), und der
               ganze Prisma-Fehler samt Codeausschnitt landete als 400 beim
               Browser. `deleteMany` zählt stattdessen: null getroffene Zeilen
               heißt, jemand war schneller — und das Ziel ist erreicht.
               Die Mandantengrenze steht mit in der Bedingung, damit sie auch
               für diesen Schreibvorgang gilt und nicht nur für den Fund. */
            await prisma_client_1.default.appointmentDocument.deleteMany({
                where: { id: document.id, tenantId: req.user.tenantId },
            });
            // Die Zeile ist weg — die Datei darf nicht liegen bleiben. Scheitert
            // das Löschen auf der Platte, ist die Unterlage trotzdem fort.
            await LocalFileStorage_1.appointmentDocumentStorage.remove(document.fileRef).catch(() => undefined);
            res.status(204).send();
        }
        catch (error) {
            res.status(error?.status || 400).json({ error: error.message });
        }
    }
    /**
     * POST /projects/appointments/:appointmentId/send-invite
     * «Termin senden» — DIE Stelle, an der die Kalender-Einladung rausgeht
     * (Vorgabe 19.08.2026: nie von selbst).
     *
     * Body: { to, cc[], subject?, message?, teamMail?, attachments[] }
     *   to/cc/subject/message  — die von Hand verfasste Mail an den KUNDEN.
     *   teamMail (Standard an) — zusätzlich die automatische Mail an das
     *                            Montageteam, die CC-Liste und die Person, die
     *                            den Termin angelegt hat.
     *   attachments            — die Checklisten des Projekts/Auftrags als PDF,
     *                            im Browser gezeichnet; sie hängen NUR an der
     *                            Teammail.
     * Wird abgewartet, damit das Fenster ein echtes Ergebnis zeigt.
     */
    async sendAppointmentInvite(req, res) {
        try {
            const appointment = await prisma_client_1.default.appointment.findUnique({
                where: { id: req.params.appointmentId },
                select: { id: true, tenantId: true },
            });
            if (!appointment || appointment.tenantId !== req.user.tenantId) {
                return res.status(404).json({ error: "Randevu bulunamadı." });
            }
            const cc = Array.isArray(req.body?.cc) ? req.body.cc.map((value) => String(value ?? "")) : [];
            const result = await (0, calendarMailService_1.sendAppointmentInvite)(appointment.id, req.user.id, {
                to: String(req.body?.to ?? ""),
                cc,
                subject: req.body?.subject ? String(req.body.subject) : null,
                message: req.body?.message ? String(req.body.message) : null,
                teamMail: req.body?.teamMail !== false,
                attachments: (0, calendarMailService_1.sanitizeInviteAttachments)(req.body?.attachments),
            });
            res.status(200).json(result);
        }
        catch (error) {
            res.status(error?.status || 400).json({ error: error.message });
        }
    }
}
exports.ProjectController = ProjectController;
//# sourceMappingURL=ProjectController.js.map