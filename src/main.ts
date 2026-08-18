import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './infrastructure/config/swagger.config';
import authRoutes     from './presentation/routes/auth.routes';
import employeeRoutes from './presentation/routes/employee.routes';
// Personalmodul (Neubau 16.08.2026): ersetzt die früheren Router
// attendance.routes.ts und leave.routes.ts vollständig.
import personnelRoutes from './presentation/routes/personnel.routes';
import tenantRoutes  from './presentation/routes/tenant.routes';
import customerRoutes from './presentation/routes/customer.routes';
import roleRoutes from './presentation/routes/role.routes';
import moduleProfileRoutes from './presentation/routes/moduleProfile.routes';
import tenderRoutes from './presentation/routes/tender.routes';
import articleRoutes from './presentation/routes/article.routes';
import inventoryRoutes from './presentation/routes/inventory.routes';
import projectRoutes from './presentation/routes/project.routes';
import bookingRoutes from './presentation/routes/booking.routes';
import mailRoutes from './presentation/routes/mail.routes';
import mailboxRoutes from './presentation/routes/mailbox.routes';
import checklistRoutes from './presentation/routes/checklist.routes';
import deliveryReportRoutes from './presentation/routes/delivery-report.routes';
import signatureRequestRoutes from './presentation/routes/signature-request.routes';
import logisticsRoutes from './presentation/routes/logistics.routes';
import regieRoutes from './presentation/routes/regie.routes';
import maintenanceRoutes from './presentation/routes/maintenance.routes';
import salesOrderRoutes from './presentation/routes/sales-order.routes';
import billingRoutes from './presentation/routes/billing.routes';
import notificationRoutes from './presentation/routes/notification.routes';
import meetingRoutes from './presentation/routes/meeting.routes';
import crmRoutes from './presentation/routes/crm.routes';
import crmTaskRoutes from './presentation/routes/crmTask.routes';
import formsRoutes from './presentation/routes/forms.routes';
import settingsGateRoutes from './presentation/routes/settingsGate.routes';
import reminderSettingsRoutes from './presentation/routes/reminderSettings.routes';
import authorizationRoutes from './presentation/routes/authorization.routes';
// Rollenvorlagen (Einstellungen → Berechtigungen) und der Kennwortwunsch aus
// dem eigenen Profil — beide neu am 17.08.2026.
import roleTemplateRoutes from './presentation/routes/roleTemplate.routes';
import passwordRequestRoutes from './presentation/routes/passwordRequest.routes';
import fxRoutes from './presentation/routes/fx.routes';
import filesRoutes from './presentation/routes/files.routes';
import dashboardRoutes from './presentation/routes/dashboard.routes';
import { startMaintenanceReminderService } from './infrastructure/services/MaintenanceReminderService';
import { startReminderEngine } from './infrastructure/services/ReminderEngine';
import { startImapCaptureService } from './infrastructure/services/ImapCaptureService';
import { globalErrorHandler } from './presentation/middlewares/ErrorHandlerMiddleware';
import prisma from './infrastructure/database/prisma.client';


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
// One reverse-proxy hop (nginx) in production: makes req.ip the real client
// address for rate limiting and audit logs instead of the proxy's.
app.set('trust proxy', 1);

// CORS: explicit allow-list only — never a wildcard and never origin
// reflection. Configure production origins via OFFITEC_CORS_ORIGINS
// (comma-separated); without it only the known frontend origins pass.
// Requests with no Origin header (same-origin, curl, server-to-server) are
// allowed — CORS only governs browsers doing cross-origin calls.
const corsAllowList = (process.env.OFFITEC_CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
const defaultCorsOrigins = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'https://demo.offitec.ch',
];
const allowedOrigins = corsAllowList.length ? corsAllowList : defaultCorsOrigins;
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('CORS: origin not allowed'));
    },
    credentials: true,
    // PATCH is included on top of the required set — this API mutates via PATCH.
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cookieParser());
// 'combined' plus the response time: the API has a 100-200 ms budget per
// endpoint against the remote database, so the one number that matters when
// reading the log must be in the log.
app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] :response-time ms'));
// 15 MB is the global upload/body ceiling (mirrors MAX_UPLOAD_BYTES).
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

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

