"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const ResponseCacheMiddleware_1 = require("../middlewares/ResponseCacheMiddleware");
const SystemAdminMiddleware_1 = require("../middlewares/SystemAdminMiddleware");
const ProductionController_1 = require("../controllers/ProductionController");
const ProductionTaskController_1 = require("../controllers/ProductionTaskController");
/**
 * ── /production — GÖREVLENDİRME (26.09.2026, Vorgabe Samet) ────────────────
 *
 *   GET    /task-templates                  Vorlagen der Firma (beim ersten Mal + Beispiel «Chiller»)
 *   POST   /task-templates                  neue Vorlage                        [Administratorrolle]
 *   GET    /task-templates/:id              Vorlage mit Aufgaben und Personen
 *   PUT    /task-templates/:id              Vorlage ersetzen (Name, Anteile, Aufgaben) [Administratorrolle]
 *   DELETE /task-templates/:id              Vorlage löschen (Geräte behalten ihre Kopie) [Administratorrolle]
 *   GET    /devices/:itemId/tasks           Aufgaben eines Geräts (Plan + Personen)
 *   POST   /devices/:itemId/tasks           Vorlage auf das Gerät laden { templateId, replace } [Administratorrolle]
 *   PUT    /devices/:itemId/tasks           Aufgaben des Geräts anpassen { tasks } — nur die Kopie, nie die Vorlage [Administratorrolle]
 *   PATCH  /devices/:itemId/tasks/:taskId/subtasks/:subtaskId  Personen einer Unteraufgabe { assigneeIds } [Administratorrolle]
 *                                           (29.09.2026: Personen nur an Unteraufgaben — die Aufgabe zeigt ihre Summe)
 *   PATCH  /devices/:itemId/tasks/:taskId/status  Stand { status: TODO|IN_PROGRESS|DONE }
 *                                           [wer in der Aufgabe steht — die Verwaltung nicht von Hand]
 *   PATCH  /devices/:itemId/tasks/:taskId/subtasks/:subtaskId/status  Stand einer Unteraufgabe { status }
 *                                           [wer an der Unteraufgabe steht — die Aufgabe folgt ihren Unteraufgaben]
 *   POST   /devices/:itemId/tasks/:taskId/subtasks/:subtaskId/complete  «Complete the task» { note } [Administratorrolle]
 *   POST   /devices/:itemId/tasks/:taskId/subtasks/:subtaskId/revision  «Request revision» { note } — zurück in Arbeit [Administratorrolle]
 *   POST   /devices/:itemId/tasks/:taskId/subtasks/:subtaskId/unlock    Sperre aufheben — wartet wieder auf Freigabe [Administratorrolle]
 *   POST   /devices/:itemId/tasks/:taskId/subtasks/:subtaskId/checklist Punkt der Freigabe-Checkliste { text } — aus der Prüfansicht [Administratorrolle]
 *                                           (gesperrt: Dateien und Stand ändert niemand, auch nicht die Verwaltung)
 *   POST   /devices/:itemId/tasks/:taskId/subtasks/:subtaskId/files     Datei (nur PDF, multipart `file`)
 *                                           [Administratorrolle oder wer an der Unteraufgabe steht]
 *   GET    /devices/:itemId/tasks/:taskId/subtasks/:subtaskId/files/:fileId  … lesen
 *   DELETE /devices/:itemId/tasks/:taskId/subtasks/:subtaskId/files/:fileId  … entfernen
 *   DELETE /devices/:itemId/tasks           Aufgaben vom Gerät nehmen           [Administratorrolle]
 *   POST   /devices/:itemId/stages          neue Stufe { area, name } — nur unter 100 % im Bereich [Administratorrolle]
 *   GET    /devices/:itemId/activities?area=&stage=[&page=&pageSize=&kinds=&actorId=&from=&to=]
 *                                           Verlauf einer Stufe: wer was wann tat, neueste zuerst (30.09.2026) [Administratorrolle]
 *
 * «Üretimde görevlere eğer administrator isek görevleri yükleyebiliyoruz» —
 * lesen darf, wer die Produktion sieht; schreiben nur die Administratorrolle
 * (`Role.isSystemAdmin`). Dazu die Firmenschranke des Produktionsmoduls.
 * `requireAuth` erbt der Weg vom Produktionsrouter.
 */
