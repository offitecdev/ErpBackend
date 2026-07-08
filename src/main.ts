import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './infrastructure/config/swagger.config';
import authRoutes     from './presentation/routes/auth.routes';
import employeeRoutes from './presentation/routes/employee.routes';
import leaveRoutes    from './presentation/routes/leave.routes';
import tenantRoutes  from './presentation/routes/tenant.routes';    
import customerRoutes from './presentation/routes/customer.routes';
import attendanceRoutes from './presentation/routes/attendance.routes';
import roleRoutes from './presentation/routes/role.routes';
import tenderRoutes from './presentation/routes/tender.routes';
import articleRoutes from './presentation/routes/article.routes';
import inventoryRoutes from './presentation/routes/inventory.routes';
import projectRoutes from './presentation/routes/project.routes';
import bookingRoutes from './presentation/routes/booking.routes';
import mailRoutes from './presentation/routes/mail.routes';
import checklistRoutes from './presentation/routes/checklist.routes';
import deliveryReportRoutes from './presentation/routes/delivery-report.routes';
import signatureRequestRoutes from './presentation/routes/signature-request.routes';
import logisticsRoutes from './presentation/routes/logistics.routes';
import regieRoutes from './presentation/routes/regie.routes';
import maintenanceRoutes from './presentation/routes/maintenance.routes';
import salesOrderRoutes from './presentation/routes/sales-order.routes';
import billingRoutes from './presentation/routes/billing.routes';
import notificationRoutes from './presentation/routes/notification.routes';
import { startMaintenanceReminderService } from './infrastructure/services/MaintenanceReminderService';
import { requireAuth } from './presentation/middlewares/AuthMiddleware';
import { requirePermission } from './presentation/middlewares/RbacMiddleware';
import prisma from './infrastructure/database/prisma.client';
import { nanoid } from 'nanoid';


const app  = express();
const PORT = process.env.PORT || 3000;
const apiPrefixes = ['/api/v1', '/backend/api/v1'];
const swaggerUiOptions = {
    customSiteTitle: 'OFFITEC ERP API Docs',
    swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'list',
    },
};
const allowSwaggerUi = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.removeHeader('Content-Security-Policy');
    next();
};

app.set('etag', false);

// Restrict cross-origin access to an explicit allow-list when configured via
// OFFITEC_CORS_ORIGINS (comma-separated). Falls back to permissive (any origin)
// only when the variable is unset, so existing/dev setups keep working — set it
// to the deployed frontend origin(s) in production.
const corsAllowList = (process.env.OFFITEC_CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
app.use(cors(
    corsAllowList.length
        ? {
            origin: (origin, callback) => {
                // Allow same-origin / non-browser requests (no Origin header).
                if (!origin || corsAllowList.includes(origin)) return callback(null, true);
                return callback(new Error('CORS: origin not allowed'));
            },
            credentials: true,
        }
        : {},
));
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan('combined'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(apiPrefixes, (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});


app.use('/api-docs', allowSwaggerUi, swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));
app.use('/backend/api-docs', allowSwaggerUi, swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));

app.get(['/swagger.json', '/backend/swagger.json'], (_req, res) => {
    res.header('Content-Type', 'application/json');
    res.send(swaggerSpec);
});


app.get(['/health', '/backend/health'], (_req, res) => {
    res.status(200).json({ status: 'OK' });
});

const normalizeTenderRef = (value?: string) => {
    const raw = String(value || '').trim();
    try {
        return decodeURIComponent(raw).trim();
    } catch {
        return raw;
    }
};

const tenantRootId = async (tenantId: string): Promise<string | null> => {
    let current: any = await (prisma as any).tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, parentTenantId: true, isActive: true },
    });

    if (!current?.isActive) return null;

    for (let depth = 0; current.parentTenantId && depth < 20; depth += 1) {
        const parent: any = await (prisma as any).tenant.findUnique({
            where: { id: current.parentTenantId },
            select: { id: true, parentTenantId: true, isActive: true },
        });
        if (!parent?.isActive) return null;
        current = parent;
    }

    return current.id;
};

const canAccessTenant = async (targetTenantId: string, requestTenantId: string) => {
    if (targetTenantId === requestTenantId) return true;
    const [targetRootId, requestRootId] = await Promise.all([
        tenantRootId(targetTenantId),
        tenantRootId(requestTenantId),
    ]);
    return Boolean(targetRootId && requestRootId && targetRootId === requestRootId);
};

const findTenderForTenant = async (rawRef: string, tenantId: string) => {
    const tenderRef = normalizeTenderRef(rawRef);
    if (!tenderRef) return null;

    const byId = await (prisma as any).tender.findUnique({
        where: { id: tenderRef },
        select: { id: true, tenantId: true },
    });
    if (byId && await canAccessTenant(byId.tenantId, tenantId)) return byId;

    const byNumber = await (prisma as any).tender.findMany({
        where: { tenderNumber: tenderRef },
        take: 50,
        select: { id: true, tenantId: true },
    });
    for (const candidate of byNumber) {
        if (await canAccessTenant(candidate.tenantId, tenantId)) return candidate;
    }
    return null;
};

