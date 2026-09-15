import dotenv from 'dotenv';
dotenv.config();

import { assertRuntimeConfig, threadpoolAdvice, runtimeEnv, RuntimeConfigError } from './infrastructure/config/runtime';
import { apiDocsAccess } from './infrastructure/config/apiDocs';

// Eine Fehlkonfiguration ist ein Startfehler, kein stiller Sicherheitsverlust:
// `OFFITEC_ENV` entschied bisher ungeprüft darüber, ob die Sitzungskekse das
// Secure-Merkmal tragen. Ein Tippfehler schaltete es ab, ohne dass irgendwo
// eine Zeile erschien. Jetzt startet der Dienst in dem Fall gar nicht.
try {
    assertRuntimeConfig();
} catch (error) {
    if (error instanceof RuntimeConfigError) {
        console.error(`
[Konfiguration] ${error.message}
`);
        process.exit(1);
    }
    throw error;
}

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import morgan from 'morgan';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './infrastructure/config/swagger.config';
import authRoutes     from './presentation/routes/auth.routes';
import employeeRoutes from './presentation/routes/employee.routes';
import twoFactorAdminRoutes from './presentation/routes/twoFactorAdmin.routes';
// Personalmodul (Neubau 16.08.2026): ersetzt die früheren Router
// attendance.routes.ts und leave.routes.ts vollständig.
import personnelRoutes from './presentation/routes/personnel.routes';
// Personalakte, Feiertage, Urlaubsanspruch und die Arbeitszeiterfassung
// (26.08.2026) - zweiter Router auf demselben Pfad, siehe dort.
import personnelHrRoutes from './presentation/routes/personnelHr.routes';
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
import addonOrderRoutes from './presentation/routes/addon-order.routes';
import billingRoutes from './presentation/routes/billing.routes';
import notificationRoutes from './presentation/routes/notification.routes';
import meetingRoutes from './presentation/routes/meeting.routes';
import crmRoutes from './presentation/routes/crm.routes';
import crmTaskRoutes from './presentation/routes/crmTask.routes';
import enquiryRoutes, { publicEnquiryRouter } from './presentation/routes/enquiry.routes';
import crmActivityRoutes from './presentation/routes/crmActivity.routes';
import formsRoutes from './presentation/routes/forms.routes';
import settingsGateRoutes from './presentation/routes/settingsGate.routes';
import reminderSettingsRoutes from './presentation/routes/reminderSettings.routes';
// Mengeneinheiten des Lagers (Einstellungen -> Module -> Lager -> Einheiten).
import measurementUnitRoutes from './presentation/routes/measurementUnit.routes';
// Code-Einstellungen (10.09.2026): Kategorien + Nummernkreise des ERP-Codes.
import articleCodesRoutes from './presentation/routes/articleCodes.routes';
// Kalender-Etiketten (Kalender -> Leiste "Etiketten").
import calendarLabelRoutes from './presentation/routes/calendarLabel.routes';
import authorizationRoutes from './presentation/routes/authorization.routes';
// Rollenvorlagen (Einstellungen → Berechtigungen) und der Kennwortwunsch aus
// dem eigenen Profil — beide neu am 17.08.2026.
import roleTemplateRoutes from './presentation/routes/roleTemplate.routes';
import passwordRequestRoutes from './presentation/routes/passwordRequest.routes';
import fxRoutes from './presentation/routes/fx.routes';
// OSP-Integration (Offitec Selection Platform): Webhook, Belegliste der
// OSP-Seite, Statusmeldung zurück und der Offerten-Import (04.09.2026).
import ospRoutes from './presentation/routes/osp.routes';
import filesRoutes from './presentation/routes/files.routes';
import dashboardRoutes from './presentation/routes/dashboard.routes';
// Mehrere Lesewege in einem Rundlauf (14.09.2026) — Kopfzeilen-Zähler und
// Projektliste zahlen die Strecke Browser↔Rechner einmal statt viermal.
import batchRoutes from './presentation/routes/batch.routes';
// Görevler (13.09.2026): eigenständiges Aufgabenmodul nach dem Vorbild Görevly —
// Aufgaben, Checklisten, Zeitmessung, Chat, Berichte (routes/tasks/index.ts).
import tasksModuleRoutes from './presentation/routes/tasks';
// Zeitmessung nach Zeitstempeln (14.09.2026): wiederverwendbarer Zähler je
// Person und Gegenstand — der Server rechnet, der Browser zeigt (services/timers).
import serverTimerRoutes from './presentation/routes/serverTimer.routes';
import { startTasksReminderEngine } from './infrastructure/services/tasks/tasksReminderEngine';
import { startMaintenanceReminderService } from './infrastructure/services/MaintenanceReminderService';
import { startReminderEngine } from './infrastructure/services/ReminderEngine';
import { startImapCaptureService } from './infrastructure/services/ImapCaptureService';
import { startRefreshSessionCleanup } from './infrastructure/services/RefreshSessionService';
import { startCaldavCaptureService } from './infrastructure/services/caldavCalendarService';
import { globalErrorHandler } from './presentation/middlewares/ErrorHandlerMiddleware';
import { redactPublicTokens } from './presentation/utils/logRedaction';
import { bcryptGateStats } from './application/services/bcryptGate';
// Nur für die API-Dokumentation: im Produktivbetrieb ist sie anmeldepflichtig.
import { requireAuth } from './presentation/middlewares/AuthMiddleware';
import prisma from './infrastructure/database/prisma.client';
// Lesespeicher (Redis, sonst im Vorgang) — Schreibanfragen machen ihn ungültig (14.09.2026).
import { invalidateCachesOnWrite } from './presentation/middlewares/ResponseCacheMiddleware';


