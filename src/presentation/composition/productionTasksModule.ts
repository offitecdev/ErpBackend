import {
    PrismaProductionDeviceTaskRepository,
    PrismaProductionTaskActivityLog,
    PrismaProductionTaskDirectory,
    PrismaProductionTaskRequestRepository,
    PrismaProductionTaskTemplateRepository,
} from '../../infrastructure/repositories/ProductionTaskRepository';
import { ProductionTaskNotifier } from '../../infrastructure/services/productionTaskNotifications';
import { ProductionTaskTemplatesUseCase } from '../../application/use-cases/production/ProductionTaskTemplatesUseCase';
import { ProductionDeviceTasksUseCase } from '../../application/use-cases/production/ProductionDeviceTasksUseCase';
import path from 'path';
import { DocumentStorage } from '../../infrastructure/services/LocalFileStorage';

/** Dateien an Unteraufgaben (28.09.2026): Platte, sobald eingerichtet R2 — wie die BOM. */
const taskFiles = new DocumentStorage({
    prefix: 'local:production-task-file/',
    directory: process.env.OFFITEC_PRODUCTION_TASK_UPLOAD_DIR
        || path.join(process.cwd(), 'storage', 'production-task-files'),
});

/**
 * ── GÖREVLENDİRME, ZUSAMMENGESTECKT (26.09.2026) ─────────────────────────────
 * Die einzige Stelle, an der die Anwendungsfälle der Görevlendirme ihre
 * Datenbankseite bekommen (Vorlagen, Pläne der Geräte, Personen, Glocke).
 */
const templates = new PrismaProductionTaskTemplateRepository();
const directory = new PrismaProductionTaskDirectory();

export const productionTasksModule = {
    templates: new ProductionTaskTemplatesUseCase(templates, directory),
    devices: new ProductionDeviceTasksUseCase(
        new PrismaProductionDeviceTaskRepository(),
        templates,
        directory,
        new ProductionTaskNotifier(),
        taskFiles,
        // Der Verlauf je Stufe (30.09.2026).
        new PrismaProductionTaskActivityLog(),
        // Anfragen an die Verwaltung (30.09.2026).
        new PrismaProductionTaskRequestRepository(),
    ),
    directory,
};
