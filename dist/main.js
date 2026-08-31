"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const helmet_1 = __importDefault(require("helmet"));
const morgan_1 = __importDefault(require("morgan"));
const swagger_ui_express_1 = __importDefault(require("swagger-ui-express"));
const swagger_config_1 = require("./infrastructure/config/swagger.config");
const auth_routes_1 = __importDefault(require("./presentation/routes/auth.routes"));
const employee_routes_1 = __importDefault(require("./presentation/routes/employee.routes"));
// Personalmodul (Neubau 16.08.2026): ersetzt die früheren Router
// attendance.routes.ts und leave.routes.ts vollständig.
const personnel_routes_1 = __importDefault(require("./presentation/routes/personnel.routes"));
// Personalakte, Feiertage, Urlaubsanspruch und die Arbeitszeiterfassung
// (26.08.2026) - zweiter Router auf demselben Pfad, siehe dort.
const personnelHr_routes_1 = __importDefault(require("./presentation/routes/personnelHr.routes"));
const tenant_routes_1 = __importDefault(require("./presentation/routes/tenant.routes"));
const customer_routes_1 = __importDefault(require("./presentation/routes/customer.routes"));
const role_routes_1 = __importDefault(require("./presentation/routes/role.routes"));
const moduleProfile_routes_1 = __importDefault(require("./presentation/routes/moduleProfile.routes"));
const tender_routes_1 = __importDefault(require("./presentation/routes/tender.routes"));
const article_routes_1 = __importDefault(require("./presentation/routes/article.routes"));
const inventory_routes_1 = __importDefault(require("./presentation/routes/inventory.routes"));
const project_routes_1 = __importDefault(require("./presentation/routes/project.routes"));
const booking_routes_1 = __importDefault(require("./presentation/routes/booking.routes"));
const mail_routes_1 = __importDefault(require("./presentation/routes/mail.routes"));
const mailbox_routes_1 = __importDefault(require("./presentation/routes/mailbox.routes"));
const checklist_routes_1 = __importDefault(require("./presentation/routes/checklist.routes"));
const delivery_report_routes_1 = __importDefault(require("./presentation/routes/delivery-report.routes"));
const signature_request_routes_1 = __importDefault(require("./presentation/routes/signature-request.routes"));
const logistics_routes_1 = __importDefault(require("./presentation/routes/logistics.routes"));
const regie_routes_1 = __importDefault(require("./presentation/routes/regie.routes"));
const maintenance_routes_1 = __importDefault(require("./presentation/routes/maintenance.routes"));
const sales_order_routes_1 = __importDefault(require("./presentation/routes/sales-order.routes"));
const billing_routes_1 = __importDefault(require("./presentation/routes/billing.routes"));
const notification_routes_1 = __importDefault(require("./presentation/routes/notification.routes"));
const meeting_routes_1 = __importDefault(require("./presentation/routes/meeting.routes"));
const crm_routes_1 = __importDefault(require("./presentation/routes/crm.routes"));
const crmTask_routes_1 = __importDefault(require("./presentation/routes/crmTask.routes"));
const enquiry_routes_1 = __importStar(require("./presentation/routes/enquiry.routes"));
const crmActivity_routes_1 = __importDefault(require("./presentation/routes/crmActivity.routes"));
const forms_routes_1 = __importDefault(require("./presentation/routes/forms.routes"));
const settingsGate_routes_1 = __importDefault(require("./presentation/routes/settingsGate.routes"));
const reminderSettings_routes_1 = __importDefault(require("./presentation/routes/reminderSettings.routes"));
// Mengeneinheiten des Lagers (Einstellungen -> Module -> Lager -> Einheiten).
const measurementUnit_routes_1 = __importDefault(require("./presentation/routes/measurementUnit.routes"));
// Kalender-Etiketten (Kalender -> Leiste "Etiketten").
const calendarLabel_routes_1 = __importDefault(require("./presentation/routes/calendarLabel.routes"));
const authorization_routes_1 = __importDefault(require("./presentation/routes/authorization.routes"));
// Rollenvorlagen (Einstellungen → Berechtigungen) und der Kennwortwunsch aus
// dem eigenen Profil — beide neu am 17.08.2026.
const roleTemplate_routes_1 = __importDefault(require("./presentation/routes/roleTemplate.routes"));
const passwordRequest_routes_1 = __importDefault(require("./presentation/routes/passwordRequest.routes"));
const fx_routes_1 = __importDefault(require("./presentation/routes/fx.routes"));
// OSP-Integration (Offitec Selection Platform): Webhook, Belegliste der
// OSP-Seite, Statusmeldung zurück und der Offerten-Import (04.09.2026).
const osp_routes_1 = __importDefault(require("./presentation/routes/osp.routes"));
const files_routes_1 = __importDefault(require("./presentation/routes/files.routes"));
const dashboard_routes_1 = __importDefault(require("./presentation/routes/dashboard.routes"));
const MaintenanceReminderService_1 = require("./infrastructure/services/MaintenanceReminderService");
const ReminderEngine_1 = require("./infrastructure/services/ReminderEngine");
const ImapCaptureService_1 = require("./infrastructure/services/ImapCaptureService");
const caldavCalendarService_1 = require("./infrastructure/services/caldavCalendarService");
const ErrorHandlerMiddleware_1 = require("./presentation/middlewares/ErrorHandlerMiddleware");
const prisma_client_1 = __importDefault(require("./infrastructure/database/prisma.client"));
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
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin))
            return callback(null, true);
        return callback(new Error('CORS: origin not allowed'));
    },
    credentials: true,
    // PATCH is included on top of the required set — this API mutates via PATCH.
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.use((0, helmet_1.default)({ crossOriginResourcePolicy: false }));
app.use((0, cookie_parser_1.default)());
// 'combined' plus the response time: the API has a 100-200 ms budget per
// endpoint against the remote database, so the one number that matters when
// reading the log must be in the log.
app.use((0, morgan_1.default)(':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] :response-time ms'));
// 15 MB is the global upload/body ceiling (mirrors MAX_UPLOAD_BYTES).
app.use(express_1.default.json({ limit: '15mb' }));
app.use(express_1.default.urlencoded({ limit: '15mb', extended: true }));
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
for (const prefix of apiPrefixes) {
    app.use(`${prefix}/auth`, auth_routes_1.default);
    app.use(`${prefix}/employees`, employee_routes_1.default);
    // Berechtigungsseite — eigener Router auf demselben Pfad; seine Routen
    // ('/authorization/list', '/:id/authorization') sind zweigliedrig und
    // kollidieren deshalb nicht mit dem '/:id' des Personal-Routers davor.
    app.use(`${prefix}/employees`, authorization_routes_1.default);
    // Personalmodul: Liste, Stempeluhr, Schichtplan, Berichte, Anträge.
    app.use(`${prefix}/personnel`, personnel_routes_1.default);
    // Personalakte (Profil, Unterlagen, Urlaubskonto), Feiertage und die
    // Arbeitszeiterfassung. Eigener Router, dieselbe Adresse: seine Wege sind
    // anders benannt und kollidieren nicht mit denen davor.
    app.use(`${prefix}/personnel`, personnelHr_routes_1.default);
    app.use(`${prefix}/tenants`, tenant_routes_1.default);
    app.use(`${prefix}/customers`, customer_routes_1.default);
    app.use(`${prefix}/sales-orders`, sales_order_routes_1.default);
    app.use(`${prefix}/billing`, billing_routes_1.default);
    app.use(`${prefix}/roles`, role_routes_1.default);
    // Eigener Pfad statt eines Unterwegs von /roles: dort steht bereits ein
    // '/:id', an dem '/templates' hängen bliebe.
    app.use(`${prefix}/role-templates`, roleTemplate_routes_1.default);
    app.use(`${prefix}/password-requests`, passwordRequest_routes_1.default);
    app.use(`${prefix}/module-profiles`, moduleProfile_routes_1.default);
    app.use(`${prefix}/tenders`, tender_routes_1.default);
    app.use(`${prefix}/articles`, article_routes_1.default);
    app.use(`${prefix}/inventory`, inventory_routes_1.default);
    app.use(`${prefix}/projects`, project_routes_1.default);
    app.use(`${prefix}/booking`, booking_routes_1.default);
    app.use(`${prefix}/mail`, mail_routes_1.default);
    // Firmenpostfach: Abruf vom eigenen Mailserver + Nachrichten (mailbox.routes.ts).
    app.use(`${prefix}/mail`, mailbox_routes_1.default);
    app.use(`${prefix}/settings/checklists`, checklist_routes_1.default);
    app.use(`${prefix}/delivery-reports`, delivery_report_routes_1.default);
    app.use(`${prefix}/signature-requests`, signature_request_routes_1.default);
    app.use(`${prefix}/logistics`, logistics_routes_1.default);
    app.use(`${prefix}/maintenance`, maintenance_routes_1.default);
    app.use(`${prefix}/regie`, regie_routes_1.default);
    app.use(`${prefix}/notifications`, notification_routes_1.default);
    app.use(`${prefix}/meetings`, meeting_routes_1.default);
    app.use(`${prefix}/crm`, crm_routes_1.default);
    app.use(`${prefix}/crm`, crmTask_routes_1.default);
    // Aktivitaeten: die Zeitleiste des Hauses (eigener Router, /crm-Pfad).
    app.use(`${prefix}/crm`, crmActivity_routes_1.default);
    // Anfragen (10.09.2026): der Kontakt VOR dem Kunden. Das oeffentliche
    // Formular haengt bewusst woanders — /public/enquiry ist der EINZIGE
    // unangemeldete Weg des Moduls und steht darum sichtbar fuer sich.
    app.use(`${prefix}/enquiries`, enquiry_routes_1.default);
    app.use(`${prefix}/public/enquiry`, enquiry_routes_1.publicEnquiryRouter);
    // Checklisten / Formulare / Vorlagen (CRM-Modul, siehe forms.routes.ts).
    app.use(`${prefix}/forms`, forms_routes_1.default);
    app.use(`${prefix}/settings`, settingsGate_routes_1.default);
    app.use(`${prefix}/settings/reminder-settings`, reminderSettings_routes_1.default);
    app.use(`${prefix}/settings/units`, measurementUnit_routes_1.default);
    app.use(`${prefix}/calendar/labels`, calendarLabel_routes_1.default);
    app.use(`${prefix}/fx`, fx_routes_1.default);
    app.use(`${prefix}/osp`, osp_routes_1.default);
    app.use(`${prefix}/files`, files_routes_1.default);
    app.use(`${prefix}/dashboard`, dashboard_routes_1.default);
}
app.use(ErrorHandlerMiddleware_1.globalErrorHandler);
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`API Docs  -> http://localhost:${PORT}/api-docs`);
    console.log(`API Docs  -> http://localhost:${PORT}/backend/api-docs`);
    (0, MaintenanceReminderService_1.startMaintenanceReminderService)();
    (0, ReminderEngine_1.startReminderEngine)();
    (0, ImapCaptureService_1.startImapCaptureService)();
    // Der Kalender des Kontos (CalDAV) hat seinen eigenen Zeitplan: er
    // liest keine Lesestände fort, sondern jedes Mal den ganzen Zeitraum,
    // und darf deshalb seltener und unabhängig laufen.
    (0, caldavCalendarService_1.startCaldavCaptureService)();
    // Open the remote-DB connection pool now instead of on the first request,
    // which otherwise pays the connection handshakes itself. Several parallel
    // probes force several pool connections open: batch saves fire their
    // guarded statements concurrently and each needs its own connection.
    Promise.all(Array.from({ length: 4 }, () => prisma_client_1.default.$queryRaw `SELECT 1`))
        .then(() => console.log('Database pool warmed up.'))
        .catch((error) => console.error('Database warm-up failed:', error));
});
//# sourceMappingURL=main.js.map