const app  = express();
const PORT = process.env.PORT || 3000;
const apiPrefixes = ['/api/v1', '/backend/api/v1'];
const swaggerUiOptions = {
    customSiteTitle: 'OFFITEC CONTROL CENTER API Docs',
    swaggerOptions: {
        persistAuthorization: true,
        docExpansion: 'list',
    },
};
/**
 * ── DIE API-DOKUMENTATION IST KEINE ÖFFENTLICHE SEITE ───────────────────────
 *
 * Hier stand:
 *
 *     res.removeHeader('Content-Security-Policy');
 *
 * und die beiden Wege `/api-docs` und `/swagger.json` hingen ohne jede
 * Anmeldung am Produktivrechner. Damit lag das vollständige Verzeichnis aller
 * Endpunkte samt Feldern offen — für einen Angreifer die Landkarte, die er
 * sich sonst mühsam zusammensuchen müsste —, und auf genau diesen Wegen war
 * zusätzlich die Inhaltsrichtlinie abgeschaltet.
 *
 * Zwei getrennte Entscheidungen, beide umgedreht:
 *
 *  • WER: im Produktivbetrieb ist die Dokumentation AUS, es sei denn
 *    `OFFITEC_API_DOCS=on` — und dann nur für Angemeldete. Ausserhalb des
 *    Produktivbetriebs bleibt sie offen (`OFFITEC_API_DOCS=off` schaltet sie
 *    auch dort ab). Fehlt die Variable auf dem Server, ist der Weg zu.
 *
 *  • WAS: die Richtlinie wird nicht mehr entfernt, sondern für diese Wege
 *    passend gesetzt. Swagger-UI 5 liefert seinen Startcode als eigene Datei
 *    (`swagger-ui-init.js`) statt eingebettet — `script-src 'self'` genügt
 *    also. Eingebettet ist nur noch ein `<style>`-Block.
 */
const SWAGGER_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
].join('; ');

const apiDocs = apiDocsAccess(runtimeEnv(), process.env.OFFITEC_API_DOCS);

const swaggerCsp = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader('Content-Security-Policy', SWAGGER_CSP);
    next();
};

/** Abgeschaltet heisst: es gibt den Weg nicht. Kein Hinweis, dass es ihn gäbe. */
const apiDocsGate = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!apiDocs.enabled) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    next();
};

/** Im Produktivbetrieb zusätzlich: nur mit gültiger Sitzung. */
const apiDocsGuards: express.RequestHandler[] = apiDocs.requireLogin
    ? [apiDocsGate, requireAuth, swaggerCsp]
    : [apiDocsGate, swaggerCsp];

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
// Öffentliche Schlüssel, die noch im Pfad stehen (alte Verweise), werden vor
// dem Schreiben geschwärzt — siehe utils/logRedaction.ts.
morgan.token('safe-url', (req) => redactPublicTokens(
    (req as express.Request).originalUrl || (req as { url?: string }).url || '',
));

app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] :response-time ms'));
// 15 MB is the global upload/body ceiling (mirrors MAX_UPLOAD_BYTES).
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ limit: '15mb', extended: true }));

app.use(apiPrefixes, (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});
app.use(apiPrefixes, invalidateCachesOnWrite);


app.use('/api-docs', ...apiDocsGuards, swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));
app.use('/backend/api-docs', ...apiDocsGuards, swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));

