import { Router } from 'express';
import { nanoid } from 'nanoid';
import { requireAuth } from '../middlewares/AuthMiddleware';
import { requireAnyPermission } from '../middlewares/RbacMiddleware';
import prisma from '../../infrastructure/database/prisma.client';
import {
    MAX_INTERVAL_DAYS,
    MAX_LEAD_DAYS,
    REMINDER_ENTITY_TYPES,
    clampReminderSetting,
    type ReminderEntityType,
} from '../../shared/reminderSchedule';

/* Erinnerungs-Einstellungen (Einstellungen → Module → Verkauf → Erinnerungen):
   je Belegart GENAU EINE Einstellung — an/aus, Vorlauf (Tage vor dem
   Bezugsdatum, höchstens 30) und Wiederholung (alle N Tage). Der
   Hintergrunddienst (ReminderEngine) rechnet daraus den Fahrplan. */

const router = Router();

const ENTITY_TYPES = new Set<string>(REMINDER_ENTITY_TYPES);

const toDto = (row: { entityType: string; enabled: boolean; leadDays: number; intervalDays: number }) => ({
    entityType: row.entityType,
    enabled: row.enabled,
    leadDays: row.leadDays,
    intervalDays: row.intervalDays,
});

// GET /settings/reminder-settings — die Einstellungen des Mandanten (nur die
// gespeicherten; fehlt eine Belegart, zeigt die Oberfläche die Vorgabe).
router.get('/', requireAuth, async (req, res) => {
    try {
        const rows = await prisma.reminderSetting.findMany({
            where: { tenantId: req.user!.tenantId },
            orderBy: { entityType: 'asc' },
        });
        res.status(200).json(rows.map(toDto));
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * PUT /settings/reminder-settings — { settings: [{ entityType, enabled, leadDays, intervalDays }] }
 * Legt an oder überschreibt je Belegart; antwortet mit dem gespeicherten Stand.
 */
router.put('/', requireAuth, requireAnyPermission(['roles.manage', 'tenants.update', 'mail.manage']), async (req, res) => {
    try {
        const tenantId = req.user!.tenantId;
        const raw = Array.isArray(req.body?.settings) ? req.body.settings : [];
        const inputs: Array<{ entityType: ReminderEntityType; enabled: boolean; leadDays: number; intervalDays: number }> = [];
        for (const row of raw) {
            const entityType = String(row?.entityType || '').trim().toUpperCase();
            if (!ENTITY_TYPES.has(entityType)) return res.status(400).json({ error: 'Unbekannte Belegart.' });
            const lead = Number(row?.leadDays);
            const interval = Number(row?.intervalDays);
            if (!Number.isFinite(lead) || lead < 0 || lead > MAX_LEAD_DAYS) {
                return res.status(400).json({ error: `Vorlauf: 0 bis ${MAX_LEAD_DAYS} Tage.` });
            }
            if (!Number.isFinite(interval) || interval < 1 || interval > MAX_INTERVAL_DAYS) {
                return res.status(400).json({ error: `Wiederholung: 1 bis ${MAX_INTERVAL_DAYS} Tage.` });
            }
            inputs.push({
                entityType: entityType as ReminderEntityType,
                enabled: row?.enabled !== false,
                ...clampReminderSetting({ leadDays: lead, intervalDays: interval }),
            });
        }

        await prisma.$transaction(inputs.map((input) => prisma.reminderSetting.upsert({
            where: { tenantId_entityType: { tenantId, entityType: input.entityType } },
            update: { enabled: input.enabled, leadDays: input.leadDays, intervalDays: input.intervalDays },
            create: {
                id: nanoid(12),
                tenantId,
                entityType: input.entityType,
                enabled: input.enabled,
                leadDays: input.leadDays,
                intervalDays: input.intervalDays,
            },
        })));

        const saved = await prisma.reminderSetting.findMany({ where: { tenantId }, orderBy: { entityType: 'asc' } });
        res.status(200).json(saved.map(toDto));
    } catch (error: any) {
        res.status(400).json({ error: error.message });
    }
});

export default router;
