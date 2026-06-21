"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const swagger_config_1 = require("./infrastructure/config/swagger.config");
const auth_routes_1 = __importDefault(require("./presentation/routes/auth.routes"));
const employee_routes_1 = __importDefault(require("./presentation/routes/employee.routes"));
const leave_routes_1 = __importDefault(require("./presentation/routes/leave.routes"));
const tenant_routes_1 = __importDefault(require("./presentation/routes/tenant.routes"));
const customer_routes_1 = __importDefault(require("./presentation/routes/customer.routes"));
const attendance_routes_1 = __importDefault(require("./presentation/routes/attendance.routes"));
const role_routes_1 = __importDefault(require("./presentation/routes/role.routes"));
const tender_routes_1 = __importDefault(require("./presentation/routes/tender.routes"));
const article_routes_1 = __importDefault(require("./presentation/routes/article.routes"));
const inventory_routes_1 = __importDefault(require("./presentation/routes/inventory.routes"));
const project_routes_1 = __importDefault(require("./presentation/routes/project.routes"));
const booking_routes_1 = __importDefault(require("./presentation/routes/booking.routes"));
const mail_routes_1 = __importDefault(require("./presentation/routes/mail.routes"));
const checklist_routes_1 = __importDefault(require("./presentation/routes/checklist.routes"));
const delivery_report_routes_1 = __importDefault(require("./presentation/routes/delivery-report.routes"));
const signature_request_routes_1 = __importDefault(require("./presentation/routes/signature-request.routes"));
const logistics_routes_1 = __importDefault(require("./presentation/routes/logistics.routes"));
const regie_routes_1 = __importDefault(require("./presentation/routes/regie.routes"));
const maintenance_routes_1 = __importDefault(require("./presentation/routes/maintenance.routes"));
const sales_order_routes_1 = __importDefault(require("./presentation/routes/sales-order.routes"));
<<<<<<< HEAD
const billing_routes_1 = __importDefault(require("./presentation/routes/billing.routes"));
=======
>>>>>>> 16c911768b897682a1f0e461e228a105fcd606ae
const notification_routes_1 = __importDefault(require("./presentation/routes/notification.routes"));
const MaintenanceReminderService_1 = require("./infrastructure/services/MaintenanceReminderService");
const AuthMiddleware_1 = require("./presentation/middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("./presentation/middlewares/RbacMiddleware");
const prisma_client_1 = __importDefault(require("./infrastructure/database/prisma.client"));
const nanoid_1 = require("nanoid");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
const apiPrefixes = ['/api/v1', '/backend/api/v1'];
const swaggerUiOptions = {
    customSiteTitle: 'OFFITEC ERP API Docs',
    swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'list',
    },
};
const allowSwaggerUi = (_req, res, next) => {
    res.removeHeader('Content-Security-Policy');
    next();
};
app.set('etag', false);
app.use((0, cors_1.default)());
app.use((0, helmet_1.default)({ crossOriginResourcePolicy: false }));
app.use((0, morgan_1.default)('combined'));
app.use(express_1.default.json({ limit: '50mb' }));
app.use(express_1.default.urlencoded({ limit: '50mb', extended: true }));
app.use(apiPrefixes, (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});
app.use('/api-docs', allowSwaggerUi, swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swagger_config_1.swaggerSpec, swaggerUiOptions));
app.use('/backend/api-docs', allowSwaggerUi, swagger_ui_express_1.default.serve, swagger_ui_express_1.default.setup(swagger_config_1.swaggerSpec, swaggerUiOptions));
app.get(['/swagger.json', '/backend/swagger.json'], (_req, res) => {
    res.header('Content-Type', 'application/json');
    res.send(swagger_config_1.swaggerSpec);
});
app.get(['/health', '/backend/health'], (_req, res) => {
    res.status(200).json({ status: 'OK' });
});
const normalizeTenderRef = (value) => {
    const raw = String(value || '').trim();
    try {
        return decodeURIComponent(raw).trim();
    }
    catch {
        return raw;
    }
};
const tenantRootId = async (tenantId) => {
    let current = await prisma_client_1.default.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, parentTenantId: true, isActive: true },
    });
    if (!current?.isActive)
        return null;
    for (let depth = 0; current.parentTenantId && depth < 20; depth += 1) {
        const parent = await prisma_client_1.default.tenant.findUnique({
            where: { id: current.parentTenantId },
            select: { id: true, parentTenantId: true, isActive: true },
        });
        if (!parent?.isActive)
            return null;
        current = parent;
    }
    return current.id;
};
const canAccessTenant = async (targetTenantId, requestTenantId) => {
    if (targetTenantId === requestTenantId)
        return true;
    const [targetRootId, requestRootId] = await Promise.all([
        tenantRootId(targetTenantId),
        tenantRootId(requestTenantId),
    ]);
    return Boolean(targetRootId && requestRootId && targetRootId === requestRootId);
};
const findTenderForTenant = async (rawRef, tenantId) => {
    const tenderRef = normalizeTenderRef(rawRef);
    if (!tenderRef)
        return null;
    const byId = await prisma_client_1.default.tender.findUnique({
        where: { id: tenderRef },
        select: { id: true, tenantId: true },
    });
    if (byId && await canAccessTenant(byId.tenantId, tenantId))
        return byId;
    const byNumber = await prisma_client_1.default.tender.findMany({
        where: { tenderNumber: tenderRef },
        take: 50,
        select: { id: true, tenantId: true },
    });
    for (const candidate of byNumber) {
        if (await canAccessTenant(candidate.tenantId, tenantId))
            return candidate;
    }
    return null;
};
const registerTenderChatterRoutes = (prefix) => {
    app.get(`${prefix}/tenders/:id/chatter-summary`, AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), async (req, res) => {
        try {
            const tenantId = req.user.tenantId;
            const tender = await findTenderForTenant(String(req.params.id || ''), tenantId);
            if (!tender) {
                res.status(404).json({ error: 'Teklif bulunamadı.' });
                return;
            }
            const [noteCount, documentCount, logCount] = await prisma_client_1.default.$transaction([
                prisma_client_1.default.tenderActivityLog.count({
                    where: { tenderId: tender.id, actionType: 'TENDER_NOTE' },
                }),
                prisma_client_1.default.document.count({
                    where: { tenantId: tender.tenantId, relatedEntityId: tender.id, entityType: 'TENDER' },
                }),
                prisma_client_1.default.tenderActivityLog.count({
                    where: { tenderId: tender.id },
                }),
            ]);
            res.status(200).json({ noteCount, documentCount, logCount });
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    app.post(`${prefix}/tenders/:id/notes`, AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), async (req, res) => {
        try {
            const tenantId = req.user.tenantId;
            const employeeId = req.user.id;
            const noteText = String(req.body.noteText || '').trim();
            if (!noteText) {
                res.status(400).json({ error: 'Not içeriği boş olamaz.' });
                return;
            }
            const tender = await findTenderForTenant(String(req.params.id || ''), tenantId);
            if (!tender) {
                res.status(404).json({ error: 'Teklif bulunamadı.' });
                return;
            }
            const log = await prisma_client_1.default.tenderActivityLog.create({
                data: {
                    id: (0, nanoid_1.nanoid)(8),
                    tenantId: tender.tenantId,
                    tenderId: tender.id,
                    employeeId,
                    actionType: 'TENDER_NOTE',
                    fieldName: 'note',
                    oldValue: null,
                    newValue: noteText,
                    description: noteText,
                },
            });
            res.status(201).json(log);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    app.get(`${prefix}/tenders/:id/documents`, AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.view'), async (req, res) => {
        try {
            const tenantId = req.user.tenantId;
            const tender = await findTenderForTenant(String(req.params.id || ''), tenantId);
            if (!tender) {
                res.status(404).json({ error: 'Teklif bulunamadı.' });
                return;
            }
            const documents = await prisma_client_1.default.document.findMany({
                where: { tenantId: tender.tenantId, relatedEntityId: tender.id, entityType: 'TENDER' },
                orderBy: { fileName: 'asc' },
            });
            res.status(200).json(documents);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
    app.post(`${prefix}/tenders/:id/documents`, AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('tenders.manage'), async (req, res) => {
        try {
            const tenantId = req.user.tenantId;
            const employeeId = req.user.id;
            const fileName = String(req.body.fileName || '').trim();
            const fileUrl = String(req.body.fileUrl || '').trim();
            const fileType = String(req.body.fileType || '').trim().toLowerCase();
            const category = String(req.body.category || 'tender').trim() || 'tender';
            if (!fileName || !fileUrl || !fileType) {
                res.status(400).json({ error: 'Dosya adı, URL ve tür zorunludur.' });
                return;
            }
            const allowed = fileType === 'application/pdf'
                || fileType === 'image/png'
                || fileType === 'image/jpeg'
                || /\.pdf$/i.test(fileName)
                || /\.png$/i.test(fileName)
                || /\.jpe?g$/i.test(fileName);
            if (!allowed) {
                res.status(400).json({ error: 'Sadece PDF, PNG veya JPG dosyası eklenebilir.' });
                return;
            }
            const tender = await findTenderForTenant(String(req.params.id || ''), tenantId);
            if (!tender) {
                res.status(404).json({ error: 'Teklif bulunamadı.' });
                return;
            }
            const document = await prisma_client_1.default.document.create({
                data: {
                    id: (0, nanoid_1.nanoid)(8),
                    tenantId: tender.tenantId,
                    relatedEntityId: tender.id,
                    entityType: 'TENDER',
                    fileName,
                    fileUrl,
                    fileType,
                    category,
                    uploadedByEmployeeId: employeeId,
                },
            });
            await prisma_client_1.default.tenderActivityLog.create({
                data: {
                    id: (0, nanoid_1.nanoid)(8),
                    tenantId: tender.tenantId,
                    tenderId: tender.id,
                    employeeId,
                    actionType: 'TENDER_ATTACHMENT',
                    fieldName: 'attachment',
                    oldValue: null,
                    newValue: fileName,
                    description: `Ek dosya eklendi: ${fileName}`,
                },
            });
            res.status(201).json(document);
        }
        catch (error) {
            res.status(400).json({ error: error.message });
        }
    });
};
for (const prefix of apiPrefixes) {
    registerTenderChatterRoutes(prefix);
    app.use(`${prefix}/auth`, auth_routes_1.default);
    app.use(`${prefix}/employees`, employee_routes_1.default);
    app.use(`${prefix}/leaves`, leave_routes_1.default);
    app.use(`${prefix}/tenants`, tenant_routes_1.default);
    app.use(`${prefix}/customers`, customer_routes_1.default);
    app.use(`${prefix}/sales-orders`, sales_order_routes_1.default);
<<<<<<< HEAD
    app.use(`${prefix}/billing`, billing_routes_1.default);
=======
>>>>>>> 16c911768b897682a1f0e461e228a105fcd606ae
    app.use(`${prefix}/attendance`, attendance_routes_1.default);
    app.use(`${prefix}/roles`, role_routes_1.default);
    app.use(`${prefix}/tenders`, tender_routes_1.default);
    app.use(`${prefix}/articles`, article_routes_1.default);
    app.use(`${prefix}/inventory`, inventory_routes_1.default);
    app.use(`${prefix}/projects`, project_routes_1.default);
    app.use(`${prefix}/booking`, booking_routes_1.default);
    app.use(`${prefix}/mail`, mail_routes_1.default);
    app.use(`${prefix}/settings/checklists`, checklist_routes_1.default);
    app.use(`${prefix}/delivery-reports`, delivery_report_routes_1.default);
    app.use(`${prefix}/signature-requests`, signature_request_routes_1.default);
    app.use(`${prefix}/logistics`, logistics_routes_1.default);
    app.use(`${prefix}/maintenance`, maintenance_routes_1.default);
    app.use(`${prefix}/regie`, regie_routes_1.default);
    app.use(`${prefix}/notifications`, notification_routes_1.default);
}
app.use((err, _req, res, _next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`API Docs  -> http://localhost:${PORT}/api-docs`);
    console.log(`API Docs  -> http://localhost:${PORT}/backend/api-docs`);
    (0, MaintenanceReminderService_1.startMaintenanceReminderService)();
});
//# sourceMappingURL=main.js.map