const registerTenderChatterRoutes = (prefix: string) => {
    app.get(
        `${prefix}/tenders/:id/chatter-summary`,
        requireAuth,
        requirePermission('tenders.view'),
        async (req, res) => {
            try {
                const tenantId = req.user!.tenantId;
                const tender = await findTenderForTenant(String(req.params.id || ''), tenantId);
                if (!tender) {
                    res.status(404).json({ error: 'Teklif bulunamadı.' });
                    return;
                }

                const [noteCount, documentCount, logCount] = await prisma.$transaction([
                    (prisma as any).tenderActivityLog.count({
                        where: { tenderId: tender.id, actionType: 'TENDER_NOTE' },
                    }),
                    (prisma as any).document.count({
                        where: { tenantId: tender.tenantId, relatedEntityId: tender.id, entityType: 'TENDER' },
                    }),
                    (prisma as any).tenderActivityLog.count({
                        where: { tenderId: tender.id },
                    }),
                ]);

                res.status(200).json({ noteCount, documentCount, logCount });
            } catch (error: any) {
                res.status(400).json({ error: error.message });
            }
        }
    );

    app.post(
        `${prefix}/tenders/:id/notes`,
        requireAuth,
        requirePermission('tenders.manage'),
        async (req, res) => {
            try {
                const tenantId = req.user!.tenantId;
                const employeeId = req.user!.id;
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

                const log = await (prisma as any).tenderActivityLog.create({
                    data: {
                        id: nanoid(8),
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
            } catch (error: any) {
                res.status(400).json({ error: error.message });
            }
        }
    );

    app.get(
        `${prefix}/tenders/:id/documents`,
        requireAuth,
        requirePermission('tenders.view'),
        async (req, res) => {
            try {
                const tenantId = req.user!.tenantId;
                const tender = await findTenderForTenant(String(req.params.id || ''), tenantId);
                if (!tender) {
                    res.status(404).json({ error: 'Teklif bulunamadı.' });
                    return;
                }

                const documents = await (prisma as any).document.findMany({
                    where: { tenantId: tender.tenantId, relatedEntityId: tender.id, entityType: 'TENDER' },
                    orderBy: { fileName: 'asc' },
                });

                res.status(200).json(documents);
            } catch (error: any) {
                res.status(400).json({ error: error.message });
            }
        }
    );

    app.post(
        `${prefix}/tenders/:id/documents`,
        requireAuth,
        requirePermission('tenders.manage'),
        async (req, res) => {
            try {
                const tenantId = req.user!.tenantId;
                const employeeId = req.user!.id;
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

                const document = await (prisma as any).document.create({
                    data: {
                        id: nanoid(8),
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

                await (prisma as any).tenderActivityLog.create({
                    data: {
                        id: nanoid(8),
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
            } catch (error: any) {
                res.status(400).json({ error: error.message });
            }
        }
    );
};

for (const prefix of apiPrefixes) {
    registerTenderChatterRoutes(prefix);
    app.use(`${prefix}/auth`, authRoutes);
    app.use(`${prefix}/employees`, employeeRoutes);
    app.use(`${prefix}/leaves`, leaveRoutes);
    app.use(`${prefix}/tenants`, tenantRoutes);
    app.use(`${prefix}/customers`, customerRoutes);
    app.use(`${prefix}/sales-orders`, salesOrderRoutes);
    app.use(`${prefix}/billing`, billingRoutes);
    app.use(`${prefix}/attendance`, attendanceRoutes);
    app.use(`${prefix}/roles`, roleRoutes);
    app.use(`${prefix}/tenders`, tenderRoutes);
    app.use(`${prefix}/articles`, articleRoutes);
    app.use(`${prefix}/inventory`, inventoryRoutes);
    app.use(`${prefix}/projects`, projectRoutes);
    app.use(`${prefix}/booking`, bookingRoutes);
    app.use(`${prefix}/mail`, mailRoutes);
    app.use(`${prefix}/settings/checklists`, checklistRoutes);
    app.use(`${prefix}/delivery-reports`, deliveryReportRoutes);
    app.use(`${prefix}/signature-requests`, signatureRequestRoutes);
    app.use(`${prefix}/logistics`, logisticsRoutes);
    app.use(`${prefix}/maintenance`, maintenanceRoutes);
    app.use(`${prefix}/regie`, regieRoutes);
    app.use(`${prefix}/notifications`, notificationRoutes);
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`API Docs  -> http://localhost:${PORT}/api-docs`);
    console.log(`API Docs  -> http://localhost:${PORT}/backend/api-docs`);
    startMaintenanceReminderService();
});
