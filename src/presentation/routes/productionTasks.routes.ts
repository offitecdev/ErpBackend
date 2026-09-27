import { Router } from 'express';

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
 *   PATCH  /devices/:itemId/tasks/:taskId   Personen einer Aufgabe { assigneeIds } [Administratorrolle]
 *   DELETE /devices/:itemId/tasks           Aufgaben vom Gerät nehmen           [Administratorrolle]
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
 *   delete:
 *     tags: [Production]
 *     summary: "Görevlendirme: Aufgaben vom Gerät nehmen (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 */
router.get('/devices/:itemId/tasks', VIEW, MODULE, cache, (req, res, next) => controller.deviceTasks(req, res, next));
router.post('/devices/:itemId/tasks', VIEW, MODULE, ADMIN, (req, res, next) => controller.loadDeviceTasks(req, res, next));
router.delete('/devices/:itemId/tasks', VIEW, MODULE, ADMIN, (req, res, next) => controller.unloadDeviceTasks(req, res, next));

/**
 * @swagger
 * /production/devices/{itemId}/tasks/{taskId}:
 *   patch:
 *     tags: [Production]
 *     summary: "Görevlendirme: Personen einer Aufgabe setzen (nur Administratorrolle)"
 *     security:
 *       - bearerAuth: []
 */
router.patch('/devices/:itemId/tasks/:taskId', VIEW, MODULE, ADMIN, (req, res, next) => controller.assignDeviceTask(req, res, next));

export default router;
