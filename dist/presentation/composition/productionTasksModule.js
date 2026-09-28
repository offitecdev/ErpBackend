"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.productionTasksModule = void 0;
const ProductionTaskRepository_1 = require("../../infrastructure/repositories/ProductionTaskRepository");
const productionTaskNotifications_1 = require("../../infrastructure/services/productionTaskNotifications");
const ProductionTaskTemplatesUseCase_1 = require("../../application/use-cases/production/ProductionTaskTemplatesUseCase");
const ProductionDeviceTasksUseCase_1 = require("../../application/use-cases/production/ProductionDeviceTasksUseCase");
/**
 * ── GÖREVLENDİRME, ZUSAMMENGESTECKT (26.09.2026) ─────────────────────────────
 * Die einzige Stelle, an der die Anwendungsfälle der Görevlendirme ihre
 * Datenbankseite bekommen (Vorlagen, Pläne der Geräte, Personen, Glocke).
 */
const templates = new ProductionTaskRepository_1.PrismaProductionTaskTemplateRepository();
const directory = new ProductionTaskRepository_1.PrismaProductionTaskDirectory();
exports.productionTasksModule = {
    templates: new ProductionTaskTemplatesUseCase_1.ProductionTaskTemplatesUseCase(templates, directory),
    devices: new ProductionDeviceTasksUseCase_1.ProductionDeviceTasksUseCase(new ProductionTaskRepository_1.PrismaProductionDeviceTaskRepository(), templates, directory, new productionTaskNotifications_1.ProductionTaskNotifier()),
    directory,
};
//# sourceMappingURL=productionTasksModule.js.map