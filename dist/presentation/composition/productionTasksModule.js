"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.productionTasksModule = void 0;
const ProductionTaskRepository_1 = require("../../infrastructure/repositories/ProductionTaskRepository");
const productionTaskNotifications_1 = require("../../infrastructure/services/productionTaskNotifications");
const documentStandardsReview_1 = require("../../infrastructure/services/documentStandardsReview");
const ProductionTaskTemplatesUseCase_1 = require("../../application/use-cases/production/ProductionTaskTemplatesUseCase");
const ProductionDeviceTasksUseCase_1 = require("../../application/use-cases/production/ProductionDeviceTasksUseCase");
const path_1 = __importDefault(require("path"));
const LocalFileStorage_1 = require("../../infrastructure/services/LocalFileStorage");
/** Dateien an Unteraufgaben (28.09.2026): Platte, sobald eingerichtet R2 — wie die BOM. */
const taskFiles = new LocalFileStorage_1.DocumentStorage({
    prefix: 'local:production-task-file/',
    directory: process.env.OFFITEC_PRODUCTION_TASK_UPLOAD_DIR
        || path_1.default.join(process.cwd(), 'storage', 'production-task-files'),
});
/** Die Standards der Dokumente als PDF (01.10.2026): eigene Ablage, sonst wie die Dateien. */
const standardsFiles = new LocalFileStorage_1.DocumentStorage({
    prefix: 'local:production-task-standards/',
    directory: process.env.OFFITEC_PRODUCTION_TASK_STANDARDS_DIR
        || path_1.default.join(process.cwd(), 'storage', 'production-task-standards'),
});
/**
 * ── GÖREVLENDİRME, ZUSAMMENGESTECKT (26.09.2026) ─────────────────────────────
 * Die einzige Stelle, an der die Anwendungsfälle der Görevlendirme ihre
 * Datenbankseite bekommen (Vorlagen, Pläne der Geräte, Personen, Glocke).
 */
const templates = new ProductionTaskRepository_1.PrismaProductionTaskTemplateRepository();
const directory = new ProductionTaskRepository_1.PrismaProductionTaskDirectory();
exports.productionTasksModule = {
    templates: new ProductionTaskTemplatesUseCase_1.ProductionTaskTemplatesUseCase(templates, directory),
    devices: new ProductionDeviceTasksUseCase_1.ProductionDeviceTasksUseCase(new ProductionTaskRepository_1.PrismaProductionDeviceTaskRepository(), templates, directory, new productionTaskNotifications_1.ProductionTaskNotifier(), taskFiles, 
    // Der Verlauf je Stufe (30.09.2026).
    new ProductionTaskRepository_1.PrismaProductionTaskActivityLog(), 
    // Anfragen an die Verwaltung (30.09.2026).
    new ProductionTaskRepository_1.PrismaProductionTaskRequestRepository(), 
    // Die KI-Prüfung der PDFs gegen die Standards der Dokumente (01.10.2026).
    documentStandardsReview_1.documentStandardsReviewer, standardsFiles),
    directory,
};
//# sourceMappingURL=productionTasksModule.js.map