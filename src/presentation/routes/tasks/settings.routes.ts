import { Router } from 'express';
import { z } from 'zod';

import { getMyTaskSettings, saveMyTaskSettings } from '../../../application/services/tasks/settingsService';
import { REMINDER_LEAD_MINUTES } from '../../../application/services/tasks/taskConstants';
import { parseInput, taskRoute } from './taskHttp';
import { tasksActor } from './taskMiddleware';
import { responseCache } from '../../middlewares/ResponseCacheMiddleware';

/* PERSÖNLICHE EINSTELLUNGEN, montiert unter /api/v1/tasks/settings — heute nur
   der Vorlauf für «Termin naht» (10 | 30 | 60 | 120 Minuten). */

const router = Router();

const settingsBody = z.object({
    reminderLeadMinutes: z.number().int().refine(
        (value): value is typeof REMINDER_LEAD_MINUTES[number] => (REMINDER_LEAD_MINUTES as readonly number[]).includes(value),
        { message: `Erlaubt: ${REMINDER_LEAD_MINUTES.join(', ')}` },
    ),
});

router.get('/me', responseCache({ namespaces: ['tasks'], ttlSec: 60 }), taskRoute('tasks.settings.get', async (_req, res) => {
    res.json({ settings: await getMyTaskSettings(tasksActor(res)) });
}));

router.put('/me', taskRoute('tasks.settings.save', async (req, res) => {
    const body = parseInput(settingsBody, req.body);
    const settings = await saveMyTaskSettings(tasksActor(res), {
        reminderLeadMinutes: body.reminderLeadMinutes as typeof REMINDER_LEAD_MINUTES[number],
    });
    res.json({ settings });
}));

export default router;