const router = (0, express_1.Router)();
const controller = new ProductionTaskController_1.ProductionTaskController();
const VIEW = (0, RbacMiddleware_1.requirePermission)('production.view');
const MODULE = ProductionController_1.ProductionController.requireModule;
const ADMIN = SystemAdminMiddleware_1.requireSystemAdmin;
const cache = (0, ResponseCacheMiddleware_1.responseCache)({ namespaces: ['production'], ttlSec: 20 });
/** Dateien an Unteraufgaben: eine je Anfrage, höchstens 25 MB. */
const subtaskUpload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
/**
 * @swagger
 * /production/task-templates:
 *   get:
 *     tags: [Production]
 *     summary: "Görevlendirme: Vorlagen der Firma (beim ersten Öffnen mit dem Beispiel Chiller)"
 *     security:
 *       - bearerAuth: []
 *   post:
 *     tags: [Production]
 *     summary: "Görevlendirme: neue Vorlage (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 */
// Die Liste legt beim allerersten Öffnen das Beispiel an — darum ohne Speicher.
router.get('/task-templates', VIEW, MODULE, (req, res, next) => controller.listTemplates(req, res, next));
router.post('/task-templates', VIEW, MODULE, ADMIN, (req, res, next) => controller.createTemplate(req, res, next));
/**
 * @swagger
 * /production/task-templates/{id}:
 *   get:
 *     tags: [Production]
 *     summary: "Görevlendirme: eine Vorlage mit Aufgaben, Personen und Prüfung der Summen"
 *     security:
 *       - bearerAuth: []
 *   put:
 *     tags: [Production]
 *     summary: "Görevlendirme: Vorlage ersetzen (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Production]
 *     summary: "Görevlendirme: Vorlage löschen (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/task-templates/:id', VIEW, MODULE, cache, (req, res, next) => controller.getTemplate(req, res, next));
router.put('/task-templates/:id', VIEW, MODULE, ADMIN, (req, res, next) => controller.updateTemplate(req, res, next));
router.delete('/task-templates/:id', VIEW, MODULE, ADMIN, (req, res, next) => controller.deleteTemplate(req, res, next));
/**
 * @swagger
 * /production/devices/{itemId}/tasks:
 *   get:
 *     tags: [Production]
 *     summary: "Görevlendirme: Aufgaben eines Geräts mit ihren Personen"
 *     security:
 *       - bearerAuth: []
 *   post:
 *     tags: [Production]
 *     summary: "Görevlendirme: Vorlage auf das Gerät laden (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 *   put:
 *     tags: [Production]
 *     summary: "Görevlendirme: Aufgaben des Geräts anpassen — die Vorlage bleibt unverändert (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Production]
 *     summary: "Görevlendirme: Aufgaben vom Gerät nehmen (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/devices/:itemId/tasks', VIEW, MODULE, cache, (req, res, next) => controller.deviceTasks(req, res, next));
router.post('/devices/:itemId/tasks', VIEW, MODULE, ADMIN, (req, res, next) => controller.loadDeviceTasks(req, res, next));
router.put('/devices/:itemId/tasks', VIEW, MODULE, ADMIN, (req, res, next) => controller.updateDeviceTasks(req, res, next));
router.delete('/devices/:itemId/tasks', VIEW, MODULE, ADMIN, (req, res, next) => controller.unloadDeviceTasks(req, res, next));
// Neue Stufe in der Kopie am Gerät — nur solange der Bereich unter 100 % wiegt (28.09.2026).
router.post('/devices/:itemId/stages', VIEW, MODULE, ADMIN, (req, res, next) => controller.addDeviceStage(req, res, next));
/**
 * @swagger
 * /production/devices/{itemId}/activities:
 *   get:
 *     tags: [Production]
 *     summary: "Görevlendirme: Verlauf einer Stufe — wer was wann tat (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 */
// Ohne Speicher: jede Handlung schreibt eine Zeile, der Verlauf zeigt sie sofort (30.09.2026).
router.get('/devices/:itemId/activities', VIEW, MODULE, ADMIN, (req, res, next) => controller.deviceActivities(req, res, next));
/**
 * ── ANFRAGEN AN DIE VERWALTUNG (30.09.2026) ─────────────────────────────────
 *   GET    /devices/:itemId/requests[?area=&stage=][&status=open|solved|all] Anfragen einer Stufe — ohne Stufe: des ganzen Geräts [Administratorrolle]
 *   GET    /task-devices                                                     Projekte und Geräte mit Aufgaben (+ offene Anfragen) [Administratorrolle]
 *   POST   /devices/:itemId/requests/:requestId/solve                        «Mark as solved» [Administratorrolle]
 *   POST   /devices/:itemId/tasks/:taskId/subtasks/:subtaskId/unlock-request Bitte um Entsperren { note } [wer an der Unteraufgabe steht]
 *   (dazu /my-tasks/…/unlock-request für die Startseite, ohne Produktionsrecht)
 *
 * @swagger
 * /production/devices/{itemId}/requests:
 *   get:
 *     tags: [Production]
 *     summary: "Görevlendirme: Anfragen einer Stufe — Freigaben und Entsperren (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 */
