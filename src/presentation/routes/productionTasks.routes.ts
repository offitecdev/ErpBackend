import { Router } from 'express';
import multer from 'multer';

import { requirePermission } from '../middlewares/RbacMiddleware';
import { responseCache } from '../middlewares/ResponseCacheMiddleware';
import { requireSystemAdmin } from '../middlewares/SystemAdminMiddleware';
import { ProductionController } from '../controllers/ProductionController';
import { ProductionTaskController } from '../controllers/ProductionTaskController';

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
 *
 * «Üretimde görevlere eğer administrator isek görevleri yükleyebiliyoruz» —
 * lesen darf, wer die Produktion sieht; schreiben nur die Administratorrolle
 * (`Role.isSystemAdmin`). Dazu die Firmenschranke des Produktionsmoduls.
 * `requireAuth` erbt der Weg vom Produktionsrouter.
 */
const router = Router();
const controller = new ProductionTaskController();

const VIEW = requirePermission('production.view');
const MODULE = ProductionController.requireModule;
const ADMIN = requireSystemAdmin;
const cache = responseCache({ namespaces: ['production'], ttlSec: 20 });
/** Dateien an Unteraufgaben: eine je Anfrage, höchstens 25 MB. */
const subtaskUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

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
router.post('/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/files', VIEW, MODULE, (req, res, next) => {
    // Zu gross oder mehr als eine Datei: dieselbe Fehlerform wie die übrigen Wege.
    subtaskUpload.single('file')(req, res, (error: unknown) => {
        if (!error) { controller.uploadDeviceSubtaskFile(req, res, next); return; }
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ error: 'Die Datei ist zu gross.', code: 'FILE_TOO_LARGE', params: { max: 25 } });
            return;
        }
        res.status(400).json({ error: 'Keine Datei empfangen.', code: 'FILE_REQUIRED' });
    });
});
router.get('/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/files/:fileId', VIEW, MODULE, (req, res, next) => controller.readDeviceSubtaskFile(req, res, next));
router.delete('/devices/:itemId/tasks/:taskId/subtasks/:subtaskId/files/:fileId', VIEW, MODULE, (req, res, next) => controller.removeDeviceSubtaskFile(req, res, next));

export default router;
