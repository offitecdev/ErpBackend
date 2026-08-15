"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const nanoid_1 = require("nanoid");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const prisma_client_1 = __importDefault(require("../../infrastructure/database/prisma.client"));
const reminderSchedule_1 = require("../../shared/reminderSchedule");
/* Erinnerungs-Einstellungen (Einstellungen → Module → Verkauf → Erinnerungen):
   je Belegart GENAU EINE Einstellung — an/aus, Vorlauf (Tage vor dem
   Bezugsdatum, höchstens 30) und Wiederholung (alle N Tage). Der
   Hintergrunddienst (ReminderEngine) rechnet daraus den Fahrplan. */
const router = (0, express_1.Router)();
const ENTITY_TYPES = new Set(reminderSchedule_1.REMINDER_ENTITY_TYPES);
const toDto = (row) => ({
    entityType: row.entityType,
    enabled: row.enabled,
    leadDays: row.leadDays,
    intervalDays: row.intervalDays,
});
// GET /settings/reminder-settings — die Einstellungen des Mandanten (nur die
// gespeicherten; fehlt eine Belegart, zeigt die Oberfläche die Vorgabe).
router.get('/', AuthMiddleware_1.requireAuth, async (req, res) => {
    try {
        const rows = await prisma_client_1.default.reminderSetting.findMany({
            where: { tenantId: req.user.tenantId },
            orderBy: { entityType: 'asc' },
        });
        res.status(200).json(rows.map(toDto));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
/**
 * PUT /settings/reminder-settings — { settings: [{ entityType, enabled, leadDays, intervalDays }] }
 * Legt an oder überschreibt je Belegart; antwortet mit dem gespeicherten Stand.
 */
router.put('/', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requireAnyPermission)(['roles.manage', 'tenants.update', 'mail.manage']), async (req, res) => {
    try {
        const tenantId = req.user.tenantId;
        const raw = Array.isArray(req.body?.settings) ? req.body.settings : [];
        const inputs = [];
        for (const row of raw) {
            const entityType = String(row?.entityType || '').trim().toUpperCase();
            if (!ENTITY_TYPES.has(entityType))
                return res.status(400).json({ error: 'Unbekannte Belegart.' });
            const lead = Number(row?.leadDays);
            const interval = Number(row?.intervalDays);
            if (!Number.isFinite(lead) || lead < 0 || lead > reminderSchedule_1.MAX_LEAD_DAYS) {
                return res.status(400).json({ error: `Vorlauf: 0 bis ${reminderSchedule_1.MAX_LEAD_DAYS} Tage.` });
            }
            if (!Number.isFinite(interval) || interval < 1 || interval > reminderSchedule_1.MAX_INTERVAL_DAYS) {
                return res.status(400).json({ error: `Wiederholung: 1 bis ${reminderSchedule_1.MAX_INTERVAL_DAYS} Tage.` });
            }
            inputs.push({
                entityType: entityType,
                enabled: row?.enabled !== false,
                ...(0, reminderSchedule_1.clampReminderSetting)({ leadDays: lead, intervalDays: interval }),
            });
        }
        await prisma_client_1.default.$transaction(inputs.map((input) => prisma_client_1.default.reminderSetting.upsert({
            where: { tenantId_entityType: { tenantId, entityType: input.entityType } },
            update: { enabled: input.enabled, leadDays: input.leadDays, intervalDays: input.intervalDays },
            create: {
                id: (0, nanoid_1.nanoid)(12),
                tenantId,
                entityType: input.entityType,
                enabled: input.enabled,
                leadDays: input.leadDays,
                intervalDays: input.intervalDays,
            },
        })));
        const saved = await prisma_client_1.default.reminderSetting.findMany({ where: { tenantId }, orderBy: { entityType: 'asc' } });
        res.status(200).json(saved.map(toDto));
    }
    catch (error) {
        res.status(400).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=reminderSettings.routes.js.map