// Projekte und Geräte mit Aufgaben (30.09.2026) — Auswahl von Anfragen und Verlauf auf der Startseite.
router.get('/task-devices', VIEW, MODULE, ADMIN, (req, res, next) => controller.taskDevices(req, res, next));
router.get('/devices/:itemId/requests', VIEW, MODULE, ADMIN, (req, res, next) => controller.deviceRequests(req, res, next));
router.post('/devices/:itemId/requests/:requestId/solve', VIEW, MODULE, ADMIN, (req, res, next) => controller.solveDeviceRequest(req, res, next));
router.post('/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/unlock-request', VIEW, MODULE, (req, res, next) => controller.requestUnlock(req, res, next));
/**
 * @swagger
 * /production/devices/{itemId}/tasks/{taskId}/subtasks/{subtaskId}:
 *   patch:
 *     tags: [Production]
 *     summary: "Görevlendirme: Personen einer Unteraufgabe setzen (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 */
router.patch('/devices/:itemId/tasks/:taskId/subtasks/:subtaskId', VIEW, MODULE, ADMIN, (req, res, next) => controller.assignDeviceSubtask(req, res, next));
/**
 * @swagger
 * /production/devices/{itemId}/tasks/{taskId}/status:
 *   patch:
 *     tags: [Production]
 *     summary: "Görevlendirme: Stand einer Aufgabe setzen (nur wer in der Aufgabe steht)"
 *     security:
 *       - bearerAuth: []
 */
router.patch('/devices/:itemId/tasks/:taskId/status', VIEW, MODULE, (req, res, next) => controller.setDeviceTaskStatus(req, res, next));
/**
 * @swagger
 * /production/devices/{itemId}/tasks/{taskId}/subtasks/{subtaskId}/status:
 *   patch:
 *     tags: [Production]
 *     summary: "Görevlendirme: Stand einer Unteraufgabe setzen (nur wer an der Unteraufgabe steht)"
 *     security:
 *       - bearerAuth: []
 */
router.patch('/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/status', VIEW, MODULE, (req, res, next) => controller.setDeviceSubtaskStatus(req, res, next));
/**
 * @swagger
 * /production/devices/{itemId}/tasks/{taskId}/subtasks/{subtaskId}/complete:
 *   post:
 *     tags: [Production]
 *     summary: "Görevlendirme: Unteraufgabe mit Freigabe abschliessen (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 * /production/devices/{itemId}/tasks/{taskId}/subtasks/{subtaskId}/files:
 *   post:
 *     tags: [Production]
 *     summary: "Görevlendirme: Datei an eine Unteraufgabe (Administratorrolle oder wer an der Unteraufgabe steht)"
 *     security:
 *       - bearerAuth: []
 * /production/devices/{itemId}/tasks/{taskId}/subtasks/{subtaskId}/files/{fileId}:
 *   get:
 *     tags: [Production]
 *     summary: "Görevlendirme: Datei einer Unteraufgabe lesen"
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Production]
 *     summary: "Görevlendirme: Datei einer Unteraufgabe entfernen"
 *     security:
 *       - bearerAuth: []
 */