for (const prefix of apiPrefixes) {
    app.use(`${prefix}/auth`, authRoutes);
    app.use(`${prefix}/employees`, employeeRoutes);
    // Berechtigungsseite — eigener Router auf demselben Pfad; seine Routen
    // ('/authorization/list', '/:id/authorization') sind zweigliedrig und
    // kollidieren deshalb nicht mit dem '/:id' des Personal-Routers davor.
    app.use(`${prefix}/employees`, authorizationRoutes);
    // Personalmodul: Liste, Stempeluhr, Schichtplan, Berichte, Anträge.
    app.use(`${prefix}/personnel`, personnelRoutes);
    app.use(`${prefix}/tenants`, tenantRoutes);
    app.use(`${prefix}/customers`, customerRoutes);
    app.use(`${prefix}/sales-orders`, salesOrderRoutes);
    app.use(`${prefix}/billing`, billingRoutes);
    app.use(`${prefix}/roles`, roleRoutes);
    // Eigener Pfad statt eines Unterwegs von /roles: dort steht bereits ein
    // '/:id', an dem '/templates' hängen bliebe.
    app.use(`${prefix}/role-templates`, roleTemplateRoutes);
    app.use(`${prefix}/password-requests`, passwordRequestRoutes);
    app.use(`${prefix}/module-profiles`, moduleProfileRoutes);
    app.use(`${prefix}/tenders`, tenderRoutes);
    app.use(`${prefix}/articles`, articleRoutes);
    app.use(`${prefix}/inventory`, inventoryRoutes);
    app.use(`${prefix}/projects`, projectRoutes);
    app.use(`${prefix}/booking`, bookingRoutes);
    app.use(`${prefix}/mail`, mailRoutes);
    // Firmenpostfach: Abruf vom eigenen Mailserver + Nachrichten (mailbox.routes.ts).
    app.use(`${prefix}/mail`, mailboxRoutes);
    app.use(`${prefix}/settings/checklists`, checklistRoutes);
    app.use(`${prefix}/delivery-reports`, deliveryReportRoutes);
    app.use(`${prefix}/signature-requests`, signatureRequestRoutes);
    app.use(`${prefix}/logistics`, logisticsRoutes);
    app.use(`${prefix}/maintenance`, maintenanceRoutes);
    app.use(`${prefix}/regie`, regieRoutes);
    app.use(`${prefix}/notifications`, notificationRoutes);
    app.use(`${prefix}/meetings`, meetingRoutes);
    app.use(`${prefix}/crm`, crmRoutes);
    app.use(`${prefix}/crm`, crmTaskRoutes);
    // Checklisten / Formulare / Vorlagen (CRM-Modul, siehe forms.routes.ts).
    app.use(`${prefix}/forms`, formsRoutes);
    app.use(`${prefix}/settings`, settingsGateRoutes);
    app.use(`${prefix}/settings/reminder-settings`, reminderSettingsRoutes);
    app.use(`${prefix}/fx`, fxRoutes);
    app.use(`${prefix}/files`, filesRoutes);
    app.use(`${prefix}/dashboard`, dashboardRoutes);
}

app.use(globalErrorHandler);

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`API Docs  -> http://localhost:${PORT}/api-docs`);
    console.log(`API Docs  -> http://localhost:${PORT}/backend/api-docs`);
    startMaintenanceReminderService();
    startReminderEngine();
    startImapCaptureService();
    // Open the remote-DB connection pool now instead of on the first request,
    // which otherwise pays the connection handshakes itself. Several parallel
    // probes force several pool connections open: batch saves fire their
    // guarded statements concurrently and each needs its own connection.
    Promise.all(Array.from({ length: 4 }, () => prisma.$queryRaw`SELECT 1`))
        .then(() => console.log('Database pool warmed up.'))
        .catch((error) => console.error('Database warm-up failed:', error));
});
