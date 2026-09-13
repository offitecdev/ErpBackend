import { Router } from 'express';

import { getLiveOverview } from '../../../application/services/tasks/liveService';
import { taskRoute } from './taskHttp';
import { tasksActor } from './taskMiddleware';

/* CANLI, montiert unter /api/v1/tasks/live.
     GET /   wer heute woran arbeitet — Leitung: alle Personen des Moduls,
             Teammitglied: nur sich selbst. Tagesgrenzen über `from`/`to` (ISO). */

const router = Router();

router.get('/', taskRoute('tasks.live', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await getLiveOverview(tasksActor(res), req.query as Record<string, unknown>));
}));

export default router;