app.get(['/swagger.json', '/backend/swagger.json'], ...apiDocsGuards, (_req, res) => {
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
    // Einstellungen → Zwei-Faktor (Aegis): Stand ansehen, Einrichtung neu starten.
    app.use(`${prefix}/security/two-factor`, twoFactorAdminRoutes);
    // Personalmodul: Liste, Stempeluhr, Schichtplan, Berichte, Anträge.
    app.use(`${prefix}/personnel`, personnelRoutes);
    // Personalakte (Profil, Unterlagen, Urlaubskonto), Feiertage und die
    // Arbeitszeiterfassung. Eigener Router, dieselbe Adresse: seine Wege sind
    // anders benannt und kollidieren nicht mit denen davor.
    app.use(`${prefix}/personnel`, personnelHrRoutes);
    app.use(`${prefix}/tenants`, tenantRoutes);
    app.use(`${prefix}/customers`, customerRoutes);
    app.use(`${prefix}/sales-orders`, salesOrderRoutes);
    // Nachträge (NT-…): Liste, Beleg, freier Nachtrag mit eigenen Positionen.
    app.use(`${prefix}/addon-orders`, addonOrderRoutes);
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
    // Aktivitaeten: die Zeitleiste des Hauses (eigener Router, /crm-Pfad).
    app.use(`${prefix}/crm`, crmActivityRoutes);
    // Anfragen (10.09.2026): der Kontakt VOR dem Kunden. Das oeffentliche
    // Formular haengt bewusst woanders — /public/enquiry ist der EINZIGE
    // unangemeldete Weg des Moduls und steht darum sichtbar fuer sich.
    app.use(`${prefix}/enquiries`, enquiryRoutes);
    app.use(`${prefix}/public/enquiry`, publicEnquiryRouter);
    // Checklisten / Formulare / Vorlagen (CRM-Modul, siehe forms.routes.ts).
    app.use(`${prefix}/forms`, formsRoutes);
    app.use(`${prefix}/settings`, settingsGateRoutes);
    app.use(`${prefix}/settings/reminder-settings`, reminderSettingsRoutes);
    app.use(`${prefix}/settings/units`, measurementUnitRoutes);
    app.use(`${prefix}/settings/article-codes`, articleCodesRoutes);
    app.use(`${prefix}/calendar/labels`, calendarLabelRoutes);
    app.use(`${prefix}/fx`, fxRoutes);
    app.use(`${prefix}/osp`, ospRoutes);
    app.use(`${prefix}/files`, filesRoutes);
    app.use(`${prefix}/dashboard`, dashboardRoutes);
    // Görevler-Modul — nicht zu verwechseln mit /crm/tasks (CRM-Aufgaben).
    app.use(`${prefix}/tasks`, tasksModuleRoutes);
    // Zähler nach Zeitstempeln: GET/POST /timers/:subjectType/:subjectId[/start|pause|resume|stop|reset].
    app.use(`${prefix}/timers`, serverTimerRoutes);
    app.use(`${prefix}/batch`, batchRoutes);
}

app.use(globalErrorHandler);

const server = app.listen(PORT, () => {
    // /batch schickt seine Teilwege an genau diese Adresse (Port oder Socket).
    app.locals.listenAddress = server.address();
    console.log(`Server running on http://localhost:${PORT}`);
    const pool = threadpoolAdvice();
    console.log(`Threadpool  -> ${pool.effective} Plaetze, hoechstens ${bcryptGateStats().globalLimit} gleichzeitige bcrypt-Aufgaben`);
    if (pool.shouldRaise) {
        // Aus dem Code heraus nicht zu aendern (Node liest die Variable beim
        // Hochfahren) — deshalb hier der genaue Handgriff fuer den Betrieb.
        console.warn(
            `[Threadpool] Nur ${pool.effective} Plaetze. bcrypt, Dateizugriffe und die Bildverkleinerung ` +
            `teilen sie sich. Empfohlen: UV_THREADPOOL_SIZE=${pool.recommended} in der UMGEBUNG des Dienstes ` +
            `setzen (in der .env wirkt es nicht - sie wird erst im Vorgang gelesen).`,
        );
    }
    console.log(`API Docs  -> http://localhost:${PORT}/api-docs`);
    console.log(`API Docs  -> http://localhost:${PORT}/backend/api-docs`);
    startMaintenanceReminderService();
    startReminderEngine();
    // Görevler: Erinnerung, «Termin naht», «überfällig», Checklisten-Erinnerung —
    // je Person und Termin genau einmal (TaskNotifyDispatch).
    startTasksReminderEngine();
    startImapCaptureService();
    // Abgelaufene Anmeldezeilen abräumen (entwertete bleiben bis zum Ablauf
    // stehen — nur so ist ein wiedereingespieltes Token erkennbar).
    startRefreshSessionCleanup();
    // Der Kalender des Kontos (CalDAV) hat seinen eigenen Zeitplan: er
    // liest keine Lesestände fort, sondern jedes Mal den ganzen Zeitraum,
    // und darf deshalb seltener und unabhängig laufen.
    startCaldavCaptureService();
    // Open the remote-DB connection pool now instead of on the first request,
    // which otherwise pays the connection handshakes itself. Several parallel
    // probes force several pool connections open: batch saves fire their
    // guarded statements concurrently and each needs its own connection.
    Promise.all(Array.from({ length: 4 }, () => prisma.$queryRaw`SELECT 1`))
        .then(() => console.log('Database pool warmed up.'))
        .catch((error) => console.error('Database warm-up failed:', error));
});