router.post('/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/complete', VIEW, MODULE, (req, res, next) => controller.completeDeviceSubtask(req, res, next));
router.post('/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/revision', VIEW, MODULE, (req, res, next) => controller.requestDeviceSubtaskRevision(req, res, next));
router.post('/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/unlock', VIEW, MODULE, (req, res, next) => controller.unlockDeviceSubtask(req, res, next));
router.post('/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/checklist', VIEW, MODULE, (req, res, next) => controller.addDeviceSubtaskChecklistItem(req, res, next));
// Die Standards der Dokumente als PDF (01.10.2026): hochladen nur die Verwaltung, lesen wer die Produktion sieht.
const standardsUpload = (0, multer_1.default)({ storage: multer_1.default.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
router.post('/task-standards', VIEW, MODULE, ADMIN, (req, res, next) => {
    standardsUpload.single('file')(req, res, (error) => {
        if (!error) {
            controller.uploadStandardsFile(req, res, next);
            return;
        }
        if (error instanceof multer_1.default.MulterError && error.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ error: 'Die Datei ist zu gross.', code: 'FILE_TOO_LARGE', params: { max: 10 } });
            return;
        }
        res.status(400).json({ error: 'Keine Datei empfangen.', code: 'FILE_REQUIRED' });
    });
});
router.get('/task-standards/file', VIEW, MODULE, (req, res, next) => controller.readStandardsFile(req, res, next));
// Die KI-Prüfung eines PDFs gegen die Standards noch einmal (01.10.2026) — nur die Verwaltung (prüft der Anwendungsfall).
router.post('/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/files/:fileId/analysis', VIEW, MODULE, (req, res, next) => controller.retryDeviceFileAnalysis(req, res, next));
router.post('/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/files', VIEW, MODULE, (req, res, next) => {
    // Zu gross oder mehr als eine Datei: dieselbe Fehlerform wie die übrigen Wege.
    subtaskUpload.single('file')(req, res, (error) => {
        if (!error) {
            controller.uploadDeviceSubtaskFile(req, res, next);
            return;
        }
        if (error instanceof multer_1.default.MulterError && error.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ error: 'Die Datei ist zu gross.', code: 'FILE_TOO_LARGE', params: { max: 25 } });
            return;
        }
        res.status(400).json({ error: 'Keine Datei empfangen.', code: 'FILE_REQUIRED' });
    });
});
router.get('/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/files/:fileId', VIEW, MODULE, (req, res, next) => controller.readDeviceSubtaskFile(req, res, next));
router.delete('/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/files/:fileId', VIEW, MODULE, (req, res, next) => controller.removeDeviceSubtaskFile(req, res, next));
/**
 * ── «GÖREVLERİM» — DIE EIGENEN AUFGABEN (30.09.2026, Vorgabe Samet) ─────────
 *
 * «On the homepage show a new section: tasks … they can start or stop a subtask, they can
 *  send subtasks to approving.» Wer an Unteraufgaben steht, hat oft KEINE Produktionsrechte
 * (keine Grundrechte für Mitarbeitende) — darum ohne `production.view`, nur mit Anmeldung
 * (vom Produktionsrouter) und eingeschaltetem Modul. Alles hier gilt nur für das Eigene:
 * die Anwendungsfälle prüfen je Unteraufgabe, dass die Person an ihr steht, und handeln
 * nie als Verwaltung.
 *
 *   GET    /my-tasks                                           je Projekt die Geräte mit den eigenen Aufgaben
 *   PATCH  /my-tasks/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/status        ▶ / ■ / zur Freigabe
 *   POST   /my-tasks/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/files         PDF hochladen (auch neue Fassung)
 *   GET    /my-tasks/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/files/:fileId lesen
 *   DELETE /my-tasks/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/files/:fileId eigene entfernen
 *
 * @swagger
 * /production/my-tasks:
 *   get:
 *     tags: [Production]
 *     summary: "Görevlendirme: die eigenen Aufgaben je Projekt und Gerät (ohne Produktionsrechte)"
 *     security:
 *       - bearerAuth: []
 */
const MY = '/my-tasks/devices/:itemId/tasks/:taskId/subtasks/:subtaskId';
router.get('/my-tasks', MODULE, (req, res, next) => controller.myTasks(req, res, next));
router.patch(`${MY}/status`, MODULE, (req, res, next) => controller.mySubtaskStatus(req, res, next));
router.post(`${MY}/files`, MODULE, (req, res, next) => {
    subtaskUpload.single('file')(req, res, (error) => {
        if (!error) {
            controller.myUploadSubtaskFile(req, res, next);
            return;
        }
        if (error instanceof multer_1.default.MulterError && error.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ error: 'Die Datei ist zu gross.', code: 'FILE_TOO_LARGE', params: { max: 25 } });
            return;
        }
        res.status(400).json({ error: 'Keine Datei empfangen.', code: 'FILE_REQUIRED' });
    });
});
router.get(`${MY}/files/:fileId`, MODULE, (req, res, next) => controller.myReadSubtaskFile(req, res, next));
// Bitte um Entsperren (30.09.2026) — wer an der Unteraufgabe steht (prüft der Anwendungsfall).
router.post(`${MY}/unlock-request`, MODULE, (req, res, next) => controller.requestUnlock(req, res, next));
router.delete(`${MY}/files/:fileId`, MODULE, (req, res, next) => controller.myRemoveSubtaskFile(req, res, next));
exports.default = router;
//# sourceMappingURL=productionTasks.routes.js.map