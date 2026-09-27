import {
    PrismaProductionDeviceTaskRepository,
    PrismaProductionTaskDirectory,
    PrismaProductionTaskTemplateRepository,
} from '../../infrastructure/repositories/ProductionTaskRepository';
import { ProductionTaskNotifier } from '../../infrastructure/services/productionTaskNotifications';
import { ProductionTaskTemplatesUseCase } from '../../application/use-cases/production/ProductionTaskTemplatesUseCase';
import { ProductionDeviceTasksUseCase } from '../../application/use-cases/production/ProductionDeviceTasksUseCase';

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
    ),
    directory,
};
