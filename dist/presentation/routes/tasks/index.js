"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const AuthMiddleware_1 = require("../../middlewares/AuthMiddleware");
const taskActor_1 = require("../../../application/services/tasks/taskActor");
const taskHttp_1 = require("./taskHttp");
const taskMiddleware_1 = require("./taskMiddleware");
const attachments_routes_1 = __importDefault(require("./attachments.routes"));
const chat_routes_1 = __importDefault(require("./chat.routes"));
const comments_routes_1 = __importDefault(require("./comments.routes"));
const content_routes_1 = __importDefault(require("./content.routes"));
const labels_routes_1 = __importDefault(require("./labels.routes"));
const live_routes_1 = __importDefault(require("./live.routes"));
const people_routes_1 = __importDefault(require("./people.routes"));
const reports_routes_1 = __importDefault(require("./reports.routes"));
const settings_routes_1 = __importDefault(require("./settings.routes"));
const tasks_routes_1 = __importDefault(require("./tasks.routes"));
/**
 * ── GÖREVLER / TASKS-MODUL: API (13.09.2026, Vorgabe Samet) ─────────────────
 *
 * «ayrı bir görev modülü istiyorum»: ein eigenständiges Aufgabenmodul nach dem
 * Vorbild Görevly, gemountet unter /api/v1/tasks — ohne Verbindung zu
 * Projekten, CRM-Aufgaben (/crm/tasks) oder Wartungsaufgaben.
 *
 * Vor JEDEM Weg: Anmeldung, Modul für die ausgewählte Firma freigeschaltet,
 * Recht tasks.view / tasks.manage / tasks.delete (oder Administratorrolle).
 * Leitung = tasks.manage, Teammitglied = nur tasks.view.
 *
 * Reihenfolge der Router ist Absicht: Wege mit festem ersten Abschnitt
 * (/labels, /people, /reports, /settings, /chat) vor den Routern, die
 * `/:taskId…` kennen; innerhalb eines Routers stehen feste Wege vor Parametern.
 *
 *   /labels                       Etiketten der Firma
 *   /live                         «Canlı»: wer heute woran arbeitet (ersetzt die Kanban-Pano)
 *   /people                       Personalverzeichnis des Moduls, «Kişiler»
 *   /reports                      Team-, Personen-, eigener und Aufgabenbericht (PDF-Daten)
 *   /settings/me                  persönliche Einstellungen
 *   /chat                         Räume, Mitglieder, Nachrichten, Lesestand
 *   /attachments/:id[/content]    Dateien ausliefern / löschen; /:taskId/attachments
 *   /comments/:id; /:taskId/comments
 *   /checklists…, /checklist-items…; /:taskId/content, /:taskId/checklists
 *   /bootstrap, /summary, /approvals, /timer/…, / und /:taskId…  (Aufgaben)
 */
const router = (0, express_1.Router)();
/* Ein <img>/<a href> kann keinen X-Tenant-Id-Kopf senden — Dateien einer
   ausgewählten Zweitfirma kämen sonst als 404 zurück. Für LESENDE Wege darf
   die Firma darum als `?tenantId=` mitreisen; requireAuth prüft sie genauso
   streng wie den Kopf (resolveTenantId). */
const tenantFromQuery = (req, _res, next) => {
    const fromQuery = req.query.tenantId;
    if (req.method === 'GET' && !req.header('x-tenant-id') && typeof fromQuery === 'string' && fromQuery) {
        req.headers['x-tenant-id'] = fromQuery.slice(0, 64);
    }
    next();
};
router.use(tenantFromQuery, AuthMiddleware_1.requireAuth, taskMiddleware_1.requireTasksAccess);
/* Canlı und Raporlar: nur die Administratorrolle (alle anderen haben nur Görevler + Sohbet). */
const adminGate = (_req, res, next) => {
    try {
        (0, taskActor_1.assertSystemAdmin)((0, taskMiddleware_1.tasksActor)(res));
        next();
    }
    catch (error) {
        (0, taskHttp_1.sendTaskError)(res, error, 'tasks.adminOnly');
    }
};
router.use('/labels', labels_routes_1.default);
router.use('/live', adminGate, live_routes_1.default);
router.use('/people', people_routes_1.default);
router.use('/reports', adminGate, reports_routes_1.default);
router.use('/settings', settings_routes_1.default);
router.use('/chat', chat_routes_1.default);
router.use('/', attachments_routes_1.default);
router.use('/', comments_routes_1.default);
router.use('/', content_routes_1.default);
router.use('/', tasks_routes_1.default);
exports.default = router;
//# sourceMappingURL=index.js.map